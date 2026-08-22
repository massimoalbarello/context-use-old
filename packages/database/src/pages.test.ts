import { describe, expect, test } from "bun:test";
import type { Pool } from "pg";
import { markdownObjectMetadata, type MarkdownObjectStore } from "./documents.ts";
import { PageRepository } from "./pages.ts";

function row(sequence: string, pageId: string, path: string, previousVersionNumber?: number | null) {
  return {
    change_sequence: sequence,
    page_id: pageId,
    version_id: crypto.randomUUID(),
    version_number: Number(sequence),
    change_kind: "updated" as const,
    path,
    title: path,
    commit_message: `Update ${path}`,
    actor_kind: "mcp" as const,
    actor_subject: "client/session",
    changed_at: new Date("2026-08-06T10:00:00.000Z"),
    ...(previousVersionNumber === undefined
      ? {}
      : { previous_version_number: previousVersionNumber }),
  };
}

describe("durable page change cursor", () => {
  test("keeps pagination inside one fixed window and returns an opaque completion cursor", async () => {
    const calls: Array<{ sql: string; values: unknown[] | undefined }> = [];
    const query = async (sql: string, values?: unknown[]) => {
      calls.push({ sql, values });
      if (sql.includes("GREATEST")) return { rows: [{ change_sequence: "12" }] };
      if (sql === "BEGIN" || sql === "COMMIT" || sql.includes("pg_advisory_xact_lock")) {
        return { rows: [] };
      }
      const position = values?.[2];
      return position === "5"
        ? { rows: [
          row("9", crypto.randomUUID(), "about/intro", 4),
          row("11", crypto.randomUUID(), "people/alex", null),
        ] }
        : { rows: [row("11", crypto.randomUUID(), "people/alex")] };
    };
    const pool = {
      query,
      async connect() {
        return { query, release() {} };
      },
    } as unknown as Pool;
    const pages = new PageRepository(pool);

    const first = await pages.changesSince({ cursor: "cu-page-changes-v1.5", limit: 1 });
    expect(first).toMatchObject({
      changes: [{
        cursor: "cu-page-changes-v1.9",
        path: "about/intro",
        previous_version_number: 4,
      }],
      next_cursor: "cu-page-changes-v1.c",
      has_more: true,
    });
    expect(first.next_page_token).toBe("cu-page-scan-v1.5.c.9");

    const second = await pages.changesSince({ pageToken: first.next_page_token!, limit: 1 });
    expect(second).toMatchObject({
      changes: [{ cursor: "cu-page-changes-v1.b", path: "people/alex" }],
      next_cursor: "cu-page-changes-v1.c",
      has_more: false,
    });
    expect(second.next_page_token).toBeUndefined();
    expect(calls.filter(({ sql }) => sql.includes("GREATEST"))).toHaveLength(1);
    expect(calls.some(({ sql }) => sql.includes("pg_advisory_xact_lock"))).toBe(true);
    expect(calls.some(({ sql }) => sql.includes("baseline.version_number AS previous_version_number")))
      .toBe(true);
    expect(calls.some(({ sql }) => sql.includes("prior.change_sequence<=$1::bigint"))).toBe(true);
    expect(calls.at(-1)?.values).toEqual(["5", "12", "9", 2]);
  });

  test("rejects mixing a completed cursor with an in-progress page token", async () => {
    const pages = new PageRepository({} as Pool);
    await expect(pages.changesSince({
      cursor: "cu-page-changes-v1.1",
      pageToken: "cu-page-scan-v1.0.1.0",
    })).rejects.toThrow("Provide a cursor or page token, not both");
  });
});

describe("retained page versions", () => {
  test("finds the oldest retained version inside a requested comparison range", async () => {
    const calls: Array<{ sql: string; values: unknown[] | undefined }> = [];
    const pool = {
      async query(sql: string, values?: unknown[]) {
        calls.push({ sql, values });
        return { rows: [{ version_number: 6, body_markdown: "Oldest retained body" }] };
      },
    } as unknown as Pool;
    const pages = new PageRepository(pool);

    expect(await pages.oldestRetainedVersionAfter(
      "11111111-1111-4111-8111-111111111111",
      3,
      10,
    )).toMatchObject({ version_number: 6, body_markdown: "Oldest retained body" });
    expect(calls[0]?.sql).toContain("version.version_number>$2 AND version.version_number<=$3");
    expect(calls[0]?.sql).toContain("ORDER BY version.version_number ASC");
    expect(calls[0]?.values).toEqual([
      "11111111-1111-4111-8111-111111111111",
      3,
      10,
    ]);
  });
});

describe("page mutation lock ordering", () => {
  const pageId = "11111111-1111-4111-8111-111111111111";
  const currentRevisionId = "22222222-2222-4222-8222-222222222222";
  const currentBody = "Current body";
  const currentObject = markdownObjectMetadata(currentRevisionId, currentBody);
  const store: MarkdownObjectStore = {
    async write(revisionId, markdown) {
      return markdownObjectMetadata(revisionId, markdown);
    },
    async read() {
      return currentBody;
    },
  };

  function repository() {
    const transactionCalls: string[] = [];
    const query = async (sql: string) => {
      transactionCalls.push(sql);
      if (sql.includes("FOR UPDATE OF p")) {
        return { rowCount: 1, rows: [{
          version_number: 2,
          current_path: "about/current",
          title: "Current",
          summary: "Current page summary.",
          published_version_id: null,
        }] };
      }
      return { rowCount: 0, rows: [] };
    };
    const pool = {
      async query() {
        return { rowCount: 1, rows: [{
          id: pageId,
          current_path: "about/current",
          current_version_id: currentRevisionId,
          published_version_id: null,
          public_path: null,
          archived_at: null,
          version_number: 2,
          title: "Current",
          summary: "Current page summary.",
          ...currentObject,
        }] };
      },
      async connect() {
        return { query, release() {} };
      },
    } as unknown as Pool;
    return { pages: new PageRepository(pool, store), transactionCalls };
  }

  function expectCanonicalOrder(calls: string[]) {
    const transition = calls.findIndex((sql) => sql.includes(
      "pg_advisory_xact_lock_shared",
    ));
    const document = calls.findIndex((sql) => sql.includes("lock_operational_document"));
    const page = calls.findIndex((sql) => sql.includes("FOR UPDATE OF p"));
    expect(transition).toBeGreaterThan(-1);
    expect(document).toBeGreaterThan(transition);
    expect(page).toBeGreaterThan(document);
  }

  test("update locks the corpus transition and operational identity before the page row", async () => {
    const { pages, transactionCalls } = repository();
    await expect(pages.update(pageId, {
      path: "about/current",
      title: "Update",
      summary: "Updated page summary.",
      body_markdown: "Updated body",
      commit_message: "Update current page",
      expected_version_number: 1,
    }, { kind: "dashboard", subject: "owner" })).rejects.toThrow(
      "Page changed; current version is 2",
    );
    expectCanonicalOrder(transactionCalls);
  });

  test("create takes the corpus transition lock before inserting any page state", async () => {
    const { pages, transactionCalls } = repository();
    await pages.create({
      path: "about/new",
      title: "New page",
      summary: "A newly created page.",
      body_markdown: "New body",
      commit_message: "Create page",
    }, { kind: "dashboard", subject: "owner" });
    const transition = transactionCalls.findIndex((sql) => sql.includes(
      "pg_advisory_xact_lock_shared",
    ));
    const firstInsert = transactionCalls.findIndex((sql) => sql.includes("INSERT INTO"));
    expect(transition).toBeGreaterThan(-1);
    expect(firstInsert).toBeGreaterThan(transition);
  });

  test("archive uses the same lock order before checking the current page", async () => {
    const { pages, transactionCalls } = repository();
    await expect(pages.archive(pageId, {
      commit_message: "Archive current page",
      expected_version_number: 1,
    }, { kind: "dashboard", subject: "owner" })).rejects.toThrow(
      "Page changed; current version is 2",
    );
    expectCanonicalOrder(transactionCalls);
  });
});

describe("dashboard page change history", () => {
  test("orders by change time with sequence as a stable pagination tie-breaker", async () => {
    const calls: Array<{ sql: string; values: unknown[] | undefined }> = [];
    const rows = [
      { ...row("12", crypto.randomUUID(), "about/latest"), changed_at: new Date("2026-08-07T11:08:00.000Z") },
      { ...row("9", crypto.randomUUID(), "about/earlier"), changed_at: new Date("2026-08-07T10:50:00.000Z") },
    ];
    const pool = {
      async query(sql: string, values?: unknown[]) {
        calls.push({ sql, values });
        return { rows };
      },
    } as unknown as Pool;
    const pages = new PageRepository(pool);

    const history = await pages.recentChanges({ before: "cu-page-changes-v1.d", limit: 2 });

    expect(history.changes.map(({ path }) => path)).toEqual(["about/latest", "about/earlier"]);
    expect(calls[0]?.sql).toContain("ORDER BY changes.changed_at DESC,changes.change_sequence DESC");
    expect(calls[0]?.sql).toContain("(changes.changed_at,changes.change_sequence)<");
    expect(calls[0]?.values).toEqual(["13", 3]);
  });
});
