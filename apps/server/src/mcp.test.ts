import { describe, expect, test } from "bun:test";
import type {
  DocumentAssetRepository,
  DocumentLinkRepository,
  KnowledgeSettingsRepository,
  KnowledgeDocumentRepository,
  PrivateDocumentCatalogRepository,
} from "@context-use/database";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createKnowledgeGuideReceipt } from "./mcp-guidance-receipt.ts";
import { createMcpServer, type McpDocumentRepositories } from "./mcp-server.ts";
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
  knowledgeDocuments = documentsWithGuidance(),
  options: {
    context?: { clientId: string; sessionId: string };
    knowledgeSettings?: KnowledgeSettingsRepository;
    documentLinks?: DocumentLinkRepository;
    documents?: McpDocumentRepositories;
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
    knowledgeDocuments,
    documentAssets: {} as DocumentAssetRepository,
    documentCatalog: {} as PrivateDocumentCatalogRepository,
  } satisfies McpDocumentRepositories;
  const documentLinks = options.documentLinks ?? {
    async revisionIndex() { return null; },
    async backlinks() { return { backlinks: [], has_more: false }; },
    async backlinksComplete() { return false; },
  } as unknown as DocumentLinkRepository;
  return createMcpServer(
    options.context ?? DEFAULT_MCP_CONTEXT,
    options.sourceRecords,
    undefined,
    knowledgeSettings,
    documentLinks,
    documents,
  );
}

const rootGuide = {
  id: "11111111-1111-4111-8111-111111111111",
  current_path: "agents",
  current_version_id: "22222222-2222-4222-8222-222222222222",
  version_number: 1,
  title: "AGENTS.md",
  body_markdown: "Root guide",
};

function documentsWithGuidance(overrides: Record<string, unknown> = {}): KnowledgeDocumentRepository {
  return {
    async revision(documentId: string, revisionNumber: number) {
      if (documentId !== rootGuide.id || revisionNumber !== rootGuide.version_number) return null;
      return {
        document_id: rootGuide.id,
        revision_id: rootGuide.current_version_id,
        revision_number: rootGuide.version_number,
        title: rootGuide.title,
        summary: "Test global guide.",
        body_markdown: rootGuide.body_markdown,
      };
    },
    ...overrides,
  } as unknown as KnowledgeDocumentRepository;
}

const rootGuidanceReceipt = createKnowledgeGuideReceipt({
  documentId: rootGuide.id,
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

  test("exposes stable-ID document discovery and mutation without path inputs", async () => {
    const documentId = "77777777-7777-4777-8777-777777777777";
    const revisionId = "88888888-8888-4888-8888-888888888888";
    const document = {
      document_id: documentId,
      current_revision_id: revisionId,
      public_id: null,
      revision_number: 1,
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
      document_id: documentId,
      document_kind: "knowledge",
      authority: "knowledge",
      representation: "markdown",
      lifecycle: "active",
      current_revision_id: revisionId,
      title: document.title,
      summary: document.summary,
      filename: null,
      content_type: null,
      operational_roles: [],
      updated_at: document.updated_at,
      current_path: "must-not-leak",
    };
    const knowledgeDocuments = documentsWithGuidance({
      async get(id: string) { return id === documentId ? document : null; },
      async create() { return document; },
      async changesSince() {
        return {
          changes: [{
            cursor: "cu-page-changes-v1.1",
            document_id: documentId,
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
      knowledgeDocuments,
      documentAssets: {} as DocumentAssetRepository,
      documentCatalog: {
        async get(id: string) { return id === documentId ? catalogItem : null; },
        async search() {
          return { documents: [catalogItem], next_cursor: null, has_more: false };
        },
      } as unknown as PrivateDocumentCatalogRepository,
    } satisfies McpDocumentRepositories;
    const tools = await mcpRequest(serverWith(knowledgeDocuments, { documents }), {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    });
    const names = tools.result?.tools?.map(({ name }) => name) ?? [];
    expect(names).toEqual(expect.arrayContaining([
      "search_documents",
      "read_document",
      "create_document",
      "update_document",
      "archive_document",
      "create_document_asset_upload",
      "archive_document_asset",
      "list_document_changes",
      "compare_document_revisions",
      "list_document_revisions",
      "read_document_revision",
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
    for (const name of ["create_document", "update_document", "create_document_asset_upload"]) {
      expect(tools.result?.tools?.find((tool) => tool.name === name)?.inputSchema?.properties)
        .not.toHaveProperty("path");
    }

    const changes = await mcpRequest(serverWith(knowledgeDocuments, { documents }), {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "list_document_changes", arguments: {} },
    });
    expect(changes.result?.structuredContent).toMatchObject({
      changes: [{
        document_id: documentId,
        revision_id: revisionId,
        revision_number: 1,
        previous_revision_number: null,
      }],
    });
    expect(changes.result?.content?.[0]?.text).not.toContain("path");

    const searched = await mcpRequest(serverWith(knowledgeDocuments, { documents }), {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "search_documents", arguments: { query: "stable" } },
    });
    const searchResult = JSON.parse(searched.result?.content?.[0]?.text ?? "null");
    expect(searchResult.documents[0]).toMatchObject({
      document_id: documentId,
      reference: `context-use://document/${documentId}`,
      title: "Stable document",
      summary: "An identity-based knowledge document.",
    });
    expect(searchResult.documents[0]).not.toHaveProperty("current_path");

    const created = await mcpRequest(serverWith(knowledgeDocuments, { documents }), {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "create_document",
        arguments: {
          title: document.title,
          summary: document.summary,
          body_markdown: document.body_markdown,
          commit_message: "Create stable document",
          knowledge_session_receipt: rootGuidanceReceipt,
        },
      },
    });
    expect(JSON.parse(created.result?.content?.[0]?.text ?? "null")).toMatchObject({
      document_id: documentId,
      current_revision_id: revisionId,
      reference: `context-use://document/${documentId}`,
    });
  });

  test("reads a fixed, deduplicated knowledge-change window with harness-owned cursors", async () => {
    const calls: unknown[] = [];
    const revisions = documentsWithGuidance({
      async changesSince(input: unknown) {
        calls.push(input);
        return {
          changes: [{
            cursor: "cu-page-changes-v1.9",
            document_id: "11111111-1111-4111-8111-111111111111",
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
        name: "list_document_changes",
        arguments: { cursor: "cu-page-changes-v1.5", limit: 25 },
      },
    });

    expect(calls).toEqual([{ cursor: "cu-page-changes-v1.5", limit: 25 }]);
    expect(response.result?.structuredContent).toMatchObject({
      changes: [{
        document_id: "11111111-1111-4111-8111-111111111111",
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
        name: "compare_document_revisions",
        arguments: {
          document_id: "11111111-1111-4111-8111-111111111111",
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
      document_id: "11111111-1111-4111-8111-111111111111",
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
          body_markdown: "# Ada\n\nConsidered a new role.\n",
        };
      },
    });
    const response = await mcpRequest(serverWith(revisions), {
      jsonrpc: "2.0",
      id: 17,
      method: "tools/call",
      params: {
        name: "compare_document_revisions",
        arguments: {
          document_id: "11111111-1111-4111-8111-111111111111",
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
      document_id: "11111111-1111-4111-8111-111111111111",
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
        name: "compare_document_revisions",
        arguments: {
          document_id: "11111111-1111-4111-8111-111111111111",
          previous_revision_number: 3,
          revision_number: 8,
        },
      },
    });

    expect(response.result?.isError).toBe(true);
    expect(response.result?.structuredContent).toBeUndefined();
    expect(response.result?.content?.[0]?.text).toBe([
      "DOCUMENT_DELTA_UNAVAILABLE",
      "Document 11111111-1111-4111-8111-111111111111 revision 8 is not retained; no safe comparison was produced.",
    ].join("\n\n"));
  });


});
