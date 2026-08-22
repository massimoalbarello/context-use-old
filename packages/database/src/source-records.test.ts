import { describe, expect, test } from "bun:test";
import type { Pool } from "pg";
import { markdownObjectMetadata, type MarkdownObjectStore } from "./documents.ts";
import { SourceRecordRepository } from "./source-records.ts";

describe("source record lock ordering", () => {
  test("takes the shared transition lock before connector identity and record row locks", async () => {
    const calls: string[] = [];
    const store: MarkdownObjectStore = {
      async write(revisionId, markdown) {
        return markdownObjectMetadata(revisionId, markdown);
      },
      async read() {
        throw new Error("not used");
      },
    };
    const transactionQuery = async (sql: string) => {
      calls.push(sql);
      if (sql.includes("FOR UPDATE OF source")) throw new Error("stop after lock request");
      return { rowCount: 0, rows: [] };
    };
    const pool = {
      async query() {
        return { rowCount: 0, rows: [] };
      },
      async connect() {
        return { query: transactionQuery, release() {} };
      },
    } as unknown as Pool;

    await expect(new SourceRecordRepository(pool, store).write({
      integration: "github",
      connectionInstanceId: 1,
      connectionId: "connection",
      model: "Issue",
      sourceRecordId: "42",
      action: "added",
      sourceUpdatedAt: "2026-08-22T00:00:00.000Z",
      markdown: "# Issue 42\n",
    })).rejects.toThrow("stop after lock request");

    const transition = calls.findIndex((sql) => sql.includes("pg_advisory_xact_lock_shared"));
    const identity = calls.findIndex((sql) => sql.includes("pg_advisory_xact_lock(")
      && !sql.includes("_shared"));
    const record = calls.findIndex((sql) => sql.includes("FOR UPDATE OF source"));
    expect(transition).toBeGreaterThan(-1);
    expect(identity).toBeGreaterThan(transition);
    expect(record).toBeGreaterThan(identity);
  });
});
