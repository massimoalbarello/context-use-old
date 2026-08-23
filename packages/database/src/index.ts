export { createPool } from "./pool.ts";
export { runTemplateCommand } from "./template-command.ts";
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
  type KnowledgeDocument,
  type KnowledgeDocumentMetadata,
  type KnowledgeDocumentRevision,
  type KnowledgeRevisionContractProvenance,
} from "./knowledge-documents.ts";
export {
  DocumentAssetRepository,
  type DocumentAssetCreateResult,
  type DocumentAsset,
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
export {
  CorpusMigrationInventoryDriftError,
  CorpusMigrationRepository,
  neutralPublicDirectoryTitle,
  type ApplyCorpusPageInput,
  type ApplyDirectoryHubInput,
  type BeginCorpusMigrationInput,
  type CompleteExistingCorpusItemInput,
  type CorpusDirectoryDisposition,
  type CorpusMigrationBlocker,
  type CorpusMigrationInspection,
  type CorpusMigrationItemKind,
  type CorpusMigrationPhase,
  type CorpusMigrationPlan,
  type CorpusReadyObject,
  type CorpusMigrationStatus,
  type CorpusObjectRef,
  type CorpusPublishedArtifactRef,
  type CorpusPublicAlias,
  type LegacyCorpusAsset,
  type LegacyCorpusDirectory,
  type LegacyCorpusPage,
  type LegacyCorpusRecord,
  type PlannedCorpusAutomation,
  type PlannedCorpusDirectory,
  type PlannedCorpusPage,
  type PlannedObjectWrite,
  type PlannedRevisionRef,
} from "./corpus-migration.ts";
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
  KnowledgeResetRepository,
  type ClearableKnowledgeSummary,
  type ClearedKnowledgeCounts,
  type KnowledgeResetPrincipal,
} from "./knowledge-reset.ts";
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
  AssetArchiveConflictError,
  AssetRepository,
  type AssetArchiveConflictReason,
  type NewAsset,
} from "./assets.ts";
export {
  KnowledgeExportRepository,
  type KnowledgeExportAsset,
  type KnowledgeExportDirectory,
  type KnowledgeExportPage,
  type KnowledgeExportPrincipal,
  type KnowledgeExportSnapshot,
} from "./exports.ts";
export {
  PublicationRepository,
  PublicEntrypointRepository,
  PublicRepository,
  StoragePublicationRepository,
  type PublicPage,
  type PublicKnowledgeSettings,
} from "./publication.ts";
export {
  PathlessPublicEntrypointRepository,
  PathlessPublicRepository,
  PathlessPublicationAdoptionRepository,
  PathlessPublicationRepository,
  PathlessStoragePublicationRepository,
  type PathlessAssetPublicationAdoptionArtifactReceipt,
  type PathlessAssetPublicationAdoptionWriteAuthorization,
  type PathlessAssetPublicationWriteAuthorization,
  type PathlessDashboardPublicationStatus,
  type PathlessPagePublicationAdoptionArtifactReceipt,
  type PathlessPagePublicationAdoptionWriteAuthorization,
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
  type PathlessPublicationAdoption,
  type PathlessPublicationAdoptionCandidate,
  type PathlessPublicationAdoptionArtifactReceipt,
  type PathlessPublicationAdoptionKind,
  type PathlessPublicationAdoptionPhase,
  type PathlessPublicationAdoptionWriteAuthorization,
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
export {
  OperationalDocumentReplacementDriftError,
  OperationalDocumentReplacementRepository,
  type ApplyOperationalDocumentReplacementInput,
  type BeginOperationalDocumentReplacementInput,
  type ManagedOperationalDocument,
  type OperationalAutomationStateTarget,
  type OperationalDocumentReplacementPlan,
  type OperationalDocumentReplacementTarget,
} from "./operational-document-replacements.ts";
