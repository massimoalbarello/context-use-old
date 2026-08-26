import { Elysia } from "elysia";
import type { DashboardAssetsService } from "../../services/dashboard-assets-service.ts";
import type { DashboardKnowledgeBundleExportsService } from "../../services/dashboard-knowledge-bundle-exports-service.ts";
import type { DashboardKnowledgeImportsService } from "../../services/dashboard-knowledge-imports-service.ts";
import type { DashboardMetadataService } from "../../services/dashboard-metadata-service.ts";
import type { DashboardObjectsService } from "../../services/dashboard-objects-service.ts";
import type { DashboardPagesService } from "../../services/dashboard-pages-service.ts";
import type { DashboardPublicationService } from "../../services/dashboard-publication-service.ts";
import type { DashboardWebService } from "../../services/dashboard-web-service.ts";
import type { BrokeredStorage } from "../../storage-client.ts";
import { createAssetController } from "./api/dashboard/assets/[assetId]/controller.ts";
import { createAssetsController } from "./api/dashboard/assets/controller.ts";
import { DashboardAuthController } from "./api/dashboard/auth/controller.ts";
import { createAutomationsController } from "./api/dashboard/automations/controller.ts";
import { createKnowledgeBundleExportIntentsController } from "./api/dashboard/knowledge-bundle-export-intents/controller.ts";
import { createKnowledgeBundleDownloadController } from "./api/dashboard/knowledge-bundles/[bundleId]/download/controller.ts";
import { createKnowledgeBundleStatusController } from "./api/dashboard/knowledge-bundles/[bundleId]/status/controller.ts";
import { createKnowledgeChangesController } from "./api/dashboard/knowledge-changes/controller.ts";
import { createKnowledgeImportPartController } from "./api/dashboard/knowledge-imports/[importId]/parts/[part]/controller.ts";
import { createKnowledgeImportStatusController } from "./api/dashboard/knowledge-imports/[importId]/status/controller.ts";
import { createKnowledgeImportValidationController } from "./api/dashboard/knowledge-imports/[importId]/validate/controller.ts";
import { createKnowledgeImportAvailabilityController } from "./api/dashboard/knowledge-imports/availability/controller.ts";
import { createKnowledgeImportsController } from "./api/dashboard/knowledge-imports/controller.ts";
import { createDashboardMetadataController } from "./api/dashboard/metadata/controller.ts";
import { createObjectController } from "./api/dashboard/objects/[objectId]/controller.ts";
import { createObjectNeighborhoodController } from "./api/dashboard/objects/[objectId]/neighborhood/controller.ts";
import { createObjectsController } from "./api/dashboard/objects/controller.ts";
import { createPageArchiveController } from "./api/dashboard/pages/[pageId]/archive/controller.ts";
import { createPageController } from "./api/dashboard/pages/[pageId]/controller.ts";
import { createPageDeletionIntentsController } from "./api/dashboard/pages/[pageId]/deletion-intents/controller.ts";
import { createPageHistoryController } from "./api/dashboard/pages/[pageId]/history/controller.ts";
import { createPagePublicationPreviewController } from "./api/dashboard/pages/[pageId]/publication-preview/controller.ts";
import { createPageVersionDiffController } from "./api/dashboard/pages/[pageId]/versions/[version]/diff/controller.ts";
import { createPublicationEntrypointController } from "./api/dashboard/publication-entrypoint/controller.ts";
import { createPublicationIntentsController } from "./api/dashboard/publication-intents/controller.ts";
import { createSourceRecordArchiveController } from "./api/dashboard/source-records/[objectId]/archive/controller.ts";
import { createSourceRecordController } from "./api/dashboard/source-records/[objectId]/controller.ts";
import { createDashboardHealthController } from "./api/health/controller.ts";
import { createDashboardWebController } from "./app/controller.ts";
import type { AuthorizeOwner } from "./authorization.ts";

export function createDashboardController({
  authorizeOwner,
  assets,
  bundleExports,
  knowledgeImports,
  metadata,
  objects,
  pages,
  publication,
  storage,
  web,
}: {
  authorizeOwner: AuthorizeOwner;
  assets: DashboardAssetsService;
  bundleExports: DashboardKnowledgeBundleExportsService;
  knowledgeImports: DashboardKnowledgeImportsService;
  metadata: DashboardMetadataService;
  objects: DashboardObjectsService;
  pages: DashboardPagesService;
  publication: DashboardPublicationService;
  storage: BrokeredStorage;
  web: DashboardWebService;
}) {
  return new Elysia()
    .use(createDashboardHealthController({ service: metadata }))
    .use(DashboardAuthController)
    .use(createDashboardMetadataController({ authorizeOwner, service: metadata }))
    .use(createDashboardWebController({ service: web }))
    .use(createPublicationIntentsController({ authorizeOwner, service: publication }))
    .use(createPublicationEntrypointController({ authorizeOwner, service: publication }))
    .use(createAssetsController({ authorizeOwner, service: assets }))
    .use(createAssetController({ authorizeOwner, service: assets, storage }))
    .use(createObjectsController({ authorizeOwner, objects, pages }))
    .use(createObjectController({ authorizeOwner, service: objects }))
    .use(createObjectNeighborhoodController({ authorizeOwner, service: objects }))
    .use(createAutomationsController({ authorizeOwner, service: objects }))
    .use(createSourceRecordController({ authorizeOwner, service: objects }))
    .use(createSourceRecordArchiveController({ authorizeOwner, service: objects }))
    .use(createPageController({ authorizeOwner, service: pages }))
    .use(createPagePublicationPreviewController({ authorizeOwner, service: pages }))
    .use(createPageArchiveController({ authorizeOwner, service: pages }))
    .use(createPageDeletionIntentsController({ authorizeOwner, service: pages }))
    .use(createPageHistoryController({ authorizeOwner, service: pages }))
    .use(createPageVersionDiffController({ authorizeOwner, service: pages }))
    .use(createKnowledgeChangesController({ authorizeOwner, service: pages }))
    .use(createKnowledgeBundleExportIntentsController({ authorizeOwner, service: bundleExports }))
    .use(createKnowledgeBundleStatusController({ authorizeOwner, service: bundleExports }))
    .use(
      createKnowledgeBundleDownloadController({ authorizeOwner, service: bundleExports, storage }),
    )
    .use(createKnowledgeImportsController({ authorizeOwner, service: knowledgeImports }))
    .use(createKnowledgeImportAvailabilityController({ authorizeOwner, service: knowledgeImports }))
    .use(createKnowledgeImportPartController({ authorizeOwner, service: knowledgeImports }))
    .use(createKnowledgeImportValidationController({ authorizeOwner, service: knowledgeImports }))
    .use(createKnowledgeImportStatusController({ authorizeOwner, service: knowledgeImports }));
}
