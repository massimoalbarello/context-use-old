export { createPool } from "./pool.ts";
export {
  HypermediaBootstrapRepository,
  type HypermediaBootstrapAllocation,
  type HypermediaBootstrapDocument,
  type HypermediaBootstrapDocumentKind,
} from "./hypermedia-bootstrap.ts";
export {
  defaultHypermediaBootstrapTemplate,
  type HypermediaBootstrapTemplate,
  type HypermediaBootstrapTemplateDocument,
} from "./default-knowledge-template.ts";
export {
  assertMarkdownObject,
  MAX_KNOWLEDGE_PAGE_BYTES,
  MAX_MARKDOWN_DOCUMENT_BYTES,
  mapConcurrently,
  markdownObjectMetadata,
  type MarkdownObjectMetadata,
  type MarkdownObjectStore,
} from "./documents.ts";
export {
  DocumentMaintenanceRepository,
  type UnindexedDocumentRevision,
} from "./document-maintenance.ts";
export {
  DocumentLinkRepository,
  type DocumentBacklink,
  type DocumentBacklinkPage,
  type DocumentLinkIndex,
} from "./document-links.ts";
export {
  GenericDocumentLinkContractError,
  assertGenericDocumentLinksOnly,
  genericDocumentTargets,
} from "./document-link-contract.ts";
export {
  KnowledgeDocumentRepository,
  type AdoptKnowledgeRevisionInput,
  type KnowledgeDocumentChange,
  type KnowledgeDocumentChangeBatch,
  type KnowledgeDocumentChangeKind,
  type KnowledgeDocument,
  type KnowledgeDocumentMetadata,
  type KnowledgeDocumentRevision,
  type KnowledgeRevisionContractProvenance,
} from "./knowledge-documents.ts";
export {
  AssetArchiveConflictError,
  DocumentAssetRepository,
  type AssetArchiveConflictReason,
  type DocumentAssetCreateResult,
  type DocumentAsset,
  type DocumentAssetStorageObject,
} from "./document-assets.ts";
export {
  InvalidPrivateDocumentCursorError,
  PrivateDocumentCatalogRepository,
  type PrivateDocumentCatalogFilters,
  type PrivateDocumentCatalogItem,
  type PrivateDocumentCatalogPage,
  type PrivateDocumentKind,
  type PrivateDocumentLifecycle,
  type PrivateDocumentNeighbor,
  type PrivateDocumentNeighborhood,
  type PrivateDocumentOperationalRole,
} from "./document-catalog.ts";
export {
  KnowledgeSettingsRepository,
  type GlobalKnowledgeGuideMetadata,
  type KnowledgeSettings,
} from "./knowledge-settings.ts";
export {
  PublicResourceRepository,
  type PublicResource,
  type PublishedPublicResource,
  type PublishedRouteAlias,
} from "./public-resources.ts";
export {
  SourceRecordRepository,
  type SourceRecordDocument,
  type SourceRecordIdentity,
  type SourceRecordMetadata,
  type SourceRecordWrite,
  type SourceRecordWriter,
} from "./source-records.ts";
export { ConfirmationRepository } from "./confirmation.ts";
export type {
  ConfirmationIntentKind,
  ConfirmationPasskey,
  PublicationConfirmationIntent,
  VerifiedPasskey,
} from "./confirmation.ts";
export { PageDeletionRepository } from "./page-deletion.ts";
export type { PageDeletionPrincipal } from "./page-deletion.ts";
export {
  PublicationStateError,
  VersionConflictError,
} from "./knowledge-documents.ts";
export {
  KnowledgeExportRepository,
  type KnowledgeExportAsset,
  type KnowledgeExportLink,
  type KnowledgeExportPage,
  type KnowledgeExportPrincipal,
  type KnowledgeExportSnapshot,
} from "./exports.ts";
export {
  PathlessPublicEntrypointRepository,
  PathlessPublicRepository,
  PathlessPublicationRepository,
  PathlessStoragePublicationRepository,
  type PathlessAssetPublicationWriteAuthorization,
  type PathlessDashboardPublicationStatus,
  type PathlessPagePublicationWriteAuthorization,
  type PathlessPublicActiveAssetRoute,
  type PathlessPublicActivePageRoute,
  type PathlessPublicAsset,
  type PathlessPublicInactiveRoute,
  type PathlessPublicPage,
  type PathlessPublicRouteKind,
  type PathlessPublicRouteResolution,
  type PathlessPublicUnassignedRoute,
  type PathlessPublicUnavailableRoute,
  type PathlessPublicationEntrypoint,
  type PathlessPublicationEntrypointCandidate,
  type PathlessPublicationIntent,
  type PathlessPublicationObjectClaim,
  type PathlessPublicationPrincipal,
  type PathlessPublicationProjectionOutcome,
  type PathlessPublicationProjectionTarget,
  type PathlessPublicationWriteAuthorization,
  type PathlessStorageRoute,
} from "./pathless-publication.ts";
export {
  extractDocumentLinks,
  MAX_DOCUMENT_LINKS_PER_REVISION,
} from "./links.ts";
export {
  AutomationRegistryIdentityConflictError,
  AutomationRegistryRepository,
  type AutomationRegistration,
  type RegisterAutomationInput,
} from "./automation-registry.ts";
