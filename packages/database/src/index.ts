export { createPool } from "./pool.ts";
export {
  HypermediaBootstrapRepository,
  type HypermediaBootstrapAllocation,
  type HypermediaBootstrapDocument,
  type HypermediaBootstrapDocumentKind,
} from "./hypermedia-bootstrap.ts";
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
  type PublishedProjectionPage,
  type PublicProjectionSnapshot,
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
  LegacyPublicationConfirmationIntent,
  PathlessPublicationConfirmationIntent,
  PublicationConfirmationIntent,
  VerifiedPasskey,
} from "./confirmation.ts";
export { PageDeletionRepository } from "./page-deletion.ts";
export type { PageDeletionPrincipal } from "./page-deletion.ts";
export {
  formatTemplateResult,
  knowledgeTemplateBaseline,
  knowledgeTemplateMigrationContract,
  knowledgeTemplatePageContractMatches,
  reconcileKnowledgeTemplate,
  type KnowledgeTemplateBaseline,
  type KnowledgeTemplateMigrationContract,
  type KnowledgeTemplatePageContract,
  type TemplateAction,
  type TemplateRepositories,
  type TemplateResult,
} from "./knowledge-templates.ts";
export {
  DirectoryNotEmptyError,
  DirectoryRepository,
  DirectoryVersionConflictError,
  RootDirectoryDeletionError,
  type DirectoryContents,
} from "./directories.ts";
export {
  PageRepository,
  PublicationStateError,
  VersionConflictError,
  type KnowledgePageChange,
  type KnowledgePageChangeBatch,
  type KnowledgePageChangeKind,
} from "./pages.ts";
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
  extractAssetLinks,
  extractDocumentLinks,
  extractDirectoryLinks,
  extractPageLinks,
  extractWikiLinks,
  mapMarkdownOutsideCode,
  MAX_DOCUMENT_LINKS_PER_REVISION,
  normalizeInternalDocumentLinks,
  normalizeInternalPageLinks,
  wikiLinkCandidatePaths,
  type WikiLink,
} from "./links.ts";
export {
  AutomationRegistryIdentityConflictError,
  AutomationRegistryRepository,
  type AutomationRegistration,
  type RegisterAutomationInput,
} from "./automation-registry.ts";
