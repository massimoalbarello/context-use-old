import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { Client } from "pg";
import {
  MIGRATION_ROLE_PASSWORD_ENV,
  assertMigrationState,
  configuredExistingRolePasswords,
  migrationsThroughVersion,
} from "./migration-state.ts";
import {
  PREPARE_RESTORE_OWNERSHIP_ENV,
  RECONCILE_RESTORE_OWNERSHIP_ENV,
  prepareRestoreOwnership,
  reconcilePendingRestoreOwnership,
  restoreOwnershipContractPending,
  restoreOwnershipPhase,
  validatePendingRestoreOwnershipForRelease,
} from "./restore-ownership.ts";

const migrationUrl = process.env.MIGRATOR_DATABASE_URL ?? process.env.DATABASE_ADMIN_URL;
if (!migrationUrl) {
  throw new Error("MIGRATOR_DATABASE_URL or DATABASE_ADMIN_URL is required");
}

const restorePhase = restoreOwnershipPhase(
  process.env[PREPARE_RESTORE_OWNERSHIP_ENV],
  process.env[RECONCILE_RESTORE_OWNERSHIP_ENV],
);
const prepareRequested = restorePhase === "prepare";
const reconcileRequested = restorePhase === "reconcile";

const migrationsDirectory = join(dirname(fileURLToPath(import.meta.url)), "../migrations");
const files = (await readdir(migrationsDirectory)).filter((file) => file.endsWith(".sql")).sort();
const migrations = await Promise.all(files.map(async (version) => {
  const sql = await readFile(join(migrationsDirectory, version), "utf8");
  return {
    version,
    sql,
    checksum: createHash("sha256").update(sql).digest("hex"),
  };
}));
const targetMigrations = migrationsThroughVersion(migrations, [], process.env.MIGRATOR_MAX_VERSION);

const client = new Client({ connectionString: migrationUrl });
await client.connect();
try {
  // Serialize the complete multi-transaction migration/restore phase decision.
  // This prevents an ordinary migrator from racing a preparer and consuming or
  // mutating public state while a retained restore contract exists.
  await client.query(
    "SELECT pg_catalog.pg_advisory_lock(pg_catalog.hashtextextended('context-use:migrate',0))",
  );
  const pendingRestore = await restoreOwnershipContractPending(client);
  if (prepareRequested && pendingRestore) {
    const protectedOwnerships = await validatePendingRestoreOwnershipForRelease(client, targetMigrations);
    console.info(`Reused pending restore contract for ${protectedOwnerships} routine/view ownerships`);
  } else {
    if (reconcileRequested) {
      if (!pendingRestore) throw new Error("Restore ownership reconciliation requires a pending contract");
      // Validate the private release-bound contract before inspecting or
      // migrating the untrusted restored public schema.
      await validatePendingRestoreOwnershipForRelease(client, targetMigrations);
    } else if (pendingRestore) {
      throw new Error(
        `A restore ownership contract is pending; run with ${PREPARE_RESTORE_OWNERSHIP_ENV}=true to retry `
        + `or ${RECONCILE_RESTORE_OWNERSHIP_ENV}=true after a committed restore`,
      );
    }

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version text PRIMARY KEY,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await client.query("ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum text");

    const applied = await client.query<{ version: string; checksum: string | null }>(
      "SELECT version,checksum FROM schema_migrations ORDER BY version",
    );
    const baseline = "001_baseline.sql";
    const existingRelations = await client.query<{ relation: string }>(
      `SELECT relname AS relation
       FROM pg_class
       WHERE relnamespace='public'::regnamespace
         AND relkind IN ('r','p','v','m','S')
         AND relname<>'schema_migrations'
       ORDER BY relname`,
    );
    assertMigrationState(
      migrations,
      applied.rows,
      existingRelations.rows.map(({ relation }) => relation),
      baseline,
    );
    const migrationsToApply = migrationsThroughVersion(
      migrations,
      applied.rows,
      process.env.MIGRATOR_MAX_VERSION,
    );
    await client.query("ALTER TABLE schema_migrations ALTER COLUMN checksum SET NOT NULL");
    for (const migration of migrationsToApply) {
      const existing = await client.query("SELECT 1 FROM schema_migrations WHERE version = $1", [migration.version]);
      if (existing.rowCount) continue;
      await client.query("BEGIN");
      try {
        await client.query(migration.sql);
        await client.query(
          "INSERT INTO schema_migrations(version,checksum) VALUES ($1,$2)",
          [migration.version, migration.checksum],
        );
        await client.query("COMMIT");
        console.info(`Applied ${migration.version}`);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }

    if (reconcileRequested) {
      const reconciledOwnerships = await reconcilePendingRestoreOwnership(client, targetMigrations);
      console.info(`Reconciled ${reconciledOwnerships} restored routine/view ownerships`);
    }

    const existingPasswordRoles = await client.query<{ rolname: string }>(
      "SELECT rolname::text FROM pg_roles WHERE rolname::text=ANY($1::text[])",
      [Object.keys(MIGRATION_ROLE_PASSWORD_ENV)],
    );
    for (const { role, password } of configuredExistingRolePasswords(
      process.env,
      existingPasswordRoles.rows.map(({ rolname }) => rolname),
    )) {
      const literal = password.replaceAll("'", "''");
      await client.query(`ALTER ROLE ${role} LOGIN PASSWORD '${literal}'`);
    }

    if (prepareRequested) {
      const protectedOwnerships = await prepareRestoreOwnership(client, targetMigrations);
      console.info(`Prepared ${protectedOwnerships} routine/view ownerships for restore`);
    }
  }
} finally {
  await client.end();
}
