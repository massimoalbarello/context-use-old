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
  const prepareOwnership = `${compose} --profile migration run --rm -e MIGRATOR_PREPARE_RESTORE_OWNERSHIP=true migrate`;
  const adoptRestoredSchema = `${compose} --profile migration run --rm `
    + "-e CONTEXT_USE_ADOPT_LEGACY_SCHEMA=v0.1.97 -e CONTEXT_USE_ADOPT_PENDING_RESTORE=true "
    + "migrate bun packages/database/src/run-legacy-schema-adoption.ts";
  const reconcileOwnership = `${compose} --profile migration run --rm -e MIGRATOR_RECONCILE_RESTORE_OWNERSHIP=true migrate`;
  const contractSnapshot = "CREATE TEMP TABLE context_use_restore_contract_snapshot AS SELECT context_use_deployment_internal.restore_contract_fingerprint() AS fingerprint; SELECT context_use_deployment_internal.reset_default_acls_for_restore(); ";
  const restoreDatabase = `${database} --single-transaction `
    + `-c '${contractSnapshot}CREATE TEMP TABLE context_use_restore_guard(complete boolean PRIMARY KEY); `
    + "CREATE TEMP TABLE context_use_restore_guard_required(complete boolean NOT NULL "
    + "REFERENCES context_use_restore_guard(complete) DEFERRABLE INITIALLY DEFERRED); "
    + "INSERT INTO context_use_restore_guard_required VALUES (true); "
    + "DROP SCHEMA IF EXISTS auth CASCADE; DROP SCHEMA public CASCADE; "
    + "CREATE SCHEMA public AUTHORIZATION pg_database_owner; "
    + "GRANT USAGE ON SCHEMA public TO PUBLIC' -f -";
  const retainedContractCompletion = "INSERT INTO pg_temp.context_use_restore_guard SELECT true FROM pg_temp.context_use_restore_contract_snapshot AS captured WHERE captured.fingerprint=context_use_deployment_internal.restore_contract_fingerprint();";
  const clients = "caddy private-app public-app storage";
  return [
    "set -euo pipefail",
    "cd /opt/context-use/deploy",
    "export PGPASSWORD=\"$(sed -n 's/^POSTGRES_PASSWORD=//p' /data/context-use/secrets/runtime.env)\"",
    `restore_failed() { ${compose} up -d postgres aws-credential-broker >/dev/null 2>&1 || true; }`,
    "trap restore_failed EXIT",
    `${compose} stop backup`,
    `if [ "$(${database} -tAc "SELECT pg_catalog.to_regnamespace('context_use_deployment_internal') IS NOT NULL")" = f ]; then ${compose} run --rm backup once; fi`,
    `${compose} stop ${clients}`,
    `${compose} up -d postgres aws-credential-broker`,
    prepareOwnership,
    `{ ${compose} run --rm -T -e BACKUP_BUCKET='${bucket}' backup fetch '${key}' | gunzip && `
      + `printf '%s\\n' '${retainedContractCompletion}'; `
      + `} | ${restoreDatabase}`,
    adoptRestoredSchema,
    reconcileOwnership,
    `${compose} up -d --wait storage`,
    `${compose} up --force-recreate --no-deps --abort-on-container-exit --exit-code-from hypermedia-bootstrap hypermedia-bootstrap`,
    // The one-shot succeeded above; explicit no-dependency starts keep Compose
    // from traversing back through it while restoring the long-lived services.
    `${compose} up -d --wait --no-deps public-app`,
    `${compose} up -d --wait --no-deps private-app`,
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
