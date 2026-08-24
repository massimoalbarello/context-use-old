import {
  DocumentAssetRepository,
  DocumentLinkRepository,
  KnowledgeDocumentRepository,
  KnowledgeSettingsRepository,
  PrivateDocumentCatalogRepository,
  SourceRecordRepository,
  createPool,
} from "@context-use/database";
import { MCP_SCOPES } from "@context-use/shared";
import { Elysia } from "elysia";
import { config } from "./config.ts";
import { json, routeError } from "./http.ts";
import { createMcpRequestHandler } from "./mcp.ts";
import { createMcpAssetDownloadHandler } from "./mcp-asset-download.ts";
import { createMcpAssetUploadHandler } from "./mcp-asset-upload.ts";
import { NangoRecordReader } from "./nango-records.ts";
import { securityHeaders } from "./security.ts";
import { BrokeredStorage } from "./storage-client.ts";
import { BrokeredMarkdownObjectStore } from "./markdown-object-store.ts";

const pool = createPool(config.MCP_DATABASE_URL, { application_name: "context-use-private-mcp" });
const storage = new BrokeredStorage({
  socketPath: config.STORAGE_SOCKET_PATH,
  token: config.STORAGE_MCP_TOKEN,
});
const markdownObjects = new BrokeredMarkdownObjectStore(storage);
const knowledgeDocuments = new KnowledgeDocumentRepository(pool, markdownObjects);
const documentAssets = new DocumentAssetRepository(pool);
const documentCatalog = new PrivateDocumentCatalogRepository(pool);
const recordDocuments = new SourceRecordRepository(pool, markdownObjects);
const knowledgeSettings = new KnowledgeSettingsRepository(pool);
const documentLinks = new DocumentLinkRepository(pool);
const sourceRecords = config.NANGO_PIPELINE_API_KEY
  ? new NangoRecordReader({
    baseUrl: config.NANGO_INTERNAL_URL,
    apiKey: config.NANGO_PIPELINE_API_KEY,
    recordWriter: recordDocuments,
  })
  : undefined;
const knowledgeMcp = createMcpRequestHandler(
  sourceRecords,
  recordDocuments,
  knowledgeSettings,
  documentLinks,
  { knowledgeDocuments, documentAssets, documentCatalog },
);
const upload = createMcpAssetUploadHandler(documentAssets, storage);
const download = createMcpAssetDownloadHandler(documentAssets, storage);
const protectedResourceMetadata = () => json({
  resource: config.MCP_RESOURCE,
  authorization_servers: [config.OAUTH_ISSUER],
  // `offline_access` is advertised because a client registers with what it discovers here
  // and then asks for it at the authorization endpoint. Omitting it made Claude Code
  // register for `mcp:access` alone and then fail its own authorization request with
  // `invalid_scope`, since a refresh token is what keeps a long-lived MCP client connected.
  scopes_supported: [...MCP_SCOPES, "offline_access"],
  bearer_methods_supported: ["header"],
  resource_name: "context-use personal knowledge base",
});

export const mcpApp = new Elysia({ serve: { maxRequestBodySize: 5_100_000_000 } })
  .onError(({ error, code }) => code === "NOT_FOUND"
    ? new Response("Not found", { status: 404, headers: securityHeaders })
    : routeError(error))
  .get("/health", () => json({ status: "ok", service: "private-mcp" }))
  .get("/.well-known/oauth-protected-resource", () => protectedResourceMetadata())
  .get("/.well-known/oauth-protected-resource/mcp", () => protectedResourceMetadata())
  .get("/mcp", ({ request }) => knowledgeMcp(request))
  .post("/mcp", ({ request }) => knowledgeMcp(request))
  .delete("/mcp", ({ request }) => knowledgeMcp(request))
  .put("/api/mcp/assets/:id/content", ({ request, params }) => upload(request, params.id), { parse: "none" })
  .get("/api/mcp/assets/:id/content", ({ request, params }) => download(request, params.id));
