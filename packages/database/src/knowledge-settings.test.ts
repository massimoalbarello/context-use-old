import { describe, expect, test } from "bun:test";
import type { Pool } from "pg";
import { KnowledgeSettingsRepository } from "./knowledge-settings.ts";

describe("global guide lock ordering", () => {
  test("takes the target-document lock before updating settings", async () => {
    const calls: string[] = [];
    const documentId = "11111111-1111-4111-8111-111111111111";
    const query = async (sql: string) => {
      calls.push(sql);
      return sql.includes("UPDATE knowledge_settings")
        ? { rowCount: 1, rows: [{ global_guide_document_id: documentId, updated_at: new Date() }] }
        : { rowCount: 0, rows: [] };
    };
    const pool = {
      async connect() {
        return { query, release() {} };
      },
    } as unknown as Pool;

    await new KnowledgeSettingsRepository(pool).updateGlobalGuide(documentId);

    const document = calls.findIndex((sql) => sql.includes("lock_operational_document"));
    const settings = calls.findIndex((sql) => sql.includes("UPDATE knowledge_settings"));
    expect(calls.some((sql) => sql.includes("filesystem-hypermedia-corpus-transition"))).toBe(false);
    expect(document).toBeGreaterThan(-1);
    expect(settings).toBeGreaterThan(document);
  });
});
