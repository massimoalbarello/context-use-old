import {
  AutomationRegistryRepository,
  AssetRepository,
  KnowledgePageRepository,
  PrivateObjectCatalogRepository,
  PageDeletionRepository,
  SourceRecordRepository,
  createPool,
} from "@context-use/database";
import {
  PublicationRepository,
  PublicEntrypointRepository,
} from "@context-use/database/publication";
import { Elysia } from "elysia";
import { config, production } from "./config.ts";
import { issueConfirmationOptions } from "./confirmation-client.ts";
import { routeError } from "./http.ts";
import { securityHeaders } from "./security.ts";
import { BrokeredStorage } from "./storage-client.ts";
import { BrokeredMarkdownBlobStore } from "./markdown-blob-store.ts";
import { createOwnerAuthorizer } from "./routes/dashboard/authorization.ts";
import { createDashboardController } from "./routes/dashboard/controller.ts";
import { DashboardAssetsService } from "./services/dashboard-assets-service.ts";
import { DashboardMetadataService } from "./services/dashboard-metadata-service.ts";
import { DashboardObjectsService } from "./services/dashboard-objects-service.ts";
import { DashboardPagesService } from "./services/dashboard-pages-service.ts";
import { DashboardPublicationService } from "./services/dashboard-publication-service.ts";
import { DashboardRenderingService } from "./services/dashboard-rendering-service.ts";
import { DashboardWebService } from "./services/dashboard-web-service.ts";

const dashboardPool = createPool(config.DATABASE_URL);
const storage = new BrokeredStorage({
  socketPath: config.STORAGE_SOCKET_PATH,
  token: config.STORAGE_DASHBOARD_TOKEN,
});
const markdownBlobs = new BrokeredMarkdownBlobStore(storage);

const dashboardPages = new KnowledgePageRepository(dashboardPool, markdownBlobs);
const pageDeletions = new PageDeletionRepository(dashboardPool);
const dashboardAssets = new AssetRepository(dashboardPool);
const publications = new PublicationRepository(dashboardPool);
const publicEntrypoint = new PublicEntrypointRepository(dashboardPool);
const dashboardObjectCatalog = new PrivateObjectCatalogRepository(dashboardPool);
const dashboardAutomations = new AutomationRegistryRepository(dashboardPool);
const dashboardSourceRecords = new SourceRecordRepository(dashboardPool, markdownBlobs);
const authorizeOwner = createOwnerAuthorizer({ appOrigin: config.APP_ORIGIN });
const dashboardPublicationService = new DashboardPublicationService({
  publications,
  entrypoint: publicEntrypoint,
  storage,
  issueConfirmation: issueConfirmationOptions,
});
const dashboardAssetsService = new DashboardAssetsService({
  assets: dashboardAssets,
  publications,
  storage,
  assetOrigin: config.ASSET_ORIGIN,
});
const dashboardRenderingService = new DashboardRenderingService(dashboardObjectCatalog);
const dashboardObjectsService = new DashboardObjectsService({
  objects: dashboardObjectCatalog,
  automations: dashboardAutomations,
  sourceRecords: dashboardSourceRecords,
  rendering: dashboardRenderingService,
});
const dashboardPagesService = new DashboardPagesService({
  pages: dashboardPages,
  pageDeletions,
  publications,
  objects: dashboardObjectCatalog,
  rendering: dashboardRenderingService,
  issueConfirmation: issueConfirmationOptions,
  appOrigin: config.APP_ORIGIN,
  assetOrigin: config.ASSET_ORIGIN,
});
const dashboardMetadataService = new DashboardMetadataService(config);
const dashboardWebService = new DashboardWebService(config.WEB_DIST);

export const app = new Elysia({ serve: { maxRequestBodySize: 5_500_000_000 } })
  .onError(({ error, code }) => code === "NOT_FOUND"
    ? new Response("Not found", { status: 404, headers: securityHeaders })
    : routeError(error))
  .use(createDashboardController({
    authorizeOwner,
    assets: dashboardAssetsService,
    metadata: dashboardMetadataService,
    objects: dashboardObjectsService,
    pages: dashboardPagesService,
    publication: dashboardPublicationService,
    storage,
    web: dashboardWebService,
  }));

if (production) {
  console.info("security_mode", {
    dashboard_auth: "cookie-only",
    publication_confirmation: "separate-service",
  });
}
