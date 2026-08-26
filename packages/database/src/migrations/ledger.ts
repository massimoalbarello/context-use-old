import type { Client } from "pg";
import { assertMigrationState, type MigrationDescriptor } from "../migration-state.ts";
import type { LoadedMigration, MigrationStream } from "./catalog.ts";

export const MIGRATION_LEDGERS: Record<MigrationStream, string> = {
  auth: "auth_schema_migrations",
  application: "schema_migrations",
};

const BASELINE_RELATION_SCHEMAS: Record<MigrationStream, string[]> = {
  auth: ["auth", "public"],
  application: ["public"],
};

function qualifiedLedger(stream: MigrationStream): string {
  return `public.${MIGRATION_LEDGERS[stream]}`;
}

export async function validateMigrationLedger({
  client,
  migrations,
  baseline,
  stream,
}: {
  client: Client;
  migrations: MigrationDescriptor[];
  baseline: string;
  stream: MigrationStream;
}): Promise<void> {
  const ledger = qualifiedLedger(stream);
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${ledger} (
      version text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await client.query(`ALTER TABLE ${ledger} ADD COLUMN IF NOT EXISTS checksum text`);

  const applied = await client.query<{ version: string; checksum: string | null }>(
    `SELECT version,checksum FROM ${ledger} ORDER BY version`,
  );
  const existingRelations = await client.query<{ relation: string }>(
    `SELECT format('%I.%I',namespace.nspname,relation.relname) AS relation
     FROM pg_catalog.pg_class AS relation
     JOIN pg_catalog.pg_namespace AS namespace
       ON namespace.oid=relation.relnamespace
     WHERE namespace.nspname=ANY($1::text[])
       AND relation.relkind IN ('r','p','v','m','S')
       AND NOT (
         namespace.nspname='public'
         AND relation.relname=ANY($2::text[])
       )
     ORDER BY namespace.nspname,relation.relname`,
    [BASELINE_RELATION_SCHEMAS[stream], Object.values(MIGRATION_LEDGERS)],
  );
  assertMigrationState(
    migrations,
    applied.rows,
    existingRelations.rows.map(({ relation }) => relation),
    baseline,
  );
  await client.query(`ALTER TABLE ${ledger} ALTER COLUMN checksum SET NOT NULL`);
}

export async function applyPendingMigrations({
  client,
  migrations,
  stream,
  onApplied,
}: {
  client: Client;
  migrations: LoadedMigration[];
  stream: MigrationStream;
  onApplied?: (version: string) => void;
}): Promise<void> {
  const ledger = qualifiedLedger(stream);
  for (const migration of migrations) {
    const existing = await client.query(`SELECT 1 FROM ${ledger} WHERE version = $1`, [
      migration.version,
    ]);
    if (existing.rowCount) {
      continue;
    }

    await client.query("BEGIN");
    try {
      await client.query(migration.sql);
      await client.query(`INSERT INTO ${ledger}(version,checksum) VALUES ($1,$2)`, [
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
