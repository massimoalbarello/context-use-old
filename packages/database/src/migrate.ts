import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { loadMigrationCatalog } from "./migrations/catalog.ts";
import { applyPendingMigrations, validateMigrationLedger } from "./migrations/ledger.ts";
import { configureMigrationRolePasswords } from "./migrations/role-passwords.ts";
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
const migrations = await loadMigrationCatalog({ directory: migrationsDirectory });
const targetMigrations = migrations;

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

    await validateMigrationLedger({
      client,
      migrations,
      baseline: "001_create_auth_schema.sql",
    });
    await applyPendingMigrations({
      client,
      migrations,
      onApplied: (version) => console.info(`Applied ${version}`),
    });

    if (reconcileRequested) {
      const reconciledOwnerships = await reconcilePendingRestoreOwnership(client, targetMigrations);
      console.info(`Reconciled ${reconciledOwnerships} restored routine/view ownerships`);
    }

    await configureMigrationRolePasswords({ client, environment: process.env });

    if (prepareRequested) {
      const protectedOwnerships = await prepareRestoreOwnership(client, targetMigrations);
      console.info(`Prepared ${protectedOwnerships} routine/view ownerships for restore`);
    }
  }
} finally {
  await client.end();
}
