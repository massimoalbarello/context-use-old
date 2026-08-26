import {
  AssetRepository,
  KnowledgePageRepository,
  KnowledgeSettingsRepository,
  ObjectLinkRepository,
  PrivateObjectCatalogRepository,
  SourceRecordRepository,
  createPool,
} from "@context-use/database";
import { Elysia } from "elysia";
import { config } from "./config.ts";
import { routeError } from "./http.ts";
import { BrokeredMarkdownBlobStore } from "./markdown-blob-store.ts";
import { createMcpAssetDownloadHandler } from "./mcp-asset-download.ts";
import { createMcpAssetUploadHandler } from "./mcp-asset-upload.ts";
import { createMcpRequestHandler } from "./mcp.ts";
import { NangoRecordReader } from "./nango-records.ts";
import { createMcpController } from "./routes/mcp/controller.ts";
import { securityHeaders } from "./security.ts";
import { BrokeredStorage } from "./storage-client.ts";

const pool = createPool(config.MCP_DATABASE_URL, {
  application_name: "context-use-private-mcp",
});
const storage = new BrokeredStorage({
  socketPath: config.STORAGE_SOCKET_PATH,
  token: config.STORAGE_MCP_TOKEN,
});
const markdownBlobs = new BrokeredMarkdownBlobStore(storage);
const pages = new KnowledgePageRepository(pool, markdownBlobs);
const assets = new AssetRepository(pool);
const objectCatalog = new PrivateObjectCatalogRepository(pool);
const records = new SourceRecordRepository(pool, markdownBlobs);
const sourceRecords = config.NANGO_PIPELINE_API_KEY
  ? new NangoRecordReader({
      baseUrl: config.NANGO_INTERNAL_URL,
      apiKey: config.NANGO_PIPELINE_API_KEY,
      recordWriter: records,
    })
  : undefined;
const handleMcp = createMcpRequestHandler(
  sourceRecords,
  records,
  new KnowledgeSettingsRepository(pool),
  new ObjectLinkRepository(pool),
  { pages, assets, objectCatalog },
);
const upload = createMcpAssetUploadHandler(assets, storage);
const download = createMcpAssetDownloadHandler(assets, storage);

export const mcpApp = new Elysia({ serve: { maxRequestBodySize: 5_100_000_000 } })
  .onError(({ error, code }) =>
    code === "NOT_FOUND"
      ? new Response("Not found", { status: 404, headers: securityHeaders })
      : routeError(error),
  )
  .use(
    createMcpController({
      authorizationIssuer: config.OAUTH_ISSUER,
      resource: config.MCP_RESOURCE,
      handleMcp,
      upload: ({ request, assetId }) => upload(request, assetId),
      download: ({ request, assetId }) => download(request, assetId),
    }),
  );
