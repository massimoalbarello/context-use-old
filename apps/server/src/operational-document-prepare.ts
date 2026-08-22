import {
  AutomationRegistryIdentityConflictError,
  OperationalDocumentReplacementDriftError,
  VersionConflictError,
  extractDocumentLinks,
  knowledgeTemplatePageContractMatches,
  markdownObjectMetadata,
  type AutomationRegistration,
  type AutomationRegistryRepository,
  type KnowledgeSettingsRepository,
  type KnowledgeTemplateMigrationContract,
  type KnowledgeTemplatePageContract,
  type MarkdownObjectMetadata,
  type MarkdownObjectStore,
  type OperationalDocumentReplacementPlan,
  type OperationalDocumentReplacementRepository,
  type OperationalDocumentReplacementTarget,
  type PageRepository,
} from "@context-use/database";
import { CorpusMigrationBlockedError } from "./corpus-migration.ts";
import type { ResolvedAutomationRegistration } from "./corpus-migration.ts";
import { CorpusMigrationObjectError } from "./corpus-migration-execution.ts";

const DEFAULT_AUTOMATION_KEYS = ["activity-distiller", "diary-composer"] as const;
const TEMPLATE_ACTOR_PREFIX = "context-use-template/";
const CUSTOM_AUTOMATION_ACTOR = "context-use-operational-migration/v1";
const LEGACY_BOOTSTRAP_ACTOR = "context-use-bootstrap";
const METADATA_REVISION_ID = "00000000-0000-4000-8000-000000000000";
const OPERATIONAL_RETRY_LIMIT = 3;

type OperationalPage = {
  id: string;
  current_path: string;
  current_version_id: string;
  published_version_id: string | null;
  public_path: string | null;
  archived_at: Date | string | null;
  version_number: number;
  title: string;
  summary: string;
  body_markdown: string;
};

type OperationalPageMetadata = Omit<OperationalPage, "body_markdown">;

export type OperationalDocumentPreparationRepositories = {
  settings: Pick<KnowledgeSettingsRepository, "get">;
  pages: Pick<PageRepository,
    "get" | "getByPath" | "metadata" | "metadataByPath" | "version" | "update"
  >;
  registry: Pick<AutomationRegistryRepository, "byKey" | "register">;
  replacements: Pick<OperationalDocumentReplacementRepository, "beginOrResume" | "apply">;
};

type DefaultAutomationContract = {
  key: typeof DEFAULT_AUTOMATION_KEYS[number];
  name: string;
  instructions: KnowledgeTemplatePageContract;
  state: KnowledgeTemplatePageContract;
};

class OperationalPreparationDriftError extends Error {}

function blocker(code: string, itemId: string | undefined, detail: string): never {
  throw new CorpusMigrationBlockedError([{
    code,
    item_kind: "page",
    ...(itemId ? { item_id: itemId } : {}),
    detail,
  }]);
}

function activePage(value: unknown): OperationalPage | null {
  if (!value || typeof value !== "object") return null;
  const page = value as Partial<OperationalPage>;
  return typeof page.id === "string"
    && typeof page.current_path === "string"
    && typeof page.current_version_id === "string"
    && typeof page.version_number === "number"
    && typeof page.title === "string"
    && typeof page.summary === "string"
    && typeof page.body_markdown === "string"
    && page.archived_at == null
    ? page as OperationalPage
    : null;
}

function pageMetadata(value: unknown): OperationalPageMetadata | null {
  if (!value || typeof value !== "object") return null;
  const page = value as Partial<OperationalPageMetadata>;
  return typeof page.id === "string" && typeof page.current_path === "string"
    ? page as OperationalPageMetadata
    : null;
}

function privatePage(page: OperationalPage): boolean {
  return page.published_version_id == null && page.public_path == null;
}

function templateOwns(actorSubject: unknown, templateName: string): boolean {
  return actorSubject === `${TEMPLATE_ACTOR_PREFIX}${templateName}`
    || actorSubject === LEGACY_BOOTSTRAP_ACTOR;
}

function managedMetadata(markdown: string): Pick<MarkdownObjectMetadata,
  "body_size_bytes" | "body_content_hash"
> {
  const { body_size_bytes, body_content_hash } = markdownObjectMetadata(
    METADATA_REVISION_ID,
    markdown,
  );
  return { body_size_bytes, body_content_hash };
}

function defaultAutomationContracts(
  template: KnowledgeTemplateMigrationContract,
): DefaultAutomationContract[] {
  const pages = new Map(template.pages.map((contract) => [contract.path, contract]));
  const directories = new Map(template.directories.map((directory) => [directory.path, directory]));
  return DEFAULT_AUTOMATION_KEYS.map((key) => {
    const instructions = pages.get(`automations/${key}/instructions`);
    const state = pages.get(`automations/${key}/state`);
    const directory = directories.get(`automations/${key}`);
    if (!instructions || instructions.management !== "managed"
        || !state || state.management !== "create-only" || !directory) {
      throw new Error(`Default template operational contract is incomplete for ${key}`);
    }
    return { key, name: directory.title, instructions, state };
  });
}

async function currentActor(
  pages: OperationalDocumentPreparationRepositories["pages"],
  page: OperationalPage,
): Promise<unknown> {
  const version = await pages.version(page.id, page.version_number) as {
    actor_subject?: unknown;
  } | null;
  return version?.actor_subject;
}

async function writePlannedObject(
  bodies: MarkdownObjectStore,
  revision: { revision_id: string; body_object_key: string },
  markdown: string,
  expected: { body_size_bytes: number; body_content_hash: string },
  documentId: string,
): Promise<MarkdownObjectMetadata> {
  try {
    const stored = await bodies.write(revision.revision_id, markdown);
    if (stored.body_object_key !== revision.body_object_key
        || stored.body_size_bytes !== expected.body_size_bytes
        || stored.body_content_hash !== expected.body_content_hash) {
      throw new Error("planned object mismatch");
    }
    return stored;
  } catch {
    throw new CorpusMigrationObjectError("knowledge", documentId, "write");
  }
}

async function applyReplacement(input: {
  repositories: OperationalDocumentPreparationRepositories;
  bodies: MarkdownObjectStore;
  target: OperationalDocumentReplacementTarget;
  source: OperationalPage;
  contract: KnowledgeTemplatePageContract;
  actorSubject: string;
  stateClone?: { source: OperationalPage; markdown: string };
}): Promise<OperationalDocumentReplacementPlan> {
  const managed = {
    title: input.contract.title,
    summary: input.contract.summary,
    ...managedMetadata(input.contract.body_markdown),
  };
  const plan = await input.repositories.replacements.beginOrResume({
    target: input.target,
    source_document_id: input.source.id,
    source_revision_id: input.source.current_version_id,
    managed,
    actor_subject: input.actorSubject,
  });
  const stored = await writePlannedObject(
    input.bodies,
    plan.replacement_revision,
    input.contract.body_markdown,
    managed,
    plan.replacement_document_id,
  );
  let agentsOccupantPreservation: Parameters<
    OperationalDocumentPreparationRepositories["replacements"]["apply"]
  >[0]["agents_occupant_preservation"];
  if (plan.agents_occupant_preservation) {
    const occupant = plan.agents_occupant_preservation.document_id === input.source.id
      ? input.source
      : activePage(await input.repositories.pages.get(
        plan.agents_occupant_preservation.document_id,
      ));
    if (!occupant
        || occupant.current_path !== "agents"
        || occupant.current_version_id
          !== plan.agents_occupant_preservation.source_revision_id) {
      throw new OperationalPreparationDriftError();
    }
    const expected = managedMetadata(occupant.body_markdown);
    if (input.target.kind !== "global_guide"
        || plan.agents_occupant_preservation.title !== occupant.title
        || plan.agents_occupant_preservation.summary !== occupant.summary
        || plan.agents_occupant_preservation.body_size_bytes !== expected.body_size_bytes
        || plan.agents_occupant_preservation.body_content_hash !== expected.body_content_hash) {
      throw new OperationalPreparationDriftError();
    }
    const preserved = await writePlannedObject(
      input.bodies,
      plan.agents_occupant_preservation.revision,
      occupant.body_markdown,
      expected,
      occupant.id,
    );
    agentsOccupantPreservation = {
      revision: {
        id: plan.agents_occupant_preservation.revision.revision_id,
        ...preserved,
      },
      body_markdown_for_index: occupant.body_markdown,
      target_document_ids: extractDocumentLinks(occupant.body_markdown),
    };
  }
  let stateClone: Parameters<OperationalDocumentPreparationRepositories["replacements"]["apply"]>[0]["state_clone"];
  if (plan.state?.mode === "clone") {
    const source = input.stateClone?.source;
    const markdown = input.stateClone?.markdown;
    if (!source || markdown === undefined
        || source.id !== plan.state.source_document_id
        || source.current_version_id !== plan.state.source_revision_id) {
      throw new OperationalPreparationDriftError();
    }
    const stateExpected = managedMetadata(markdown);
    if (stateExpected.body_size_bytes !== plan.state.body_size_bytes
        || stateExpected.body_content_hash !== plan.state.body_content_hash) {
      throw new OperationalPreparationDriftError();
    }
    const stateStored = await writePlannedObject(
      input.bodies,
      plan.state.replacement_revision,
      markdown,
      stateExpected,
      plan.state.replacement_document_id,
    );
    stateClone = {
      revision: { id: plan.state.replacement_revision.revision_id, ...stateStored },
      body_markdown_for_index: markdown,
      target_document_ids: extractDocumentLinks(markdown),
    };
  } else if (input.stateClone) {
    throw new OperationalPreparationDriftError();
  }
  return input.repositories.replacements.apply({
    replacement_id: plan.replacement_id,
    revision: { id: plan.replacement_revision.revision_id, ...stored },
    body_markdown_for_index: input.contract.body_markdown,
    target_document_ids: extractDocumentLinks(input.contract.body_markdown),
    ...(agentsOccupantPreservation
      ? { agents_occupant_preservation: agentsOccupantPreservation }
      : {}),
    ...(stateClone ? { state_clone: stateClone } : {}),
  });
}

async function updateManagedInPlace(input: {
  pages: OperationalDocumentPreparationRepositories["pages"];
  page: OperationalPage;
  contract: KnowledgeTemplatePageContract;
  actorSubject: string;
}): Promise<void> {
  const updated = await input.pages.update(input.page.id, {
    path: input.page.current_path,
    title: input.contract.title,
    summary: input.contract.summary,
    body_markdown: input.contract.body_markdown,
    commit_message: "Update managed operational document",
    expected_version_number: input.page.version_number,
  }, { kind: "dashboard", subject: input.actorSubject });
  if (!updated) throw new OperationalPreparationDriftError();
}

async function reconcileGlobalGuide(input: {
  repositories: OperationalDocumentPreparationRepositories;
  bodies: MarkdownObjectStore;
  template: KnowledgeTemplateMigrationContract;
  actorSubject: string;
}): Promise<void> {
  const settings = await input.repositories.settings.get();
  if (!settings.global_guide_document_id) {
    blocker("global_guide_missing", undefined, "Configured global guide is missing");
  }
  const guide = activePage(await input.repositories.pages.get(settings.global_guide_document_id));
  if (!guide) {
    blocker(
      "global_guide_missing",
      settings.global_guide_document_id,
      "Configured global guide is not active knowledge Markdown",
    );
  }
  const actor = await currentActor(input.repositories.pages, guide);
  const managed = templateOwns(actor, input.template.template);
  const matches = knowledgeTemplatePageContractMatches(guide, input.template.root_guide);
  if (managed && privatePage(guide) && guide.current_path === "agents") {
    if (!matches) {
      await updateManagedInPlace({
        pages: input.repositories.pages,
        page: guide,
        contract: input.template.root_guide,
        actorSubject: input.actorSubject,
      });
    }
    return;
  }
  await applyReplacement({
    repositories: input.repositories,
    bodies: input.bodies,
    target: { kind: "global_guide" },
    source: guide,
    contract: input.template.root_guide,
    actorSubject: input.actorSubject,
  });
}

async function registerAutomation(
  registry: OperationalDocumentPreparationRepositories["registry"],
  contract: DefaultAutomationContract,
  registration: AutomationRegistration | null,
  instructionsDocumentId: string,
  stateDocumentId: string | null,
): Promise<void> {
  await registry.register({
    ...(registration ? { id: registration.id } : {}),
    key: contract.key,
    name: registration?.name ?? contract.name,
    instructions_document_id: instructionsDocumentId,
    state_document_id: stateDocumentId,
  });
}

function exactPageContract(page: OperationalPage): KnowledgeTemplatePageContract {
  return {
    path: page.current_path,
    title: page.title,
    summary: page.summary,
    body_markdown: page.body_markdown,
    management: "managed",
  };
}

async function reconcileCustomAutomation(input: {
  repositories: OperationalDocumentPreparationRepositories;
  bodies: MarkdownObjectStore;
  candidate: ResolvedAutomationRegistration;
}): Promise<void> {
  const live = await input.repositories.registry.byKey(input.candidate.key);
  const instructionsDocumentId = live?.instructions_document_id
    ?? input.candidate.instructionsDocumentId;
  const stateDocumentId = live?.state_document_id ?? input.candidate.stateDocumentId;
  const instructions = activePage(await input.repositories.pages.get(instructionsDocumentId));
  const state = stateDocumentId
    ? activePage(await input.repositories.pages.get(stateDocumentId))
    : null;
  if (!instructions) {
    blocker(
      "automation_instructions_missing",
      instructionsDocumentId,
      `Automation ${input.candidate.key} has no active instruction document`,
    );
  }
  if (stateDocumentId && !state) {
    blocker(
      "automation_state_missing",
      stateDocumentId,
      `Automation ${input.candidate.key} has no active state document`,
    );
  }
  if (privatePage(instructions) && (!state || privatePage(state))) {
    if (!live) {
      await input.repositories.registry.register({
        key: input.candidate.key,
        name: input.candidate.name,
        instructions_document_id: instructions.id,
        state_document_id: state?.id ?? null,
      });
    }
    return;
  }

  const cloneState = state !== null && !privatePage(state);
  const stateMetadata = cloneState ? managedMetadata(state.body_markdown) : null;
  await applyReplacement({
    repositories: input.repositories,
    bodies: input.bodies,
    target: {
      kind: "automation_instructions",
      key: input.candidate.key,
      name: live?.name ?? input.candidate.name,
      state: cloneState ? {
        mode: "clone",
        source_document_id: state.id,
        source_revision_id: state.current_version_id,
        title: state.title,
        summary: state.summary,
        ...stateMetadata!,
      } : state ? { mode: "existing", document_id: state.id } : null,
    },
    source: instructions,
    contract: exactPageContract(instructions),
    actorSubject: CUSTOM_AUTOMATION_ACTOR,
    ...(cloneState ? { stateClone: { source: state, markdown: state.body_markdown } } : {}),
  });
}

async function reconcileDefaultAutomation(input: {
  repositories: OperationalDocumentPreparationRepositories;
  bodies: MarkdownObjectStore;
  template: KnowledgeTemplateMigrationContract;
  contract: DefaultAutomationContract;
  actorSubject: string;
}): Promise<void> {
  const registration = await input.repositories.registry.byKey(input.contract.key);
  if (registration && !registration.state_document_id) {
    blocker(
      "default_automation_state_missing",
      registration.instructions_document_id,
      `Default automation ${input.contract.key} has no registered state document`,
    );
  }
  const instructions = activePage(registration
    ? await input.repositories.pages.get(registration.instructions_document_id)
    : await input.repositories.pages.getByPath(input.contract.instructions.path));
  const state = activePage(registration?.state_document_id
    ? await input.repositories.pages.get(registration.state_document_id)
    : await input.repositories.pages.getByPath(input.contract.state.path));
  if (!instructions) {
    blocker(
      "default_automation_instructions_missing",
      registration?.instructions_document_id,
      `Default automation ${input.contract.key} has no active instruction document`,
    );
  }
  if (!state) {
    blocker(
      "default_automation_state_missing",
      registration?.state_document_id ?? undefined,
      `Default automation ${input.contract.key} has no active state document`,
    );
  }
  if (!knowledgeTemplatePageContractMatches(state, input.contract.state)) {
    blocker(
      "default_automation_state_contract_conflict",
      state.id,
      `Default automation ${input.contract.key} state is missing its required structure`,
    );
  }
  const actor = await currentActor(input.repositories.pages, instructions);
  const templateOwned = templateOwns(actor, input.template.template);
  const matches = knowledgeTemplatePageContractMatches(instructions, input.contract.instructions);
  const cloneState = !privatePage(state);
  if (templateOwned && privatePage(instructions) && !cloneState) {
    if (!matches) {
      await updateManagedInPlace({
        pages: input.repositories.pages,
        page: instructions,
        contract: input.contract.instructions,
        actorSubject: input.actorSubject,
      });
    }
    await registerAutomation(
      input.repositories.registry,
      input.contract,
      registration,
      instructions.id,
      state.id,
    );
    return;
  }
  const stateMetadata = managedMetadata(state.body_markdown);
  await applyReplacement({
    repositories: input.repositories,
    bodies: input.bodies,
    target: {
      kind: "automation_instructions",
      key: input.contract.key,
      name: registration?.name ?? input.contract.name,
      state: cloneState ? {
        mode: "clone",
        source_document_id: state.id,
        source_revision_id: state.current_version_id,
        title: state.title,
        summary: state.summary,
        ...stateMetadata,
      } : { mode: "existing", document_id: state.id },
    },
    source: instructions,
    contract: input.contract.instructions,
    actorSubject: input.actorSubject,
    ...(cloneState ? { stateClone: { source: state, markdown: state.body_markdown } } : {}),
  });
}

async function reconcileManagedOperationalDocumentsAttempt(input: {
  repositories: OperationalDocumentPreparationRepositories;
  bodies: MarkdownObjectStore;
  template: KnowledgeTemplateMigrationContract;
  automations: ResolvedAutomationRegistration[];
}): Promise<void> {
  const actorSubject = `${TEMPLATE_ACTOR_PREFIX}${input.template.template}`;
  await reconcileGlobalGuide({ ...input, actorSubject });
  for (const contract of defaultAutomationContracts(input.template)) {
    await reconcileDefaultAutomation({ ...input, contract, actorSubject });
  }
  const defaultKeys = new Set<string>(DEFAULT_AUTOMATION_KEYS);
  for (const candidate of input.automations
    .filter(({ key }) => !defaultKeys.has(key))
    .sort((left, right) => left.key.localeCompare(right.key, "en"))) {
    await reconcileCustomAutomation({
      repositories: input.repositories,
      bodies: input.bodies,
      candidate,
    });
  }
}

/**
 * Reconcile operational contracts by stable authority IDs. Owner documents are
 * never overwritten: a managed private target may advance in place, while a
 * custom or published target is replaced and atomically retargeted.
 */
export async function reconcileManagedOperationalDocuments(input: {
  repositories: OperationalDocumentPreparationRepositories;
  bodies: MarkdownObjectStore;
  template: KnowledgeTemplateMigrationContract;
  automations?: ResolvedAutomationRegistration[];
}): Promise<void> {
  for (let attempt = 0; attempt < OPERATIONAL_RETRY_LIMIT; attempt += 1) {
    try {
      await reconcileManagedOperationalDocumentsAttempt({
        ...input,
        automations: input.automations ?? [],
      });
      return;
    } catch (error) {
      if (!(error instanceof OperationalDocumentReplacementDriftError)
          && !(error instanceof OperationalPreparationDriftError)
          && !(error instanceof VersionConflictError)
          && !(error instanceof AutomationRegistryIdentityConflictError)) {
        throw error;
      }
    }
  }
  blocker(
    "operational_document_retry_exhausted",
    undefined,
    "Operational documents changed repeatedly while applying the managed template",
  );
}

/**
 * Once settings/registry own an operational contract, suppress its legacy and
 * current paths in the filesystem template reconciler. Published legacy
 * candidates are also skipped so replacement can preserve their frozen pins.
 */
export async function operationalTemplateSkipPaths(input: {
  repositories: Pick<OperationalDocumentPreparationRepositories,
    "settings" | "pages" | "registry"
  >;
  template: KnowledgeTemplateMigrationContract;
}): Promise<ReadonlySet<string>> {
  const skipped = new Set<string>();
  const settings = await input.repositories.settings.get();
  if (settings.global_guide_document_id) {
    skipped.add(input.template.root_guide.path);
    const current = pageMetadata(await input.repositories.pages.metadata(
      settings.global_guide_document_id,
    ));
    if (current) skipped.add(current.current_path);
  }
  const contracts = defaultAutomationContracts(input.template);
  for (const contract of contracts) {
    const registration = await input.repositories.registry.byKey(contract.key);
    if (registration) {
      skipped.add(contract.instructions.path);
      const instructions = pageMetadata(await input.repositories.pages.metadata(
        registration.instructions_document_id,
      ));
      if (instructions) skipped.add(instructions.current_path);
      if (registration.state_document_id) {
        skipped.add(contract.state.path);
        const state = pageMetadata(await input.repositories.pages.metadata(
          registration.state_document_id,
        ));
        if (state) skipped.add(state.current_path);
      }
    }
  }
  for (const path of [
    input.template.root_guide.path,
    ...contracts.flatMap(({ instructions, state }) => [instructions.path, state.path]),
  ]) {
    const legacy = pageMetadata(await input.repositories.pages.metadataByPath(path));
    // An unregistered owner document at a bootstrap path must be inspected by
    // the ID-based reconciler before force mode can touch it. Missing paths are
    // intentionally not skipped so a fresh reset can still install defaults.
    if (legacy && legacy.archived_at == null) skipped.add(path);
  }
  return skipped;
}
