import { Elysia } from "elysia";
import type { AuthorizeOwner } from "#private/auth/dashboard-owner-authorizer.ts";
import type { DashboardAssetsService } from "#private/services/dashboard/assets-service.ts";
import type { DashboardMetadataService } from "#private/services/dashboard/metadata-service.ts";
import type { DashboardObjectsService } from "#private/services/dashboard/objects-service.ts";
import type { PageDeletionService } from "#private/services/dashboard/page-deletion-service.ts";
import type { PageHistoryService } from "#private/services/dashboard/page-history-service.ts";
import type { PageMutationsService } from "#private/services/dashboard/page-mutations-service.ts";
import type { PagePublicationPreviewService } from "#private/services/dashboard/page-publication-preview-service.ts";
import type { DashboardPublicationService } from "#private/services/dashboard/publication-service.ts";
import type { DashboardWebService } from "#private/services/dashboard/web-service.ts";
import type { PrivateStorageBroker } from "#storage/client/contracts.ts";
import { createDashboardWebController } from "../../app/controller.ts";
import { createDashboardHealthController } from "../health/controller.ts";
import { createAssetController } from "./assets/[assetId]/controller.ts";
import { createAssetsController } from "./assets/controller.ts";
import { createAutomationsController } from "./automations/controller.ts";
import { createKnowledgeChangesController } from "./knowledge-changes/controller.ts";
import { createDashboardMetadataController } from "./metadata/controller.ts";
import { createObjectController } from "./objects/[objectId]/controller.ts";
import { createObjectNeighborhoodController } from "./objects/[objectId]/neighborhood/controller.ts";
import { createObjectsController } from "./objects/controller.ts";
import { createPageArchiveController } from "./pages/[pageId]/archive/controller.ts";
import { createPageController } from "./pages/[pageId]/controller.ts";
import { createPageDeletionIntentsController } from "./pages/[pageId]/deletion-intents/controller.ts";
import { createPageHistoryController } from "./pages/[pageId]/history/controller.ts";
import { createPagePublicationPreviewController } from "./pages/[pageId]/publication-preview/controller.ts";
import { createPageVersionDiffController } from "./pages/[pageId]/versions/[version]/diff/controller.ts";
import { createPublicationEntrypointController } from "./publication-entrypoint/controller.ts";
import { createPublicationIntentsController } from "./publication-intents/controller.ts";
import { createSourceRecordArchiveController } from "./source-records/[objectId]/archive/controller.ts";
import { createSourceRecordController } from "./source-records/[objectId]/controller.ts";

export function createDashboardController({
  authorizeOwner,
  assets,
  metadata,
  objects,
  pageDeletion,
  pageHistory,
  pageMutations,
  pagePublicationPreview,
  publication,
  storage,
  securityHeaders,
  web,
}: {
  authorizeOwner: AuthorizeOwner;
  assets: DashboardAssetsService;
  metadata: DashboardMetadataService;
  objects: DashboardObjectsService;
  pageDeletion: PageDeletionService;
  pageHistory: PageHistoryService;
  pageMutations: PageMutationsService;
  pagePublicationPreview: PagePublicationPreviewService;
  publication: DashboardPublicationService;
  storage: Pick<PrivateStorageBroker, "read">;
  securityHeaders: Record<string, string>;
  web: DashboardWebService;
}) {
  return new Elysia()
    .use(createDashboardHealthController({ service: metadata }))
    .use(createDashboardMetadataController({ authorizeOwner, service: metadata }))
    .use(createDashboardWebController({ service: web, securityHeaders }))
    .use(createPublicationIntentsController({ authorizeOwner, service: publication }))
    .use(createPublicationEntrypointController({ authorizeOwner, service: publication }))
    .use(createAssetsController({ authorizeOwner, service: assets }))
    .use(createAssetController({ authorizeOwner, service: assets, storage }))
    .use(createObjectsController({ authorizeOwner, objects, pages: pageMutations }))
    .use(createObjectController({ authorizeOwner, service: objects }))
    .use(createObjectNeighborhoodController({ authorizeOwner, service: objects }))
    .use(createAutomationsController({ authorizeOwner, service: objects }))
    .use(createSourceRecordController({ authorizeOwner, service: objects }))
    .use(createSourceRecordArchiveController({ authorizeOwner, service: objects }))
    .use(createPageController({ authorizeOwner, service: pageMutations }))
    .use(
      createPagePublicationPreviewController({
        authorizeOwner,
        service: pagePublicationPreview,
      }),
    )
    .use(createPageArchiveController({ authorizeOwner, service: pageMutations }))
    .use(createPageDeletionIntentsController({ authorizeOwner, service: pageDeletion }))
    .use(createPageHistoryController({ authorizeOwner, service: pageHistory }))
    .use(createPageVersionDiffController({ authorizeOwner, service: pageHistory }))
    .use(createKnowledgeChangesController({ authorizeOwner, service: pageHistory }));
}
