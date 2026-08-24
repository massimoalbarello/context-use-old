import { describe, expect, test } from "bun:test";
import type { Pool } from "pg";
import { markdownObjectMetadata, type MarkdownObjectStore } from "./documents.ts";
import { KnowledgeDocumentRepository } from "./knowledge-documents.ts";

const bodies: MarkdownObjectStore = {
  async write(revisionId, markdown) {
    return markdownObjectMetadata(revisionId, markdown);
  },
  async read() {
    return "Oldest retained body";
  },
};

function changeRow(sequence: string, documentId: string, previousRevisionNumber?: number | null) {
  return {
    change_sequence: sequence,
    document_id: documentId,
    revision_id: crypto.randomUUID(),
    revision_number: Number(sequence),
    previous_revision_number: previousRevisionNumber ?? null,
    change_kind: "updated" as const,
    title: `Document ${sequence}`,
    commit_message: `Update document ${sequence}`,
    actor_kind: "mcp" as const,
    actor_subject: "client/session",
    changed_at: new Date("2026-08-23T10:00:00.000Z"),
  };
}

describe("canonical knowledge document change cursor", () => {
  test("keeps pagination inside one fixed window without returning paths", async () => {
    const calls: Array<{ sql: string; values: unknown[] | undefined }> = [];
    const firstDocumentId = crypto.randomUUID();
    const secondDocumentId = crypto.randomUUID();
    const query = async (sql: string, values?: unknown[]) => {
      calls.push({ sql, values });
      if (sql.includes("GREATEST")) return { rows: [{ change_sequence: "12" }] };
      if (sql === "BEGIN" || sql === "COMMIT" || sql.includes("pg_advisory_xact_lock")) {
        return { rows: [] };
      }
      return values?.[2] === "5"
        ? { rows: [changeRow("9", firstDocumentId, 4), changeRow("11", secondDocumentId)] }
        : { rows: [changeRow("11", secondDocumentId)] };
    };
    const pool = {
      query,
      async connect() {
        return { query, release() {} };
      },
    } as unknown as Pool;
    const documents = new KnowledgeDocumentRepository(pool, bodies);

    const first = await documents.changesSince({ cursor: "cu-page-changes-v1.5", limit: 1 });
    expect(first).toMatchObject({
      changes: [{
        cursor: "cu-page-changes-v1.9",
        document_id: firstDocumentId,
        previous_revision_number: 4,
      }],
      next_cursor: "cu-page-changes-v1.c",
      has_more: true,
    });
    expect(first.changes[0]).not.toHaveProperty("path");
    expect(first.next_page_token).toBe("cu-page-scan-v1.5.c.9");

    const second = await documents.changesSince({
      pageToken: first.next_page_token!,
      limit: 1,
    });
    expect(second).toMatchObject({
      changes: [{ cursor: "cu-page-changes-v1.b", document_id: secondDocumentId }],
      next_cursor: "cu-page-changes-v1.c",
      has_more: false,
    });
    expect(second.next_page_token).toBeUndefined();
    expect(calls.filter(({ sql }) => sql.includes("GREATEST"))).toHaveLength(1);
    expect(calls.at(-1)?.values).toEqual(["5", "12", "9", 2]);
  });

  test("rejects mixing a completed cursor with an in-progress page token", async () => {
    const documents = new KnowledgeDocumentRepository({} as Pool, bodies);
    await expect(documents.changesSince({
      cursor: "cu-page-changes-v1.1",
      pageToken: "cu-page-scan-v1.0.1.0",
    })).rejects.toThrow("Provide a cursor or page token, not both");
  });

  test("returns recent changes newest-first with stable document metadata", async () => {
    const documentId = crypto.randomUUID();
    const calls: Array<{ sql: string; values: unknown[] | undefined }> = [];
    const pool = {
      async query(sql: string, values?: unknown[]) {
        calls.push({ sql, values });
        return { rows: [changeRow("9", documentId), changeRow("8", crypto.randomUUID())] };
      },
    } as unknown as Pool;
    const documents = new KnowledgeDocumentRepository(pool, bodies);

    const batch = await documents.recentChanges({
      before: "cu-page-changes-v1.5",
      limit: 1,
    });
    expect(batch).toMatchObject({
      changes: [{ cursor: "cu-page-changes-v1.9", document_id: documentId }],
      next_cursor: "cu-page-changes-v1.9",
      has_more: true,
    });
    expect(batch.changes[0]).not.toHaveProperty("path");
    expect(calls[0]?.values).toEqual(["5", 2]);
  });
});

describe("canonical retained knowledge revisions", () => {
  test("finds and reads the oldest retained revision in a comparison range", async () => {
    const documentId = crypto.randomUUID();
    const revisionId = crypto.randomUUID();
    const metadata = markdownObjectMetadata(revisionId, "Oldest retained body");
    const calls: Array<{ sql: string; values: unknown[] | undefined }> = [];
    const pool = {
      async query(sql: string, values?: unknown[]) {
        calls.push({ sql, values });
        if (sql.includes("ORDER BY version.version_number ASC")) {
          return { rows: [{ revision_number: 6 }] };
        }
        return { rows: [{
          document_id: documentId,
          revision_id: revisionId,
          revision_number: 6,
          title: "Retained document",
          summary: "The oldest retained comparison baseline.",
          commit_message: "Retain revision",
          actor_kind: "mcp",
          actor_subject: "client/session",
          created_at: new Date("2026-08-23T10:00:00.000Z"),
          link_contract: "generic_document_v1",
          contract_provenance: "authored",
          target_document_ids: [],
          ...metadata,
        }] };
      },
    } as unknown as Pool;
    const documents = new KnowledgeDocumentRepository(pool, bodies);

    expect(await documents.oldestRetainedRevisionAfter(documentId, 3, 10)).toMatchObject({
      document_id: documentId,
      revision_number: 6,
      body_markdown: "Oldest retained body",
    });
    expect(calls[0]?.values).toEqual([documentId, 3, 10]);
    expect(calls[1]?.values).toEqual([documentId, 6]);
  });
});
