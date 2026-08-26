import { describe, expect, test } from "bun:test";
import type {
  AssetRepository,
  ObjectLinkRepository,
  KnowledgeSettingsRepository,
  KnowledgePageRepository,
  PrivateObjectCatalogRepository,
} from "@context-use/database";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createKnowledgeGuideReceipt } from "./mcp-guidance-receipt.ts";
import { createMcpServer, type McpObjectRepositories } from "./mcp-server.ts";
import { createStatelessMcpTransport } from "./mcp-transport.ts";
import type { SourceRecordReader } from "./nango-records.ts";

async function mcpRequest(serverOrPromise: McpServer | Promise<McpServer>, body: Record<string, unknown>) {
  const server = await serverOrPromise;
  const transport = createStatelessMcpTransport();
  await server.connect(transport);
  try {
    const response = await transport.handleRequest(new Request("https://example.com/mcp", {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-protocol-version": "2025-06-18",
      },
      body: JSON.stringify(body),
    }));
    return await response.json() as {
      result?: {
        tools?: Array<{
          name: string;
          title?: string;
          description?: string;
          annotations?: { readOnlyHint?: boolean };
          inputSchema?: { properties?: Record<string, { default?: unknown; description?: string }> };
          outputSchema?: { properties?: Record<string, { description?: string }> };
        }>;
        content?: Array<{ type: string; text: string }>;
        structuredContent?: Record<string, unknown>;
        instructions?: string;
        isError?: boolean;
      };
    };
  } finally {
    await transport.close();
    await server.close();
  }
}

const DEFAULT_MCP_CONTEXT = { clientId: "mcp-client", sessionId: "mcp-session" };

function serverWith(
  pages = documentsWithGuidance(),
  options: {
    context?: { clientId: string; sessionId: string };
    knowledgeSettings?: KnowledgeSettingsRepository;
    objectLinks?: ObjectLinkRepository;
    documents?: McpObjectRepositories;
    sourceRecords?: SourceRecordReader;
  } = {},
) {
  const knowledgeSettings = options.knowledgeSettings ?? {
    async globalGuide() {
      return {
        document_id: rootGuide.id,
        current_revision_id: rootGuide.current_version_id,
        revision_number: rootGuide.version_number,
        title: rootGuide.title,
        summary: "Test global guide.",
      };
    },
  } as KnowledgeSettingsRepository;
  const documents = options.documents ?? {
    pages,
    assets: {} as AssetRepository,
    objectCatalog: {} as PrivateObjectCatalogRepository,
    publications: {
      async status() {
        return {
          public_id: null,
          published_revision_id: null,
          published_revision_number: null,
          active: false,
        };
      },
    },
  } satisfies McpObjectRepositories;
  const objectLinks = options.objectLinks ?? {
    async revisionIndex() { return null; },
    async backlinks() { return { backlinks: [], has_more: false }; },
    async backlinksComplete() { return false; },
  } as unknown as ObjectLinkRepository;
  return createMcpServer(
    options.context ?? DEFAULT_MCP_CONTEXT,
    options.sourceRecords,
    undefined,
    knowledgeSettings,
    objectLinks,
    documents,
  );
}

const rootGuide = {
  id: "11111111-1111-4111-8111-111111111111",
  current_version_id: "22222222-2222-4222-8222-222222222222",
  version_number: 1,
  title: "AGENTS.md",
  body_markdown: "Root guide",
};

function documentsWithGuidance(overrides: Record<string, unknown> = {}): KnowledgePageRepository {
  return {
    async revision(documentId: string, revisionNumber: number) {
      if (documentId !== rootGuide.id || revisionNumber !== rootGuide.version_number) return null;
      return {
        object_id: rootGuide.id,
        revision_id: rootGuide.current_version_id,
        revision_number: rootGuide.version_number,
        title: rootGuide.title,
        summary: "Test global guide.",
        body_markdown: rootGuide.body_markdown,
      };
    },
    ...overrides,
  } as unknown as KnowledgePageRepository;
}

const rootGuidanceReceipt = createKnowledgeGuideReceipt({
  pageId: rootGuide.id,
  revisionId: rootGuide.current_version_id,
}, DEFAULT_MCP_CONTEXT);


describe("MCP knowledge tools", () => {
  test("advertises bounded source reads as a non-read-only sync", async () => {
    const calls: unknown[] = [];
    const sourceRecords: SourceRecordReader = {
      async read(input) {
        calls.push(input);
        return {
          records: [],
          next_checkpoint: "cu-nango-v1.next",
          has_more: false,
        };
      },
    };
    const listed = await mcpRequest(serverWith(undefined, { sourceRecords }), {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    });
    const tool = listed.result?.tools?.find(({ name }) => name === "read_source_records");
    expect(listed.result?.tools?.some(({ name }) => name === "sync_source_record_batch")).toBe(false);
    expect(tool?.title).toBe("Sync source record batch");
    expect(tool?.description).toContain("at most one record");
    expect(tool?.inputSchema?.properties?.limit?.default).toBe(1);
    expect(tool?.annotations?.readOnlyHint).toBe(false);

    const read = await mcpRequest(serverWith(undefined, { sourceRecords }), {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "read_source_records", arguments: {} },
    });
    expect(calls).toEqual([{ checkpoint: undefined, limit: 1 }]);
    expect(read.result?.structuredContent).toEqual({
      records: [],
      next_checkpoint: "cu-nango-v1.next",
      has_more: false,
    });
  });

  test("exposes stable-ID object discovery and mutation without path inputs", async () => {
    const documentId = "77777777-7777-4777-8777-777777777777";
    const revisionId = "88888888-8888-4888-8888-888888888888";
    const document = {
      object_id: documentId,
      current_revision_id: revisionId,
      public_id: null,
      revision_number: 1,
      entity_type: "person" as const,
      title: "Stable document",
      summary: "An identity-based knowledge document.",
      archived_at: null,
      current_link_contract: "generic_document_v1",
      search_ready: true,
      created_at: "2026-08-23T12:00:00.000Z",
      updated_at: "2026-08-23T12:00:00.000Z",
      body_markdown: "Stable body",
    };
    const catalogItem = {
      object_id: documentId,
      object_kind: "page",
      authority: "knowledge",
      representation: "markdown",
      lifecycle: "active",
      current_revision_id: revisionId,
      entity_type: "person" as const,
      title: document.title,
      summary: document.summary,
      filename: null,
      content_type: null,
      operational_roles: [],
      updated_at: document.updated_at,
    };
    const mutations: unknown[] = [];
    const searches: unknown[] = [];
    const pages = documentsWithGuidance({
      async get(id: string) { return id === documentId ? document : null; },
      async create(input: unknown) { mutations.push(input); return document; },
      async changesSince() {
        return {
          changes: [{
            cursor: "cu-page-changes-v1.1",
            object_id: documentId,
            revision_id: revisionId,
            revision_number: 1,
            previous_revision_number: null,
            change_kind: "created",
            title: document.title,
            commit_message: "Create stable document",
            actor_kind: "mcp",
            actor_subject: "mcp-client",
            changed_at: document.updated_at,
          }],
          next_cursor: "cu-page-changes-v1.1",
          has_more: false,
        };
      },
    });
    const documents = {
      pages,
      assets: {} as AssetRepository,
      objectCatalog: {
        async get(id: string) { return id === documentId ? catalogItem : null; },
        async search(query: string, options: unknown) {
          searches.push({ query, options });
          return { objects: [catalogItem], next_cursor: null, has_more: false };
        },
      } as unknown as PrivateObjectCatalogRepository,
      publications: {
        async status() {
          return {
            public_id: null,
            published_revision_id: null,
            published_revision_number: null,
            active: false,
          };
        },
      },
    } satisfies McpObjectRepositories;
    const tools = await mcpRequest(serverWith(pages, { documents }), {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    });
    const names = tools.result?.tools?.map(({ name }) => name) ?? [];
    expect(names).toEqual(expect.arrayContaining([
      "search_objects",
      "read_object",
      "create_page",
      "update_page",
      "archive_page",
      "create_asset_upload",
      "archive_asset",
      "list_page_changes",
      "compare_page_revisions",
      "list_page_revisions",
      "read_page_revision",
    ]));
    expect(names).not.toEqual(expect.arrayContaining([
      "read_directory",
      "browse_directory",
      "create_directory",
      "update_directory",
      "delete_directory",
      "read_page",
      "search_pages",
      "list_page_changes",
      "compare_page_versions",
      "list_page_versions",
      "read_page_version",
      "create_page",
      "update_page",
      "archive_page",
      "list_assets",
      "read_asset",
      "create_asset_upload",
      "archive_asset",
      "prepare_change",
    ]));
    for (const name of ["create_page", "update_page", "create_asset_upload"]) {
      expect(tools.result?.tools?.find((tool) => tool.name === name)?.inputSchema?.properties)
        .not.toHaveProperty("path");
    }
    expect(tools.result?.tools?.find((tool) => tool.name === "search_objects")
      ?.inputSchema?.properties).toHaveProperty("entity_types");
    expect(tools.result?.tools?.find((tool) => tool.name === "create_page")
      ?.inputSchema?.properties).toHaveProperty("entity_type");

    const changes = await mcpRequest(serverWith(pages, { documents }), {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "list_page_changes", arguments: {} },
    });
    expect(changes.result?.structuredContent).toMatchObject({
      changes: [{
        object_id: documentId,
        revision_id: revisionId,
        revision_number: 1,
        previous_revision_number: null,
      }],
    });
    expect(changes.result?.content?.[0]?.text).not.toContain("path");

    const searched = await mcpRequest(serverWith(pages, { documents }), {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "search_objects",
        arguments: { query: "stable", entity_types: ["person"] },
      },
    });
    const searchResult = JSON.parse(searched.result?.content?.[0]?.text ?? "null");
    expect(searchResult.objects[0]).toMatchObject({
      object_id: documentId,
      reference: `context-use://object/${documentId}`,
      title: "Stable document",
      summary: "An identity-based knowledge document.",
      entity_type: "person",
    });
    expect(searches).toEqual([{
      query: "stable",
      options: { entity_types: ["person"], include_retired: false, limit: 30 },
    }]);
    const invalidEntitySearch = await mcpRequest(serverWith(pages, { documents }), {
      jsonrpc: "2.0",
      id: 31,
      method: "tools/call",
      params: {
        name: "search_objects",
        arguments: { query: "stable", object_kind: "record", entity_types: ["person"] },
      },
    });
    expect(invalidEntitySearch.result?.isError).toBe(true);
    expect(searches).toHaveLength(1);
    const created = await mcpRequest(serverWith(pages, { documents }), {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "create_page",
        arguments: {
          title: document.title,
          summary: document.summary,
          body_markdown: document.body_markdown,
          entity_type: "person",
          commit_message: "Create stable document",
          knowledge_session_receipt: rootGuidanceReceipt,
        },
      },
    });
    expect(JSON.parse(created.result?.content?.[0]?.text ?? "null")).toMatchObject({
      object_id: documentId,
      current_revision_id: revisionId,
      entity_type: "person",
      reference: `context-use://object/${documentId}`,
    });
    expect(mutations).toEqual([expect.objectContaining({ entity_type: "person" })]);
  });

  test("refuses published-page edits without explicit owner acknowledgment", async () => {
    const objectId = "77777777-7777-4777-8777-777777777777";
    const publishedRevisionId = "88888888-8888-4888-8888-888888888888";
    const currentRevisionId = "99999999-9999-4999-8999-999999999999";
    const page = {
      object_id: objectId,
      current_revision_id: currentRevisionId,
      revision_number: 2,
      entity_type: null,
      title: "Public introduction",
      summary: "The owner's public introduction.",
      body_markdown: "Owner-curated body",
      archived_at: null,
    };
    const updates: unknown[] = [];
    const pages = documentsWithGuidance({
      async get(id: string) { return id === objectId ? page : null; },
      async update(_id: string, input: unknown) {
        updates.push(input);
        return { ...page, current_revision_id: crypto.randomUUID(), revision_number: 3 };
      },
    });
    const objects = {
      pages,
      assets: {} as AssetRepository,
      objectCatalog: {
        async get(id: string) {
          return id === objectId ? {
            object_id: objectId,
            object_kind: "page",
            authority: "knowledge",
            representation: "markdown",
            lifecycle: "active",
            current_revision_id: currentRevisionId,
            entity_type: null,
            title: page.title,
            summary: page.summary,
            filename: null,
            content_type: null,
            operational_roles: [],
            updated_at: "2026-08-26T12:00:00.000Z",
          } : null;
        },
      } as unknown as PrivateObjectCatalogRepository,
      publications: {
        async status() {
          return {
            public_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            published_revision_id: publishedRevisionId,
            published_revision_number: 1,
            active: true,
          };
        },
      },
    } satisfies McpObjectRepositories;
    const input = {
      object_id: objectId,
      expected_revision_number: 2,
      title: page.title,
      summary: page.summary,
      body_markdown: "Unrequested agent edit",
      commit_message: "Edit published introduction",
      knowledge_session_receipt: rootGuidanceReceipt,
    };

    const read = await mcpRequest(serverWith(pages, { documents: objects }), {
      jsonrpc: "2.0",
      id: 39,
      method: "tools/call",
      params: { name: "read_object", arguments: { object_id: objectId } },
    });
    expect(JSON.parse(read.result?.content?.[0]?.text ?? "null").publication).toEqual({
      state: "published",
      public_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      published_revision_id: publishedRevisionId,
      published_revision_number: 1,
      unpublished_changes: true,
    });

    const refused = await mcpRequest(serverWith(pages, { documents: objects }), {
      jsonrpc: "2.0",
      id: 40,
      method: "tools/call",
      params: { name: "update_page", arguments: input },
    });
    expect(refused.result?.isError).toBe(true);
    expect(refused.result?.content?.[0]?.text).toContain("PUBLIC_PAGE_EDIT_BLOCKED");
    expect(refused.result?.content?.[0]?.text).toContain("NO CHANGES WERE MADE");
    expect(refused.result?.content?.[0]?.text)
      .toContain("Do not retry unless the user explicitly asked you to change this exact published page");
    expect(refused.result?.content?.[0]?.text)
      .toContain("a general request to update the knowledge base is not permission");
    expect(updates).toHaveLength(0);

    const acknowledged = await mcpRequest(serverWith(pages, { documents: objects }), {
      jsonrpc: "2.0",
      id: 41,
      method: "tools/call",
      params: {
        name: "update_page",
        arguments: { ...input, acknowledge_published_page: true },
      },
    });
    expect(acknowledged.result?.isError).not.toBe(true);
    expect(updates).toEqual([expect.not.objectContaining({
      acknowledge_published_page: expect.anything(),
    })]);

    const listed = await mcpRequest(serverWith(pages, { documents: objects }), {
      jsonrpc: "2.0",
      id: 42,
      method: "tools/list",
      params: {},
    });
    const updateTool = listed.result?.tools?.find(({ name }) => name === "update_page");
    expect(updateTool?.description).toContain("Never update a published page unless");
    expect(updateTool?.inputSchema?.properties?.acknowledge_published_page?.description)
      .toContain("only when the owner explicitly asked");
  });

  test("reads a fixed, deduplicated knowledge-change window with harness-owned cursors", async () => {
    const calls: unknown[] = [];
    const revisions = documentsWithGuidance({
      async changesSince(input: unknown) {
        calls.push(input);
        return {
          changes: [{
            cursor: "cu-page-changes-v1.9",
            object_id: "11111111-1111-4111-8111-111111111111",
            revision_id: "22222222-2222-4222-8222-222222222222",
            revision_number: 4,
            previous_revision_number: 2,
            change_kind: "updated",
            title: "Introduction",
            commit_message: "Reconcile introduction",
            actor_kind: "mcp",
            actor_subject: "client/session",
            changed_at: "2026-08-06T10:00:00.000Z",
          }],
          next_cursor: "cu-page-changes-v1.c",
          next_page_token: "cu-page-scan-v1.5.c.9",
          has_more: true,
        };
      },
    });
    const response = await mcpRequest(serverWith(revisions), {
      jsonrpc: "2.0",
      id: 15,
      method: "tools/call",
      params: {
        name: "list_page_changes",
        arguments: { cursor: "cu-page-changes-v1.5", limit: 25 },
      },
    });

    expect(calls).toEqual([{ cursor: "cu-page-changes-v1.5", limit: 25 }]);
    expect(response.result?.structuredContent).toMatchObject({
      changes: [{
        object_id: "11111111-1111-4111-8111-111111111111",
        revision_number: 4,
        previous_revision_number: 2,
      }],
      next_cursor: "cu-page-changes-v1.c",
      has_more: true,
    });
    expect(response.result?.content?.[0]?.text).not.toContain("body_markdown");
  });

  test("returns one clean compact delta for multiple distant changes", async () => {
    const calls: unknown[] = [];
    const revisions = documentsWithGuidance({
      async revision(pageId: string, versionNumber: number) {
        calls.push({ pageId, versionNumber });
        const versions = {
          2: {
            path: "projects/context-use/timeline",
            title: "Context Use timeline",
            summary: "Important project developments.",
            entity_type: null,
            body_markdown: [
              "# Timeline\n",
              "\n",
              "## 2026\n",
              "\n",
              "- 2026-08-10 — Opened the draft.\n",
              "\n",
              "This context remains unchanged.\n",
              "\n",
              "No follow-up was planned.\n",
            ].join(""),
          },
          4: {
            path: "projects/context-use/timeline",
            title: "Context Use timeline",
            summary: "Important project developments.",
            entity_type: null,
            body_markdown: [
              "# Timeline\n",
              "\n",
              "## 2026\n",
              "\n",
              "- 2026-08-10 — Opened the pull request.\n",
              "\n",
              "This context remains unchanged.\n",
              "\n",
              "Scheduled a follow-up for Friday.\n",
            ].join(""),
          },
        };
        return versions[versionNumber as keyof typeof versions] ?? null;
      },
    });
    const response = await mcpRequest(serverWith(revisions), {
      jsonrpc: "2.0",
      id: 16,
      method: "tools/call",
      params: {
        name: "compare_page_revisions",
        arguments: {
          object_id: "11111111-1111-4111-8111-111111111111",
          previous_revision_number: 2,
          revision_number: 4,
        },
      },
    });

    expect(calls).toEqual([
      { pageId: "11111111-1111-4111-8111-111111111111", versionNumber: 2 },
      { pageId: "11111111-1111-4111-8111-111111111111", versionNumber: 4 },
    ]);
    const expectedDelta = {
      object_id: "11111111-1111-4111-8111-111111111111",
      comparison: {
        requested_from_revision: 2,
        actual_from_revision: 2,
        to_revision: 4,
        complete: true,
      },
      metadata_changes: [],
      markdown_changes: [
        {
          before: "- 2026-08-10 — Opened the draft.\n",
          after: "- 2026-08-10 — Opened the pull request.\n",
        },
        {
          before: "No follow-up was planned.\n",
          after: "Scheduled a follow-up for Friday.\n",
        },
      ],
    };
    expect(response.result?.structuredContent).toEqual(expectedDelta);
    expect(response.result?.content?.[0]?.text).toBe(JSON.stringify(expectedDelta, null, 2));
  });

  test("falls back to the oldest retained version when the exact baseline was pruned", async () => {
    const fallbackCalls: unknown[] = [];
    const revisions = documentsWithGuidance({
      async revision(_pageId: string, versionNumber: number) {
        return versionNumber === 8 ? {
          path: "people/ada/intro",
          title: "Ada",
          summary: "A collaborator.",
          entity_type: "person",
          body_markdown: "# Ada\n\nStarted a new role.\n",
        } : null;
      },
      async oldestRetainedRevisionAfter(
        pageId: string,
        afterVersionNumber: number,
        throughVersionNumber: number,
      ) {
        fallbackCalls.push({ pageId, afterVersionNumber, throughVersionNumber });
        return {
          revision_number: 4,
          title: "Ada",
          summary: "A collaborator.",
          entity_type: "person",
          body_markdown: "# Ada\n\nConsidered a new role.\n",
        };
      },
    });
    const response = await mcpRequest(serverWith(revisions), {
      jsonrpc: "2.0",
      id: 17,
      method: "tools/call",
      params: {
        name: "compare_page_revisions",
        arguments: {
          object_id: "11111111-1111-4111-8111-111111111111",
          previous_revision_number: 3,
          revision_number: 8,
        },
      },
    });

    expect(fallbackCalls).toEqual([{
      pageId: "11111111-1111-4111-8111-111111111111",
      afterVersionNumber: 3,
      throughVersionNumber: 8,
    }]);
    expect(response.result?.structuredContent).toEqual({
      object_id: "11111111-1111-4111-8111-111111111111",
      comparison: {
        requested_from_revision: 3,
        actual_from_revision: 4,
        to_revision: 8,
        complete: false,
      },
      metadata_changes: [],
      markdown_changes: [{
        before: "Considered a new role.\n",
        after: "Started a new role.\n",
      }],
    });
  });

  test("reports an unavailable window end without substituting another version", async () => {
    const revisions = documentsWithGuidance({
      async revision() {
        return null;
      },
    });
    const response = await mcpRequest(serverWith(revisions), {
      jsonrpc: "2.0",
      id: 18,
      method: "tools/call",
      params: {
        name: "compare_page_revisions",
        arguments: {
          object_id: "11111111-1111-4111-8111-111111111111",
          previous_revision_number: 3,
          revision_number: 8,
        },
      },
    });

    expect(response.result?.isError).toBe(true);
    expect(response.result?.structuredContent).toBeUndefined();
    expect(response.result?.content?.[0]?.text).toBe([
      "PAGE_DELTA_UNAVAILABLE",
      "Page 11111111-1111-4111-8111-111111111111 revision 8 is not retained; no safe comparison was produced.",
    ].join("\n\n"));
  });


});
