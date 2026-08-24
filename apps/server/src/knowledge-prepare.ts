import {
  AutomationRegistryRepository,
  CorpusMigrationRepository,
  DirectoryRepository,
  KnowledgeSettingsRepository,
  OperationalDocumentReplacementRepository,
  PageRepository,
  knowledgeTemplateMigrationContract,
  reconcileKnowledgeTemplate,
  type MarkdownObjectStore,
  type TemplateResult,
} from "@context-use/database";
import type { Pool } from "pg";
import {
  migrateCorpusToHypermedia,
  resolveAutomationPlan,
  type CorpusAssetVerifier,
  type CorpusMigrationReport,
} from "./corpus-migration.ts";
import {
  operationalTemplateSkipPaths,
  reconcileManagedOperationalDocuments,
} from "./operational-document-prepare.ts";

export type KnowledgePreparationResult = {
  template: TemplateResult;
  corpus: CorpusMigrationReport;
};

export function protectedOperationalTemplatePaths(
  contract: Awaited<ReturnType<typeof knowledgeTemplateMigrationContract>>,
): ReadonlySet<string> {
  return new Set([
    contract.root_guide.path,
    ...contract.pages
      .filter(({ path, management }) => management === "managed"
        && /^automations\/[^/]+\/instructions$/.test(path))
      .map(({ path }) => path),
  ]);
}

async function operationalInspection(
  repository: CorpusMigrationRepository,
) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const inspection = await repository.inspectSource();
    if (!inspection.active_run_id) return inspection;
    const audit = await repository.seal(inspection.active_run_id);
    if (audit.phase !== "superseded") return inspection;
  }
  throw new Error("Corpus inventory changed repeatedly during operational preparation");
}

/**
 * Reconcile the operational template and seal the audited corpus as one
 * synchronous preparation boundary. Callers must not report template/reset
 * success until this function returns.
 */
export async function prepareKnowledgeCorpus(input: {
  corpusPool: Pool;
  bodies: MarkdownObjectStore;
  assets: CorpusAssetVerifier;
  templateName?: string;
  forceTemplate?: boolean;
  templatesRoot?: URL;
  actorSubject?: string;
}): Promise<KnowledgePreparationResult> {
  const templateName = input.templateName ?? "default";
  // The isolated one-shot owns this credential. context_use_corpus inherits
  // the ordinary dashboard capabilities needed for template/page work, while
  // adding only the audited transition boundaries unavailable to the
  // long-lived dashboard service.
  const pages = new PageRepository(input.corpusPool, input.bodies);
  const registry = new AutomationRegistryRepository(input.corpusPool);
  const operationalRepositories = {
    settings: new KnowledgeSettingsRepository(input.corpusPool),
    pages,
    registry,
    replacements: new OperationalDocumentReplacementRepository(input.corpusPool),
  };
  const repositories = {
    directories: new DirectoryRepository(input.corpusPool),
    pages,
  };
  const contract = await knowledgeTemplateMigrationContract(templateName, input.templatesRoot);
  const skipOperationalPaths = await operationalTemplateSkipPaths({
    repositories: operationalRepositories,
    template: contract,
  });
  const template = await reconcileKnowledgeTemplate(
    repositories,
    templateName,
    true,
    input.forceTemplate ?? false,
    input.templatesRoot,
    {
      preserveLocallyModifiedPaths: protectedOperationalTemplatePaths(contract),
      skipOperationalPaths,
    },
  );
  const corpusRepository = new CorpusMigrationRepository(input.corpusPool);
  const operationalSource = await operationalInspection(corpusRepository);
  const automations = resolveAutomationPlan(
    operationalSource,
    operationalSource.pages.filter(({ archived_at }) => archived_at === null),
  ).registrations;
  await reconcileManagedOperationalDocuments({
    repositories: operationalRepositories,
    bodies: input.bodies,
    template: contract,
    automations,
  });
  const corpus = await migrateCorpusToHypermedia({
    repository: corpusRepository,
    bodies: input.bodies,
    assets: input.assets,
    automationRegistry: registry,
    template: contract,
    ...(input.actorSubject ? { actorSubject: input.actorSubject } : {}),
  });
  return { template, corpus };
}
