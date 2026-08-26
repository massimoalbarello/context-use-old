import { describe, expect, test } from "bun:test";
import type { Client } from "pg";
import { applyPendingMigrations } from "./ledger.ts";

type QueryCall = {
  sql: string;
  values?: unknown[];
};

function recordingClient({ failOn }: { failOn?: string } = {}): {
  calls: QueryCall[];
  client: Client;
} {
  const calls: QueryCall[] = [];
  const client = {
    query(...[sql, values]: [string, unknown[]?]) {
      calls.push({ sql, ...(values ? { values } : {}) });
      if (sql === failOn) {
        return Promise.reject(new Error("migration failed"));
      }
      return Promise.resolve({ rowCount: sql.startsWith("SELECT 1") ? 0 : null, rows: [] });
    },
  } as unknown as Client;
  return { calls, client };
}

const migration = {
  version: "011_add_invariant.sql",
  checksum: "checksum-011",
  sql: "CREATE TABLE invariant_check(id uuid PRIMARY KEY)",
};

describe("transactional migration ledger", () => {
  test("records the checksum in the same transaction as the schema change", async () => {
    const { calls, client } = recordingClient();
    const applied: string[] = [];

    await applyPendingMigrations({
      client,
      migrations: [migration],
      onApplied: (version) => applied.push(version),
    });

    expect(calls).toEqual([
      {
        sql: "SELECT 1 FROM schema_migrations WHERE version = $1",
        values: [migration.version],
      },
      { sql: "BEGIN" },
      { sql: migration.sql },
      {
        sql: "INSERT INTO schema_migrations(version,checksum) VALUES ($1,$2)",
        values: [migration.version, migration.checksum],
      },
      { sql: "COMMIT" },
    ]);
    expect(applied).toEqual([migration.version]);
  });

  test("rolls back and does not report a failed migration as applied", async () => {
    const { calls, client } = recordingClient({ failOn: migration.sql });
    const applied: string[] = [];

    await expect(
      applyPendingMigrations({
        client,
        migrations: [migration],
        onApplied: (version) => applied.push(version),
      }),
    ).rejects.toThrow("migration failed");

    expect(calls.at(-1)).toEqual({ sql: "ROLLBACK" });
    expect(applied).toEqual([]);
  });
});
