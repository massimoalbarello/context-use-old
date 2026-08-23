import { describe, expect, test } from "bun:test";
import type { Pool } from "pg";
import { DocumentMaintenanceRepository } from "./document-maintenance.ts";

describe("published projection artifact lock ordering", () => {
  test("locks the corpus transition before inserting the legacy artifact", async () => {
    const calls: Array<{ sql: string; values: unknown[] | undefined }> = [];
    let released = false;
    const query = async (sql: string, values?: unknown[]) => {
      calls.push({ sql, values });
      return { rowCount: 1, rows: [] };
    };
    const pool = {
      async query() {
        throw new Error("recordPublishedArtifact must use one transaction client");
      },
      async connect() {
        return { query, release() { released = true; } };
      },
    } as unknown as Pool;
    const input = {
      pageId: "11111111-1111-4111-8111-111111111111",
      versionId: "22222222-2222-4222-8222-222222222222",
      generation: 3,
      artifactId: "33333333-3333-4333-8333-333333333333",
      objectKey: "documents/public/33333333-3333-4333-8333-333333333333.md",
      sizeBytes: 42,
      contentHash: "a".repeat(64),
    };

    await new DocumentMaintenanceRepository(pool).recordPublishedArtifact(input);

    expect(calls.map(({ sql }) => sql)).toEqual([
      "BEGIN",
      "SELECT pg_advisory_xact_lock_shared(hashtextextended('filesystem-hypermedia-corpus-transition',0))",
      expect.stringContaining("INSERT INTO published_page_artifacts"),
      "COMMIT",
    ]);
    expect(calls[2]?.values).toEqual([
      input.pageId,
      input.versionId,
      input.generation,
      input.artifactId,
      input.objectKey,
      input.sizeBytes,
      input.contentHash,
    ]);
    expect(released).toBe(true);
  });
});
