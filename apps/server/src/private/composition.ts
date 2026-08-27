import {
  AssetRepository,
  AutomationRegistryRepository,
  ConfirmationRepository,
  createPool,
  KnowledgePageRepository,
  KnowledgeSettingsRepository,
  ObjectLinkRepository,
  PageDeletionRepository,
  PrivateObjectCatalogRepository,
  SourceRecordRepository,
} from "@context-use/database";
import {
  PublicationRepository,
  PublicEntrypointRepository,
} from "@context-use/database/publication";
import { createSecurityHeaders } from "#http/security-headers.ts";
import { createMarkdownRenderer } from "#markdown/renderer.ts";
import { NangoRecordReader } from "#private/repositories/nango/record-reader.ts";
import { BrokeredMarkdownBlobStore } from "#private/repositories/storage/markdown-blob-repository.ts";
import { createMcpAssetDownloadHandler } from "#private/routes/api/mcp/assets/[assetId]/content/download-handler.ts";
import { createMcpAssetUploadHandler } from "#private/routes/api/mcp/assets/[assetId]/content/upload-handler.ts";
import { ConfirmationService } from "#private/services/confirmation/confirmation-service.ts";
import { DashboardAssetsService } from "#private/services/dashboard/assets-service.ts";
import { DashboardMetadataService } from "#private/services/dashboard/metadata-service.ts";
import { DashboardObjectsService } from "#private/services/dashboard/objects-service.ts";
import { DashboardPublicationService } from "#private/services/dashboard/publication-service.ts";
import { DashboardRenderingService } from "#private/services/dashboard/rendering-service.ts";
import { DashboardWebService } from "#private/services/dashboard/web-service.ts";
import { createPrivateStorageBroker } from "#storage/client/storage-broker-client.ts";
import { createPrivateApp } from "./app.ts";
import { createAuthEngine } from "./auth/auth-engine.ts";
import { createOwnerAuthorizer } from "./auth/dashboard-owner-authorizer.ts";
import { createDashboardSecurity } from "./auth/dashboard-security.ts";
import { createAuthOwnerAuthorizer } from "./auth/owner-authorizer.ts";
import { createAuthController } from "./auth/routes.ts";
import type { PrivateConfig } from "./config.ts";
import { AuthClientRepository } from "./repositories/auth/client-repository.ts";
import { createDashboardController } from "./routes/api/dashboard/controller.ts";
import { createMcpController } from "./routes/mcp/controller.ts";
import { AuthAuthorizationService } from "./services/auth/authorization-service.ts";
import { PageDeletionService } from "./services/dashboard/page-deletion-service.ts";
import { PageHistoryService } from "./services/dashboard/page-history-service.ts";
import { PageMutationsService } from "./services/dashboard/page-mutations-service.ts";
import { PagePublicationPreviewService } from "./services/dashboard/page-publication-preview-service.ts";
import { createMcpService } from "./services/mcp/mcp-service.ts";

export function composePrivateApp(config: PrivateConfig) {
  const pool = createPool(config.PRIVATE_DATABASE_URL, {
    application_name: "context-use-private",
    options: "-c search_path=auth,public",
  });
  const securityHeaders = createSecurityHeaders(config.ASSET_ORIGIN);
  const dashboardSecurity = createDashboardSecurity({
    appOrigin: config.APP_ORIGIN,
    csrfSecret: config.BETTER_AUTH_SECRET,
  });
  const authEngine = createAuthEngine({ config, pool });
  const authClients = new AuthClientRepository(pool);
  const authorization = new AuthAuthorizationService({
    authEngine,
    clients: authClients,
    issuer: config.OAUTH_ISSUER,
    mcpResource: config.MCP_RESOURCE,
    nangoClientId: config.NANGO_OAUTH_CLIENT_ID,
    nangoClientSecret: config.NANGO_OAUTH_CLIENT_SECRET,
    appOrigin: config.APP_ORIGIN,
  });
  const confirmation = new ConfirmationService({
    confirmations: new ConfirmationRepository(pool),
    appOrigin: config.APP_ORIGIN,
    rpId: config.WEBAUTHN_RP_ID,
  });
  const authorizeAuthOwner = createAuthOwnerAuthorizer({
    appOrigin: config.APP_ORIGIN,
    dashboardPrincipal: authEngine.dashboardPrincipal,
    dashboardSecurity,
  });

  const storage = createPrivateStorageBroker({
    socketPath: config.STORAGE_SOCKET_PATH,
    token: config.STORAGE_PRIVATE_TOKEN,
  });
  const markdownBlobs = new BrokeredMarkdownBlobStore(storage);
  const pages = new KnowledgePageRepository(pool, markdownBlobs);
  const assets = new AssetRepository(pool);
  const objectCatalog = new PrivateObjectCatalogRepository(pool);
  const sourceRecords = new SourceRecordRepository(pool, markdownBlobs);
  const publications = new PublicationRepository(pool);
  const pageDeletions = new PageDeletionRepository(pool);
  const markdown = createMarkdownRenderer({
    appOrigin: config.APP_ORIGIN,
    assetOrigin: config.ASSET_ORIGIN,
  });
  const rendering = new DashboardRenderingService(objectCatalog, markdown);
  const issueConfirmation = (input: { kind: "publication" | "page_deletion"; intentId: string }) =>
    confirmation.options(input);
  const authorizeOwner = createOwnerAuthorizer({
    appOrigin: config.APP_ORIGIN,
    dashboardPrincipal: authEngine.dashboardPrincipal,
    dashboardSecurity,
  });

  const dashboardRoutes = createDashboardController({
    authorizeOwner,
    assets: new DashboardAssetsService({
      assets,
      publications,
      storage,
      assetOrigin: config.ASSET_ORIGIN,
    }),
    metadata: new DashboardMetadataService(config),
    objects: new DashboardObjectsService({
      objects: objectCatalog,
      automations: new AutomationRegistryRepository(pool),
      sourceRecords,
      rendering,
    }),
    pageDeletion: new PageDeletionService({
      pages,
      pageDeletions,
      publications,
      issueConfirmation,
    }),
    pageHistory: new PageHistoryService(pages),
    pageMutations: new PageMutationsService({
      pages,
      publications,
      rendering,
      appOrigin: config.APP_ORIGIN,
    }),
    pagePublicationPreview: new PagePublicationPreviewService({
      pages,
      publications,
      objects: objectCatalog,
      markdown,
      appOrigin: config.APP_ORIGIN,
      assetOrigin: config.ASSET_ORIGIN,
    }),
    publication: new DashboardPublicationService({
      publications,
      entrypoint: new PublicEntrypointRepository(pool),
      storage,
      issueConfirmation,
    }),
    securityHeaders,
    storage,
    web: new DashboardWebService(config.WEB_DIST),
  });

  const nangoRecords = config.NANGO_PIPELINE_API_KEY
    ? new NangoRecordReader({
        baseUrl: config.NANGO_INTERNAL_URL,
        apiKey: config.NANGO_PIPELINE_API_KEY,
        recordWriter: sourceRecords,
      })
    : undefined;
  const mcpService = createMcpService({
    sourceRecords: nangoRecords,
    recordObjects: sourceRecords,
    knowledgeSettings: new KnowledgeSettingsRepository(pool),
    objectLinks: new ObjectLinkRepository(pool),
    objects: { pages, assets, objectCatalog },
    appOrigin: config.APP_ORIGIN,
    capabilitySecret: config.MCP_ASSET_CAPABILITY_SECRET,
  });
  const assetHandlers = {
    assets,
    storage,
    appOrigin: config.APP_ORIGIN,
    capabilitySecret: config.MCP_ASSET_CAPABILITY_SECRET,
    authorizeLineage: async ({ clientId, sessionId }: { clientId: string; sessionId: string }) =>
      (await authorization.authorizeMcpLineage({ clientId, sessionId })).state === "authorized",
    securityHeaders,
  };
  const uploadAsset = createMcpAssetUploadHandler(assetHandlers);
  const downloadAsset = createMcpAssetDownloadHandler(assetHandlers);

  const app = createPrivateApp({
    auth: createAuthController({
      authEngine,
      authorizeOwner: authorizeAuthOwner,
      authorization,
      clients: authClients,
      confirmation,
      dashboardSecurity,
      nangoToken: config.AUTH_NANGO_TOKEN,
      passkeyPolicy: {
        appOrigin: config.APP_ORIGIN,
        rpId: config.WEBAUTHN_RP_ID,
      },
      pool,
    }),
    dashboard: dashboardRoutes,
    mcp: createMcpController({
      appOrigin: config.APP_ORIGIN,
      authorizationIssuer: config.OAUTH_ISSUER,
      authorization,
      resource: config.MCP_RESOURCE,
      handleMcp: mcpService,
      upload: (input) => uploadAsset(input),
      download: (input) => downloadAsset(input),
    }),
    securityHeaders,
  });

  return {
    app,
    close: () => pool.end(),
  };
}

export type PrivateRuntime = ReturnType<typeof composePrivateApp>;
