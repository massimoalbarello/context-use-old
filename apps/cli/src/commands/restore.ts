import * as p from "@clack/prompts";
import { defineCommand } from "@parshjs/core";
import { listBackups, sendSsmCommands } from "../aws.ts";
import { verifyDeployment } from "../deploy.ts";
import { readInfrastructure } from "../lifecycle.ts";
import type { DataOutputs, DeploymentConfig } from "../types.ts";

export function restoreCommands(bucket: string, key: string): string[] {
  if (!/^postgres\/[0-9TZ-]+\.sql\.gz$/.test(key)) throw new Error("Invalid backup key");
  const compose = "docker compose --env-file /data/context-use/secrets/runtime.env";
  const database = `${compose} exec -T -e PGPASSWORD postgres psql -X -v ON_ERROR_STOP=1 -U postgres -d context_use`;
  const compatibilityMigrations = "-e MIGRATOR_MAX_VERSION=035_hydrate_ready_corpus_knowledge.sql -e MIGRATOR_ALLOW_APPLIED_LATER=true";
  const prepareOwnership = `${compose} --profile migration run --rm ${compatibilityMigrations} -e MIGRATOR_PREPARE_RESTORE_OWNERSHIP=true migrate`;
  const reconcileOwnership = `${compose} --profile migration run --rm ${compatibilityMigrations} -e MIGRATOR_RECONCILE_RESTORE_OWNERSHIP=true migrate`;
  const contractSnapshot = "CREATE TEMP TABLE context_use_restore_contract_snapshot AS SELECT context_use_deployment_internal.restore_contract_fingerprint() AS fingerprint; SELECT context_use_deployment_internal.reset_default_acls_for_restore(); ";
  const restoreDatabase = `${database} --single-transaction `
    + `-c '${contractSnapshot}CREATE TEMP TABLE context_use_restore_guard(complete boolean PRIMARY KEY); `
    + "CREATE TEMP TABLE context_use_restore_guard_required(complete boolean NOT NULL "
    + "REFERENCES context_use_restore_guard(complete) DEFERRABLE INITIALLY DEFERRED); "
    + "INSERT INTO context_use_restore_guard_required VALUES (true); "
    + "DROP SCHEMA public CASCADE; CREATE SCHEMA public AUTHORIZATION pg_database_owner; "
    + "GRANT USAGE ON SCHEMA public TO PUBLIC' -f -";
  // Plain historical dumps retain GRANT statements. This no-login placeholder
  // exists only while traffic is stopped and is removed after migrations.
  const compatibilityRole = "context_use_public_mcp";
  const ensureCompatibilityRole = `${database} -c "DO \\$compatibility\\$ BEGIN IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='${compatibilityRole}') THEN IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles AS role WHERE role.rolname='${compatibilityRole}' AND (role.rolsuper OR role.rolinherit OR role.rolcreaterole OR role.rolcreatedb OR role.rolcanlogin OR role.rolreplication OR role.rolbypassrls OR role.rolconfig IS NOT NULL OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members AS membership WHERE membership.roleid=role.oid OR membership.member=role.oid) OR EXISTS (SELECT 1 FROM pg_catalog.pg_shdepend AS dependency WHERE dependency.refclassid='pg_catalog.pg_authid'::pg_catalog.regclass AND dependency.refobjid=role.oid AND NOT (dependency.deptype='o' AND dependency.classid='pg_catalog.pg_default_acl'::pg_catalog.regclass AND dependency.dbid=(SELECT database.oid FROM pg_catalog.pg_database AS database WHERE database.datname=pg_catalog.current_database())) AND NOT (dependency.deptype='a' AND dependency.dbid=(SELECT database.oid FROM pg_catalog.pg_database AS database WHERE database.datname=pg_catalog.current_database()))))) THEN RAISE EXCEPTION 'Existing ${compatibilityRole} role is not an isolated NOLOGIN compatibility role'; END IF; ELSE CREATE ROLE ${compatibilityRole} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS; END IF; END \\$compatibility\\$"`;
  const retainedContractCompletion = "INSERT INTO pg_temp.context_use_restore_guard SELECT true FROM pg_temp.context_use_restore_contract_snapshot AS captured WHERE captured.fingerprint=context_use_deployment_internal.restore_contract_fingerprint();";
  const clients = "caddy dashboard-edge app auth private-mcp public-web confirmation storage";
  return [
    "set -euo pipefail",
    "cd /opt/context-use/deploy",
    "export PGPASSWORD=\"$(sed -n 's/^POSTGRES_PASSWORD=//p' /data/context-use/secrets/runtime.env)\"",
    `restore_failed() { ${database} -c 'DROP ROLE IF EXISTS ${compatibilityRole}' >/dev/null 2>&1 || true; ${compose} up -d postgres aws-credential-broker >/dev/null 2>&1 || true; }`,
    "trap restore_failed EXIT",
    `${compose} stop backup`,
    `if [ "$(${database} -tAc "SELECT pg_catalog.to_regnamespace('context_use_deployment_internal') IS NOT NULL")" = f ]; then ${compose} run --rm backup once; fi`,
    `${compose} stop ${clients}`,
    `${compose} up -d postgres aws-credential-broker`,
    prepareOwnership,
    ensureCompatibilityRole,
    `{ ${compose} run --rm -T -e BACKUP_BUCKET='${bucket}' backup fetch '${key}' | gunzip && `
      + `printf '%s\\n' '${retainedContractCompletion}'; `
      + `} | ${restoreDatabase}`,
    reconcileOwnership,
    ensureCompatibilityRole,
    `${database} -c 'DROP OWNED BY ${compatibilityRole}; DROP ROLE IF EXISTS ${compatibilityRole}'`,
    `${compose} up -d --wait storage`,
    `${compose} up --force-recreate --no-deps --abort-on-container-exit --exit-code-from knowledge-prepare knowledge-prepare`,
    `${compose} --profile migration run --rm migrate`,
    // The one-shot succeeded above; explicit no-dependency starts keep Compose
    // from traversing back through it while restoring the long-lived services.
    `${compose} up -d --wait --no-deps public-web`,
    `${compose} up -d --wait --no-deps auth confirmation`,
    `${compose} up -d --wait --no-deps app private-mcp`,
    `${compose} up -d --wait --no-deps dashboard-edge`,
    `${compose} up -d --remove-orphans --no-deps caddy backup`,
    "trap - EXIT",
  ];
}

export async function selectBackup(config: DeploymentConfig, data: DataOutputs): Promise<string> {
  const backups = await listBackups(config.awsProfile, config.awsRegion, data.backup_bucket);
  if (backups.length === 0) throw new Error("No PostgreSQL backups are available");
  const selected = await p.select({
    message: "Backup to restore",
    options: backups.slice(0, 100).map((backup) => ({
      value: backup.key,
      label: `${backup.modified} · ${(backup.size / 1_048_576).toFixed(1)} MiB`,
    })),
  });
  if (p.isCancel(selected)) throw new Error("Restore cancelled");
  if (!/^postgres\/[0-9TZ-]+\.sql\.gz$/.test(selected)) throw new Error("Invalid backup key");
  return selected;
}

export const command = defineCommand("restore", {
  description: "Restore PostgreSQL from an encrypted backup.",
  options: {},
  handler: async () => {
    const { config, manifest, data, compute } = await readInfrastructure();
    if (config.recovery) throw new Error("Volume recovery is in progress; run `context-use recover`");
    if (!compute || !data) throw new Error("No active deployment");
    const selected = await selectBackup(config, data);
    const typed = await p.text({ message: `Type ${config.hostname} to replace the live database` });
    if (p.isCancel(typed) || typed !== config.hostname) throw new Error("Confirmation did not match");
    await sendSsmCommands(config.awsProfile, config.awsRegion, compute.instance_id, restoreCommands(data.backup_bucket, selected));
    await verifyDeployment(config, manifest.version, compute.instance_id);
    p.outro(`Database restored from ${selected}`);
  },
});
