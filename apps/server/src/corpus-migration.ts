import {
  MAX_KNOWLEDGE_PAGE_BYTES,
  AutomationRegistryIdentityConflictError,
  CorpusMigrationInventoryDriftError,
  extractDocumentLinks,
  knowledgeTemplatePageContractMatches,
  type AutomationRegistration,
  type CorpusDirectoryDisposition,
  type CorpusMigrationBlocker,
  type CorpusMigrationInspection,
  type CorpusMigrationPlan,
  type CorpusMigrationRepository,
  type CorpusMigrationStatus,
  type CorpusObjectRef,
  type CorpusReadyObject,
  type KnowledgeTemplateMigrationContract,
  type LegacyCorpusAsset,
  type LegacyCorpusDirectory,
  type LegacyCorpusPage,
  type LegacyCorpusRecord,
  type MarkdownObjectMetadata,
  type MarkdownObjectStore,
  type PlannedCorpusDirectory,
  type PlannedCorpusPage,
  type PlannedRevisionRef,
} from "@context-use/database";
import {
  CorpusMigrationObjectError,
  mapInByteBoundedBatches,
} from "./corpus-migration-execution.ts";
import {
  createDirectoryReferenceScanner,
  planDirectoryHubEligibility,
  planLegacyAutomationRegistry,
  renderDirectoryHubMarkdown,
  rewriteCurrentKnowledgeMarkdown,
  type CorpusMigrationLinkIndex,
  type DirectoryHubLink,
} from "./corpus-migration-planner.ts";

const MIGRATION_ACTOR = "context-use-corpus-migration/v1";
const BODY_CONCURRENCY = 4;
const BODY_BYTE_BUDGET = 32 * 1024 * 1024;
const ASSET_VERIFY_CONCURRENCY = 16;
const REQUIRED_DEFAULT_AUTOMATIONS = ["activity-distiller", "diary-composer"] as const;

type DirectoryDisposition = CorpusDirectoryDisposition;
export type CorpusMigrationRepositoryLike = Pick<CorpusMigrationRepository,
  "inspectSource" | "beginOrResume" | "readyObjects" | "status" | "completeExisting" | "applyPage" | "applyHub" | "seal"
>;

export type CorpusAssetVerifier = {
  verify(objectKey: string, sizeBytes: number, contentHash: string): Promise<boolean>;
};

export type CorpusAutomationRegistry = {
  byKey(key: string): Promise<AutomationRegistration | null>;
  register(input: {
    id?: string;
    key: string;
    name: string;
    instructions_document_id: string;
    state_document_id: string | null;
  }): Promise<unknown>;
};

export class CorpusMigrationBlockedError extends Error {
  constructor(readonly blockers: CorpusMigrationBlocker[]) {
    super(`Corpus migration is blocked by ${blockers.length} audited item${blockers.length === 1 ? "" : "s"}`);
    this.name = "CorpusMigrationBlockedError";
  }
}

export type CorpusMigrationReport = {
  status: CorpusMigrationStatus;
  unrecognized_automation_document_ids: string[];
};

function metadata(ref: CorpusObjectRef): MarkdownObjectMetadata {
  return {
    body_object_key: ref.body_object_key,
    body_size_bytes: Number(ref.body_size_bytes),
    body_content_hash: ref.body_content_hash,
  };
}

function activePage(page: LegacyCorpusPage): boolean {
  return page.archived_at === null;
}

function activeAsset(asset: LegacyCorpusAsset): boolean {
  return asset.deleted_at === null;
}

function recordHasBody(record: LegacyCorpusRecord): boolean {
  return record.current_revision !== null;
}

function operationalDirectoryPath(path: string): boolean {
  return path === "automations" || path.startsWith("automations/");
}

function uniqueIds(ids: Array<string | null | undefined>): string[] {
  return [...new Set(ids.filter((id): id is string => Boolean(id)).map((id) => id.toLowerCase()))]
    .sort();
}

function bodyWorkSize(current: CorpusObjectRef, published: CorpusObjectRef | null): number {
  const distinctPublished = published && published.revision_id !== current.revision_id
    ? Number(published.body_size_bytes)
    : 0;
  // Rewriting may retain the source and one same-sized result at once.
  return Number(current.body_size_bytes) * 2 + distinctPublished;
}

async function readDocument(
  bodies: MarkdownObjectStore,
  ref: CorpusObjectRef,
  kind: "knowledge" | "published" | "record",
  documentId: string,
): Promise<string> {
  try {
    return await bodies.read(metadata(ref));
  } catch {
    throw new CorpusMigrationObjectError(kind, documentId, "read");
  }
}

async function writeDocument(
  bodies: MarkdownObjectStore,
  revision: PlannedRevisionRef,
  markdown: string,
  kind: "knowledge" | "published",
  documentId: string,
): Promise<MarkdownObjectMetadata> {
  try {
    const stored = await bodies.write(revision.revision_id, markdown);
    if (stored.body_object_key !== revision.body_object_key) throw new Error("planned object mismatch");
    return stored;
  } catch {
    throw new CorpusMigrationObjectError(kind, documentId, "write");
  }
}

function templateAutomationContracts(template: KnowledgeTemplateMigrationContract) {
  const byPath = new Map(template.pages.map((contract) => [contract.path, contract]));
  const required = new Map<string, {
    instructions: KnowledgeTemplateMigrationContract["pages"][number];
    state: KnowledgeTemplateMigrationContract["pages"][number];
  }>();
  for (const key of REQUIRED_DEFAULT_AUTOMATIONS) {
    const instructionsPath = `automations/${key}/instructions`;
    const statePath = `automations/${key}/state`;
    const instructions = byPath.get(instructionsPath);
    const state = byPath.get(statePath);
    if (!instructions || !state) {
      throw new Error(`Default template contract is incomplete for ${key}`);
    }
    required.set(key, { instructions, state });
  }
  return required;
}

export type ResolvedAutomationRegistration = {
  key: string;
  name: string;
  instructionsDocumentId: string;
  stateDocumentId: string | null;
};

export type ResolvedAutomationPlan = {
  registrations: ResolvedAutomationRegistration[];
  unrecognizedDocumentIds: string[];
};

/**
 * Preserve every already-registered identity, then adopt only the exact
 * historical automations/<key>/instructions convention for keys that do not
 * yet exist. Old path-shaped pages left behind by an ID retarget are ordinary
 * knowledge and deliberately remain in the unrecognized inventory.
 */
export function resolveAutomationPlan(
  inspection: CorpusMigrationInspection,
  activePages: LegacyCorpusPage[],
): ResolvedAutomationPlan {
  const existing = inspection.automation_registrations.map((registration) => ({
    key: registration.key,
    name: registration.name,
    instructionsDocumentId: registration.instructions_document_id.toLowerCase(),
    stateDocumentId: registration.state_document_id?.toLowerCase() ?? null,
  }));
  const existingKeys = new Set(existing.map(({ key }) => key));
  const legacy = planLegacyAutomationRegistry(
    activePages.map((page) => ({
      documentId: page.document_id,
      path: page.path,
      guide: false,
    })),
    inspection.directories.map((directory) => ({ path: directory.path, title: directory.title })),
  );
  const inferred = legacy.registrations.filter(({ key }) => !existingKeys.has(key));
  const registrations = [...existing, ...inferred]
    .sort((left, right) => left.key.localeCompare(right.key, "en"));
  const claimed = new Set(registrations.flatMap((registration) => [
    registration.instructionsDocumentId,
    ...(registration.stateDocumentId ? [registration.stateDocumentId] : []),
  ]).map((id) => id.toLowerCase()));
  return {
    registrations,
    unrecognizedDocumentIds: activePages
      .filter(({ path, document_id }) => path.startsWith("automations/")
        && !claimed.has(document_id.toLowerCase()))
      .map(({ document_id }) => document_id.toLowerCase())
      .sort(),
  };
}

function operationalDocumentIds(
  inspection: CorpusMigrationInspection,
  automations: ResolvedAutomationRegistration[],
): Set<string> {
  return new Set(uniqueIds([
    inspection.global_guide_document_id,
    ...automations.flatMap((registration) => [
      registration.instructionsDocumentId,
      registration.stateDocumentId,
    ]),
  ]));
}

function migrationLinkIndex(
  pages: LegacyCorpusPage[],
  directories: LegacyCorpusDirectory[],
  assets: LegacyCorpusAsset[],
  readableDocumentIds: string[],
  hubDocumentIds?: ReadonlySet<string>,
): CorpusMigrationLinkIndex {
  return {
    pages: pages.filter(activePage).map((page) => ({
      documentId: page.document_id,
      path: page.path,
    })),
    directories: directories.map((directory) => ({
      documentId: directory.directory_id,
      path: directory.path,
      operational: operationalDirectoryPath(directory.path)
        || (hubDocumentIds !== undefined && !hubDocumentIds.has(directory.directory_id.toLowerCase())),
    })),
    publicAssets: assets.filter((asset) => activeAsset(asset) && asset.public_path !== null)
      .map((asset) => ({ documentId: asset.document_id, publicPath: asset.public_path! })),
    documentIds: uniqueIds([
      ...readableDocumentIds,
      ...(hubDocumentIds ?? []),
    ]),
  };
}

function localBlocker(
  code: string,
  itemKind: CorpusMigrationBlocker["item_kind"],
  itemId: string | undefined,
  detail: string,
): CorpusMigrationBlocker {
  return {
    code,
    ...(itemKind ? { item_kind: itemKind } : {}),
    ...(itemId ? { item_id: itemId } : {}),
    detail,
  };
}

function assertHubBodySize(body: string, directoryId: string): void {
  if (Buffer.byteLength(body, "utf8") > MAX_KNOWLEDGE_PAGE_BYTES) {
    throw new CorpusMigrationBlockedError([localBlocker(
      "directory_hub_too_large",
      "directory",
      directoryId,
      "Generated directory hub exceeds the knowledge-page size limit",
    )]);
  }
}

function hubLinks(
  directory: PlannedCorpusDirectory,
  pagesById: Map<string, PlannedCorpusPage>,
  assetsById: Map<string, LegacyCorpusAsset>,
  directoriesById: Map<string, PlannedCorpusDirectory>,
  excludedDocumentIds: ReadonlySet<string>,
): DirectoryHubLink[] {
  const links: DirectoryHubLink[] = [];
  const pageCandidates = directory.direct_page_ids
    .map((id) => pagesById.get(id.toLowerCase()))
    .filter((page): page is PlannedCorpusPage => page !== undefined);
  for (const page of pageCandidates) {
    if (!activePage(page) || excludedDocumentIds.has(page.document_id.toLowerCase())) continue;
    links.push({
      documentId: page.document_id,
      label: page.title,
      summary: page.summary,
      sortKey: page.path,
    });
  }
  for (const id of directory.direct_asset_ids) {
    const asset = assetsById.get(id.toLowerCase());
    if (!asset || !activeAsset(asset)) continue;
    links.push({
      documentId: asset.document_id,
      label: asset.filename,
      summary: null,
      sortKey: asset.path,
    });
  }
  const childCandidates = directory.direct_directory_ids
    .map((id) => directoriesById.get(id.toLowerCase()))
    .filter((child): child is PlannedCorpusDirectory => child !== undefined);
  for (const child of childCandidates) {
    if (!child?.hub) continue;
    links.push({
      documentId: child.hub.document_id,
      label: child.title,
      summary: child.summary,
      sortKey: child.path,
    });
  }
  return links;
}

function directoryDepth(directory: PlannedCorpusDirectory): number {
  return directory.path.split("/").filter(Boolean).length;
}

async function verifyPublishedArtifact(
  verifier: CorpusAssetVerifier,
  page: LegacyCorpusPage,
): Promise<string[]> {
  if (!page.published_artifact) return [];
  let verified = false;
  try {
    verified = await verifier.verify(
      page.published_artifact.body_object_key,
      Number(page.published_artifact.body_size_bytes),
      page.published_artifact.body_content_hash,
    );
  } catch {
    throw new CorpusMigrationObjectError("published", page.document_id, "verify");
  }
  if (!verified) throw new CorpusMigrationObjectError("published", page.document_id, "verify");
  return [page.published_artifact.artifact_id];
}

async function verifyAssetObject(
  verifier: CorpusAssetVerifier,
  asset: LegacyCorpusAsset,
): Promise<void> {
  let verified = false;
  try {
    verified = await verifier.verify(
      asset.object_key,
      Number(asset.size_bytes),
      asset.content_hash,
    );
  } catch {
    throw new CorpusMigrationObjectError("asset", asset.document_id, "verify");
  }
  if (!verified) throw new CorpusMigrationObjectError("asset", asset.document_id, "verify");
}

export type CorpusMigrationInput = {
  repository: CorpusMigrationRepositoryLike;
  bodies: MarkdownObjectStore;
  assets: CorpusAssetVerifier;
  automationRegistry: CorpusAutomationRegistry;
  template: KnowledgeTemplateMigrationContract;
  actorSubject?: string;
};

async function migrateCorpusAttempt(input: CorpusMigrationInput): Promise<CorpusMigrationReport> {
  const actorSubject = input.actorSubject ?? MIGRATION_ACTOR;
  const inspection = await input.repository.inspectSource();
  if (inspection.active_run_id) {
    const activeStatus = await input.repository.seal(inspection.active_run_id);
    if (activeStatus.phase === "superseded") {
      return { status: activeStatus, unrecognized_automation_document_ids: [] };
    }
  }
  const activePages = inspection.pages.filter(activePage);
  const activeAssets = inspection.assets.filter(activeAsset);
  const blockers: CorpusMigrationBlocker[] = [];
  const automationPlan = resolveAutomationPlan(inspection, activePages);
  const operationalIds = operationalDocumentIds(inspection, automationPlan.registrations);
  const defaultContracts = templateAutomationContracts(input.template);
  const automationsByKey = new Map(automationPlan.registrations
    .map((registration) => [registration.key, registration] as const));
  const pagesById = new Map(activePages
    .map((page) => [page.document_id.toLowerCase(), page] as const));
  const contractsByDocumentId = new Map<string,
    KnowledgeTemplateMigrationContract["pages"][number]
  >();

  const rootGuide = inspection.global_guide_document_id
    ? pagesById.get(inspection.global_guide_document_id.toLowerCase())
    : undefined;
  if (!rootGuide || !rootGuide.is_global_guide) {
    blockers.push(localBlocker(
      "global_guide_missing",
      "page",
      inspection.global_guide_document_id ?? undefined,
      "Configured global guide is not active knowledge Markdown",
    ));
  } else {
    contractsByDocumentId.set(rootGuide.document_id.toLowerCase(), input.template.root_guide);
    if (rootGuide.published_revision || rootGuide.public_path) {
      blockers.push(localBlocker(
        "operational_document_published",
        "page",
        rootGuide.document_id,
        "Configured global guide must remain private",
      ));
    }
  }
  for (const page of activePages) {
    if (page.published_revision && !page.published_artifact) {
      blockers.push(localBlocker(
        "published_artifact_missing",
        "page",
        page.document_id,
        "Published page is missing its current public projection artifact",
      ));
    }
  }

  for (const registration of automationPlan.registrations) {
    const instructions = pagesById.get(registration.instructionsDocumentId.toLowerCase());
    const state = registration.stateDocumentId
      ? pagesById.get(registration.stateDocumentId.toLowerCase())
      : null;
    if (!instructions || instructions.published_revision || instructions.public_path
        || (registration.stateDocumentId
          && (!state || state.published_revision || state.public_path))) {
      blockers.push(localBlocker(
        "automation_contract_not_private",
        "page",
        registration.instructionsDocumentId,
        `Automation ${registration.key} must use active private knowledge documents`,
      ));
    }
    const contracts = defaultContracts.get(registration.key);
    if (!contracts) continue;
    if (!state || !registration.stateDocumentId) {
      blockers.push(localBlocker(
        "default_automation_missing",
        "page",
        registration.instructionsDocumentId,
        `Default automation ${registration.key} is missing its required state document`,
      ));
      continue;
    }
    for (const [documentId, contract] of [
      [registration.instructionsDocumentId, contracts.instructions],
      [registration.stateDocumentId, contracts.state],
    ] as const) {
      const normalizedId = documentId.toLowerCase();
      const existing = contractsByDocumentId.get(normalizedId);
      if (existing && existing !== contract) {
        blockers.push(localBlocker(
          "operational_document_identity_reused",
          "page",
          documentId,
          "One knowledge document cannot satisfy multiple operational contracts",
        ));
      } else {
        contractsByDocumentId.set(normalizedId, contract);
      }
    }
  }
  for (const key of REQUIRED_DEFAULT_AUTOMATIONS) {
    if (!automationsByKey.has(key)) {
      blockers.push(localBlocker(
        "default_automation_missing",
        "page",
        undefined,
        `Default automation ${key} is not registered`,
      ));
    }
  }

  const initialIndex = migrationLinkIndex(
    activePages,
    inspection.directories,
    activeAssets,
    inspection.readable_document_ids,
  );
  const scanDirectoryReferences = createDirectoryReferenceScanner(initialIndex);
  const inboundDirectoryIds = new Set<string>();
  const contractMatches = new Map<string, boolean>();
  await mapInByteBoundedBatches(
    activePages.map((page) => ({
      ...page,
      documentId: page.document_id,
      sizeBytes: Number(page.current_revision.body_size_bytes),
    })),
    { concurrency: BODY_CONCURRENCY, maxInFlightBytes: BODY_BYTE_BUDGET },
    async (page) => {
      const body = await readDocument(input.bodies, page.current_revision, "knowledge", page.document_id);
      for (const id of scanDirectoryReferences({ path: page.path, bodyMarkdown: body })) {
        inboundDirectoryIds.add(id);
      }
      const contract = contractsByDocumentId.get(page.document_id.toLowerCase());
      if (contract) {
        contractMatches.set(page.document_id.toLowerCase(), knowledgeTemplatePageContractMatches({
          title: page.title,
          summary: page.summary,
          body_markdown: body,
        }, contract));
      }
    },
  );

  for (const [documentId, contract] of contractsByDocumentId) {
    if (contractMatches.get(documentId) !== true) {
      blockers.push(localBlocker(
        "operational_contract_conflict",
        "page",
        documentId,
        `Required operational document conflicts with the ${contract.management} template contract`,
      ));
    }
  }

  const activePageIds = new Set(activePages.map((page) => page.document_id.toLowerCase()));
  const activeAssetIds = new Set(activeAssets.map((asset) => asset.document_id.toLowerCase()));
  const inspectedPagesById = new Map(inspection.pages
    .map((page) => [page.document_id.toLowerCase(), page] as const));
  const templateDirectories = new Map(input.template.directories.map((directory) => [directory.path, directory]));
  const candidates = inspection.directories.map((directory) => {
    const templateDirectory = templateDirectories.get(directory.path);
    const retainedDirectPages = directory.direct_page_ids.filter((id) => {
      const page = inspectedPagesById.get(id.toLowerCase());
      return activePageIds.has(id.toLowerCase()) && page !== undefined
        && !operationalIds.has(page.document_id.toLowerCase());
    }).length;
    const retainedDirectAssets = directory.direct_asset_ids
      .filter((id) => activeAssetIds.has(id.toLowerCase())).length;
    return {
      documentId: directory.directory_id,
      path: directory.path,
      parentPath: directory.parent_path,
      title: directory.title,
      summary: directory.summary,
      ...(templateDirectory ? {
        templateTitle: templateDirectory.title,
        templateSummary: templateDirectory.summary,
      } : {}),
      retainedDirectDocuments: retainedDirectPages + retainedDirectAssets,
      legacyPublicReachable: directory.legacy_public_reachable,
      hasExistingHub: directory.has_existing_hub,
      operational: operationalDirectoryPath(directory.path),
    };
  });
  const eligibility = planDirectoryHubEligibility(candidates, inboundDirectoryIds);
  if (blockers.length) throw new CorpusMigrationBlockedError(blockers);

  const dispositions = inspection.directories.map((directory) => ({
    directory_id: directory.directory_id,
    disposition: (directory.path === ""
      ? "root_entrypoint"
      : operationalDirectoryPath(directory.path)
        ? directory.legacy_public_reachable || directory.has_existing_hub
          ? "public_compatibility"
          : "operational"
        : eligibility.eligibleDocumentIds.has(directory.directory_id.toLowerCase())
          ? "hub"
          : "retired_template_scaffold") as DirectoryDisposition,
  }));
  const plan = await input.repository.beginOrResume({
    inventory_token: inspection.inventory_token,
    actor_subject: actorSubject,
    directories: dispositions,
    automations: automationPlan.registrations.map((registration) => ({
      key: registration.key,
      name: registration.name,
      instructions_document_id: registration.instructionsDocumentId,
      state_document_id: registration.stateDocumentId,
    })),
  });

  const invalidExistingHubModes = plan.directories.filter((directory) => (
    directory.hub !== null
    && (directory.disposition === "public_compatibility"
      ? ((directory.hub.private_revision_mode === "render" && directory.has_existing_hub)
        || (directory.hub.private_revision_mode === "copy"
          && directory.hub.public_revision_mode !== "render"))
      : ((directory.hub.private_revision_mode === "render"
          && directory.has_existing_hub)
        || (directory.hub.private_revision_mode === "copy"
          && directory.hub.public_revision_mode !== "render")))
  ));
  if (invalidExistingHubModes.length) {
    throw new CorpusMigrationBlockedError(invalidExistingHubModes.map((directory) => localBlocker(
      "existing_hub_regeneration_forbidden",
      "directory",
      directory.directory_id,
      "Directory materialization mode violates the private-body preservation contract",
    )));
  }

  // A sealed run has already consumed its stable source allocations. Reusing
  // those historical snapshots to decide new rewrites would be wrong; seal()
  // instead re-audits the live operational gate and supersedes it on drift.
  if (plan.phase === "ready") {
    const audited = await input.repository.status(plan.run_id);
    if (audited.phase === "superseded") {
      return {
        status: audited,
        unrecognized_automation_document_ids: automationPlan.unrecognizedDocumentIds,
      };
    }
    if (audited.phase !== "ready" || audited.blockers.length) {
      throw new CorpusMigrationBlockedError(audited.blockers.length
        ? audited.blockers
        : [localBlocker(
            "migration_not_ready",
            undefined,
            undefined,
            "Corpus migration did not retain the ready phase",
          )]);
    }
    const readyReadableDocumentIds = new Set(uniqueIds(plan.readable_document_ids));
    // Recheck the exact live current and frozen public-safe knowledge objects
    // on every deploy without replaying link transforms or stable allocations
    // from the completed run. This includes migrated hub revisions and the
    // output of any page rewrite, not the stale source snapshot.
    let readyObjects: CorpusReadyObject[];
    try {
      readyObjects = await input.repository.readyObjects(plan.run_id);
    } catch (error) {
      const afterAudit = await input.repository.status(plan.run_id);
      if (afterAudit.phase === "superseded") {
        return {
          status: afterAudit,
          unrecognized_automation_document_ids: automationPlan.unrecognizedDocumentIds,
        };
      }
      throw error;
    }
    await mapInByteBoundedBatches(
      readyObjects.map((object) => ({
        ...object,
        documentId: object.document_id,
        sizeBytes: Number(object.revision.body_size_bytes),
      })),
      { concurrency: BODY_CONCURRENCY, maxInFlightBytes: BODY_BYTE_BUDGET },
      async (object) => {
        const body = await readDocument(
          input.bodies,
          object.revision,
          object.kind,
          object.document_id,
        );
        const extracted = uniqueIds(extractDocumentLinks(body));
        const indexed = extracted.filter((id) => readyReadableDocumentIds.has(id));
        const extractedAssets = extracted.filter((id) => activeAssetIds.has(id));
        if (JSON.stringify(extracted) !== JSON.stringify(uniqueIds(object.target_document_ids))
            || JSON.stringify(indexed) !== JSON.stringify(uniqueIds(object.indexed_document_ids))
            || JSON.stringify(extractedAssets) !== JSON.stringify(uniqueIds(object.target_asset_ids))) {
          throw new CorpusMigrationBlockedError([localBlocker(
            "ready_link_index_drift",
            "page",
            object.document_id,
            "Ready knowledge body and derived link index differ",
          )]);
        }
      },
    );
    // Pinned public page history is immutable and no longer participates in
    // the live semantic graph, but its exact private Markdown object remains a
    // recovery/publication dependency and must still pass byte verification.
    await mapInByteBoundedBatches(
      activePages
        .filter((page) => page.published_revision
          && page.published_revision.revision_id !== page.current_revision.revision_id)
        .map((page) => ({
          ...page,
          documentId: page.document_id,
          sizeBytes: Number(page.published_revision!.body_size_bytes),
        })),
      { concurrency: BODY_CONCURRENCY, maxInFlightBytes: BODY_BYTE_BUDGET },
      async (page) => {
        await readDocument(input.bodies, page.published_revision!, "published", page.document_id);
      },
    );
    await mapInByteBoundedBatches(
      activePages.map((page) => ({ ...page, documentId: page.document_id, sizeBytes: 1 })),
      { concurrency: ASSET_VERIFY_CONCURRENCY, maxInFlightBytes: ASSET_VERIFY_CONCURRENCY },
      async (page) => { await verifyPublishedArtifact(input.assets, page); },
    );
    await mapInByteBoundedBatches(
      inspection.records.filter(recordHasBody).map((record) => ({
        ...record,
        documentId: record.document_id,
        sizeBytes: Number(record.current_revision!.body_size_bytes),
      })),
      { concurrency: BODY_CONCURRENCY, maxInFlightBytes: BODY_BYTE_BUDGET },
      async (record) => {
        await readDocument(input.bodies, record.current_revision!, "record", record.document_id);
      },
    );
    await mapInByteBoundedBatches(
      activeAssets.map((asset) => ({ ...asset, documentId: asset.document_id, sizeBytes: 1 })),
      { concurrency: ASSET_VERIFY_CONCURRENCY, maxInFlightBytes: ASSET_VERIFY_CONCURRENCY },
      async (asset) => verifyAssetObject(input.assets, asset),
    );
    const status = await input.repository.seal(plan.run_id);
    if (status.phase === "superseded") {
      return {
        status,
        unrecognized_automation_document_ids: automationPlan.unrecognizedDocumentIds,
      };
    }
    if (status.phase !== "ready" || status.blockers.length) {
      throw new CorpusMigrationBlockedError(status.blockers.length
        ? status.blockers
        : [localBlocker(
            "migration_not_ready",
            undefined,
            undefined,
            "Corpus migration did not retain the ready phase",
          )]);
    }
    return {
      status,
      unrecognized_automation_document_ids: automationPlan.unrecognizedDocumentIds,
    };
  }

  const hubIds = new Set(plan.directories
    .filter((directory) => directory.disposition === "hub")
    .map((directory) => directory.directory_id.toLowerCase()));
  const rewriteIndex = migrationLinkIndex(
    plan.pages,
    plan.directories,
    plan.assets,
    plan.readable_document_ids,
    hubIds,
  );

  const plannedPagesById = new Map(plan.pages
    .map((page) => [page.document_id.toLowerCase(), page] as const));
  const plannedAssetsById = new Map(plan.assets
    .map((asset) => [asset.document_id.toLowerCase(), asset] as const));
  const plannedDirectoriesById = new Map(plan.directories
    .map((directory) => [directory.directory_id.toLowerCase(), directory] as const));
  const hubs = plan.directories
    .filter((directory): directory is PlannedCorpusDirectory & { hub: NonNullable<PlannedCorpusDirectory["hub"]> } => (
      directory.hub !== null
    ))
    .sort((left, right) => directoryDepth(right) - directoryDepth(left)
      || left.path.localeCompare(right.path, "en")
      || left.directory_id.localeCompare(right.directory_id, "en"));
  type HubDirectory = typeof hubs[number];
  const renderPrivateHub = (directory: HubDirectory) => {
    return renderDirectoryHubMarkdown({
      title: directory.title,
      summary: directory.summary,
      links: hubLinks(
        directory,
        plannedPagesById,
        plannedAssetsById,
        plannedDirectoriesById,
        operationalIds,
      ),
    });
  };
  const renderPublicHub = (directory: HubDirectory): string => {
    const body = directory.hub.public_body_markdown;
    if (body === null) {
      throw new CorpusMigrationBlockedError([localBlocker(
        "directory_public_body_missing",
        "directory",
        directory.directory_id,
        "Planned public directory projection is unavailable",
      )]);
    }
    return body;
  };
  const renderPrivateBody = (directory: HubDirectory): string => (
    directory.disposition === "public_compatibility"
      ? renderPublicHub(directory)
      : renderPrivateHub(directory)
  );
  const sourceBody = async (
    directory: HubDirectory,
    projection: "private" | "public",
  ): Promise<string> => {
    const source = projection === "private"
      ? directory.hub.private_source_revision
      : directory.hub.public_source_revision;
    if (!source) {
      throw new CorpusMigrationBlockedError([localBlocker(
        "directory_hub_source_missing",
        "directory",
        directory.directory_id,
        `Planned ${projection} hub source revision is unavailable`,
      )]);
    }
    return readDocument(
      input.bodies,
      source,
      projection === "private" ? "knowledge" : "published",
      directory.directory_id,
    );
  };
  const hubBodies = async (directory: HubDirectory) => {
    const privateBody = directory.hub.private_revision_mode === "render"
      ? renderPrivateBody(directory)
      : await sourceBody(directory, "private");
    const publicBody = directory.hub.public_revision_mode === null
      ? null
      : renderPublicHub(directory);
    if (directory.hub.public_revision_mode === "existing" && publicBody !== null) {
      const frozenPublicBody = await sourceBody(directory, "public");
      if (frozenPublicBody !== publicBody) {
        throw new CorpusMigrationBlockedError([localBlocker(
          "directory_public_body_drift",
          "directory",
          directory.directory_id,
          "Frozen public directory projection differs from its deterministic plan",
        )]);
      }
    }
    assertHubBodySize(privateBody, directory.directory_id);
    if (publicBody !== null) assertHubBodySize(publicBody, directory.directory_id);
    return { privateBody, publicBody };
  };
  const hubWork = hubs.map((directory) => {
    const renderedPrivateBytes = directory.hub.private_revision_mode === "render"
      ? Buffer.byteLength(renderPrivateBody(directory), "utf8")
      : Number(directory.hub.private_source_revision?.body_size_bytes ?? 0)
        * (directory.hub.private_revision_mode === "copy" ? 2 : 1);
    const renderedPublicBytes = directory.hub.public_revision_mode === "render"
      ? Buffer.byteLength(renderPublicHub(directory), "utf8")
      : Number(directory.hub.public_source_revision?.body_size_bytes ?? 0);
    return {
      directory,
      documentId: directory.directory_id,
      sizeBytes: renderedPrivateBytes + renderedPublicBytes,
    };
  });
  const storedHubs = new Map<string, {
    privateStored: MarkdownObjectMetadata;
    publicStored: MarkdownObjectMetadata | null;
  }>();

  // Materialize every immutable hub object before mutating the graph. This
  // makes retries S3-first and ensures no database row can point at bytes that
  // were not durably written.
  await mapInByteBoundedBatches(
    hubWork,
    { concurrency: BODY_CONCURRENCY, maxInFlightBytes: BODY_BYTE_BUDGET },
    async ({ directory }) => {
      const { privateBody, publicBody } = await hubBodies(directory);
      const privateStored = directory.hub.private_revision_mode === "existing"
        ? metadata(directory.hub.private_source_revision!)
        : await writeDocument(
            input.bodies,
            directory.hub.private_revision,
            privateBody,
            "knowledge",
            directory.directory_id,
          );
      const publicStored = publicBody === null || !directory.hub.public_revision
        ? null
        : directory.hub.public_revision_mode === "existing"
          ? metadata(directory.hub.public_source_revision!)
          : await writeDocument(
              input.bodies,
              directory.hub.public_revision,
              publicBody,
              "published",
              directory.directory_id,
            );
      storedHubs.set(directory.directory_id.toLowerCase(), { privateStored, publicStored });
    },
  );

  const applyHub = async ({ directory }: typeof hubWork[number]) => {
    const stored = storedHubs.get(directory.directory_id.toLowerCase());
    if (!stored) throw new CorpusMigrationObjectError("knowledge", directory.directory_id, "write");
    const { privateBody, publicBody } = await hubBodies(directory);
    await input.repository.applyHub({
      run_id: plan.run_id,
      directory_id: directory.directory_id,
      private_revision: {
        id: directory.hub.private_revision.revision_id,
        ...stored.privateStored,
        body_markdown_for_index: privateBody,
        target_document_ids: extractDocumentLinks(privateBody),
      },
      public_revision: publicBody === null || !directory.hub.public_revision || !stored.publicStored
        ? null
        : {
            id: directory.hub.public_revision.revision_id,
            ...stored.publicStored,
            body_markdown_for_index: publicBody,
            target_document_ids: extractDocumentLinks(publicBody),
          },
      actor_subject: actorSubject,
    });
  };

  const applyHubsChildFirst = async (work: typeof hubWork) => {
    for (const depth of [...new Set(work.map(({ directory }) => directoryDepth(directory)))]
      .sort((a, b) => b - a)) {
      const atDepth = work.filter(({ directory }) => directoryDepth(directory) === depth);
      await mapInByteBoundedBatches(
        atDepth,
        { concurrency: BODY_CONCURRENCY, maxInFlightBytes: BODY_BYTE_BUDGET },
        applyHub,
      );
    }
  };

  // First create every genuinely new document identity child-first. Existing
  // owner-authored hubs may link anywhere in that new graph, so process them
  // only after all new identities exist. Existing parents are still ordered
  // behind existing children: a copy/render pair gaining public reachability
  // needs the child's public resource before the parent can index its link.
  await applyHubsChildFirst(hubWork.filter(({ directory }) => !directory.has_existing_hub));
  await applyHubsChildFirst(hubWork.filter(({ directory }) => directory.has_existing_hub));

  // Hub identities now exist, so page-to-hub links can be indexed exactly.
  await mapInByteBoundedBatches(
    plan.pages.filter(activePage).map((page) => ({
      ...page,
      documentId: page.document_id,
      sizeBytes: bodyWorkSize(page.current_revision, page.published_revision),
    })),
    { concurrency: BODY_CONCURRENCY, maxInFlightBytes: BODY_BYTE_BUDGET },
    async (page) => {
      const currentBody = await readDocument(input.bodies, page.current_revision, "knowledge", page.document_id);
      if (page.published_revision
          && page.published_revision.revision_id !== page.current_revision.revision_id) {
        await readDocument(input.bodies, page.published_revision, "published", page.document_id);
      }
      const verified = uniqueIds([
        page.current_revision.revision_id,
        page.published_revision?.revision_id,
      ]);
      const verifiedArtifacts = await verifyPublishedArtifact(input.assets, page);
      const rewritten = rewriteCurrentKnowledgeMarkdown(currentBody, page.path, rewriteIndex);
      if (rewritten === currentBody) {
        await input.repository.completeExisting({
          run_id: plan.run_id,
          item_kind: "page",
          item_id: page.document_id,
          verified_revision_ids: verified,
          verified_public_artifact_ids: verifiedArtifacts,
          body_markdown_for_index: rewritten,
          target_document_ids: extractDocumentLinks(rewritten),
          actor_subject: actorSubject,
        });
        return;
      }
      if (!page.rewrite_revision) {
        throw new CorpusMigrationBlockedError([localBlocker(
          "page_rewrite_not_planned",
          "page",
          page.document_id,
          "A required current-page rewrite has no stable migration allocation",
        )]);
      }
      const stored = await writeDocument(
        input.bodies,
        page.rewrite_revision,
        rewritten,
        "knowledge",
        page.document_id,
      );
      await input.repository.applyPage({
        run_id: plan.run_id,
        document_id: page.document_id,
        source_revision_id: page.current_revision.revision_id,
        verified_source_revision_ids: verified,
        verified_public_artifact_ids: verifiedArtifacts,
        revision: { id: page.rewrite_revision.revision_id, ...stored },
        body_markdown_for_index: rewritten,
        target_document_ids: extractDocumentLinks(rewritten),
        actor_subject: actorSubject,
      });
    },
  );

  await mapInByteBoundedBatches(
    plan.records.map((record) => ({
      ...record,
      documentId: record.document_id,
      sizeBytes: Number(record.current_revision?.body_size_bytes ?? 0),
    })),
    { concurrency: BODY_CONCURRENCY, maxInFlightBytes: BODY_BYTE_BUDGET },
    async (record) => {
      if (record.current_revision) {
        await readDocument(input.bodies, record.current_revision, "record", record.document_id);
      }
      await input.repository.completeExisting({
        run_id: plan.run_id,
        item_kind: "record",
        item_id: record.document_id,
        verified_revision_ids: record.current_revision ? [record.current_revision.revision_id] : [],
        verified_public_artifact_ids: [],
        actor_subject: actorSubject,
      });
    },
  );

  await mapInByteBoundedBatches(
    plan.assets.filter(activeAsset).map((asset) => ({
      ...asset,
      documentId: asset.document_id,
      sizeBytes: 1,
    })),
    { concurrency: ASSET_VERIFY_CONCURRENCY, maxInFlightBytes: ASSET_VERIFY_CONCURRENCY },
    async (asset) => {
      await verifyAssetObject(input.assets, asset);
      await input.repository.completeExisting({
        run_id: plan.run_id,
        item_kind: "asset",
        item_id: asset.document_id,
        verified_revision_ids: [],
        verified_public_artifact_ids: [],
        actor_subject: actorSubject,
      });
    },
  );

  for (const automation of plan.automations) {
    try {
      const live = await input.automationRegistry.byKey(automation.key);
      if (live) {
        if (live.id === automation.id
            && live.instructions_document_id === automation.instructions_document_id
            && live.state_document_id === automation.state_document_id) {
          // Name and disabled_at are owner state. A live identity match needs
          // no write and must not replay stale presentation from the plan.
          continue;
        }
        throw new AutomationRegistryIdentityConflictError(automation.key);
      }
      await input.automationRegistry.register({
        id: automation.id,
        key: automation.key,
        name: automation.name,
        instructions_document_id: automation.instructions_document_id,
        state_document_id: automation.state_document_id,
      });
    } catch (error) {
      if (!(error instanceof AutomationRegistryIdentityConflictError)) throw error;
      throw new CorpusMigrationBlockedError([localBlocker(
        "automation_registry_identity_conflict",
        undefined,
        undefined,
        `Automation registry identity conflicts for key ${error.key}`,
      )]);
    }
  }

  const status = await input.repository.seal(plan.run_id);
  if (status.phase === "superseded") {
    return {
      status,
      unrecognized_automation_document_ids: automationPlan.unrecognizedDocumentIds,
    };
  }
  if (status.phase !== "ready" || status.blockers.length) {
    throw new CorpusMigrationBlockedError(status.blockers.length
      ? status.blockers
      : [localBlocker(
          "migration_not_ready",
          undefined,
          undefined,
          "Corpus migration did not reach the ready phase",
        )]);
  }
  return {
    status,
    unrecognized_automation_document_ids: automationPlan.unrecognizedDocumentIds,
  };
}

/**
 * A live corpus can drift between inspection and seal. The database marks that
 * audited snapshot superseded; retry from a fresh inventory instead of
 * continuing to apply its stale stable allocations.
 */
export async function migrateCorpusToHypermedia(
  input: CorpusMigrationInput,
): Promise<CorpusMigrationReport> {
  let superseded: CorpusMigrationReport | null = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const report = await migrateCorpusAttempt(input);
      if (report.status.phase !== "superseded") return report;
      superseded = report;
    } catch (error) {
      // Only the database's explicit, committed inventory-drift signal is
      // retryable. Storage and transient failures leave the applying run in
      // place and must remain resumable without allocating a fresh snapshot.
      if (!(error instanceof CorpusMigrationInventoryDriftError)) throw error;
    }
  }
  throw new CorpusMigrationBlockedError([
    ...(superseded?.status.blockers ?? []),
    localBlocker(
      "migration_retry_exhausted",
      undefined,
      undefined,
      "Corpus changed repeatedly while preparing the hypermedia cutover; rerun preparation",
    ),
  ]);
}
