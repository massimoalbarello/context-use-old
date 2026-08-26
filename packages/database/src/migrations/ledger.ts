import type { Client } from "pg";
import { assertMigrationState, type MigrationDescriptor } from "../migration-state.ts";
import type { LoadedMigration } from "./catalog.ts";

export async function validateMigrationLedger({
  client,
  migrations,
  baseline,
}: {
  client: Client;
  migrations: MigrationDescriptor[];
  baseline: string;
}): Promise<void> {
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
  const existingRelations = await client.query<{ relation: string }>(
    `SELECT format('%I.%I',namespace.nspname,relation.relname) AS relation
     FROM pg_catalog.pg_class AS relation
     JOIN pg_catalog.pg_namespace AS namespace
       ON namespace.oid=relation.relnamespace
     WHERE namespace.nspname NOT IN ('pg_catalog','information_schema')
       AND namespace.nspname NOT LIKE 'pg_toast%'
       AND namespace.nspname NOT LIKE 'pg_temp_%'
       AND relation.relkind IN ('r','p','v','m','S')
       AND NOT (
         namespace.nspname='public'
         AND relation.relname='schema_migrations'
       )
     ORDER BY namespace.nspname,relation.relname`,
  );
  assertMigrationState(
    migrations,
    applied.rows,
    existingRelations.rows.map(({ relation }) => relation),
    baseline,
  );
  await client.query("ALTER TABLE schema_migrations ALTER COLUMN checksum SET NOT NULL");
}

export async function applyPendingMigrations({
  client,
  migrations,
  onApplied,
}: {
  client: Client;
  migrations: LoadedMigration[];
  onApplied?: (version: string) => void;
}): Promise<void> {
  for (const migration of migrations) {
    const existing = await client.query("SELECT 1 FROM schema_migrations WHERE version = $1", [
      migration.version,
    ]);
    if (existing.rowCount) {
      continue;
    }

    await client.query("BEGIN");
    try {
      await client.query(migration.sql);
      await client.query("INSERT INTO schema_migrations(version,checksum) VALUES ($1,$2)", [
        migration.version,
        migration.checksum,
      ]);
      await client.query("COMMIT");
      onApplied?.(migration.version);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }
}
