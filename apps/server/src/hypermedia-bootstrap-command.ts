import {
  AutomationRegistryRepository,
  HypermediaBootstrapRepository,
  KnowledgeSettingsRepository,
  createPool,
  knowledgeTemplateMigrationContract,
  type HypermediaBootstrapAllocation,
  type HypermediaBootstrapDocument,
  type HypermediaBootstrapDocumentKind,
  type KnowledgeTemplateMigrationContract,
} from "@context-use/database";
import { pathToFileURL } from "node:url";
import { BrokeredMarkdownObjectStore } from "./markdown-object-store.ts";
import { BrokeredStorage } from "./storage-client.ts";

type BootstrapRepositories = {
  bootstrap: Pick<HypermediaBootstrapRepository,
    "ensureDocument" | "seedEntrypoint" | "complete"
  >;
  settings: Pick<KnowledgeSettingsRepository, "updateGlobalGuide">;
  registry: Pick<AutomationRegistryRepository, "register">;
};

const BOOTSTRAP_PATHS: Record<Exclude<HypermediaBootstrapDocumentKind, "global_guide">, string> = {
  activity_distiller_instructions: "automations/activity-distiller/instructions",
  activity_distiller_state: "automations/activity-distiller/state",
  diary_composer_instructions: "automations/diary-composer/instructions",
  diary_composer_state: "automations/diary-composer/state",
};

function documentInput(
  contract: KnowledgeTemplateMigrationContract["root_guide"]
    | KnowledgeTemplateMigrationContract["pages"][number],
  templateName: string,
) {
  return {
    title: contract.title,
    summary: contract.summary,
    body_markdown: contract.body_markdown,
    commit_message: `Install ${templateName} hypermedia bootstrap`,
  };
}

export function hypermediaBootstrapDocuments(
  contract: KnowledgeTemplateMigrationContract,
  allocations: HypermediaBootstrapAllocation[],
): HypermediaBootstrapDocument[] {
  const allocationByKind = new Map(allocations.map((allocation) => [
    allocation.document_kind,
    allocation,
  ]));
  const pageByPath = new Map(contract.pages.map((page) => [page.path, page]));
  const documents: HypermediaBootstrapDocument[] = [];
  const guide = allocationByKind.get("global_guide");
  if (!guide) throw new Error("Global guide bootstrap allocation is missing");
  documents.push({
    ...guide,
    input: documentInput(contract.root_guide, contract.template),
  });
  for (const [kind, path] of Object.entries(BOOTSTRAP_PATHS) as Array<[
    keyof typeof BOOTSTRAP_PATHS,
    string,
  ]>) {
    const allocation = allocationByKind.get(kind);
    const page = pageByPath.get(path);
    if (!allocation || !page) {
      throw new Error(`Hypermedia bootstrap contract is incomplete: ${kind}`);
    }
    documents.push({ ...allocation, input: documentInput(page, contract.template) });
  }
  if (allocationByKind.size !== documents.length) {
    throw new Error("Hypermedia bootstrap returned an unexpected allocation");
  }
  return documents;
}

export async function applyHypermediaBootstrap(input: {
  repositories: BootstrapRepositories;
  contract: KnowledgeTemplateMigrationContract;
  allocations: HypermediaBootstrapAllocation[];
}): Promise<Date | string> {
  const documents = hypermediaBootstrapDocuments(input.contract, input.allocations);
  for (const document of documents) {
    await input.repositories.bootstrap.ensureDocument(document);
  }
  const byKind = new Map(documents.map((document) => [document.document_kind, document]));
  await input.repositories.settings.updateGlobalGuide(
    byKind.get("global_guide")!.document_id,
  );
  const directories = new Map(input.contract.directories.map((directory) => [
    directory.path,
    directory,
  ]));
  for (const [key, prefix] of [
    ["activity-distiller", "activity_distiller"],
    ["diary-composer", "diary_composer"],
  ] as const) {
    const name = directories.get(`automations/${key}`)?.title;
    const instructions = byKind.get(`${prefix}_instructions`);
    const state = byKind.get(`${prefix}_state`);
    if (!name || !instructions || !state) {
      throw new Error(`Hypermedia bootstrap automation contract is incomplete: ${key}`);
    }
    await input.repositories.registry.register({
      key,
      name,
      instructions_document_id: instructions.document_id,
      state_document_id: state.document_id,
    });
  }
  await input.repositories.bootstrap.seedEntrypoint();
  return input.repositories.bootstrap.complete();
}

function templateName(production: boolean): string {
  const configured = process.env.CONTEXT_USE_TEMPLATE_INSTALL?.trim() || "default";
  if (production && configured !== "default") {
    throw new Error("Production hypermedia bootstrap supports only the default template");
  }
  return configured;
}

function templatesRoot(production: boolean): URL | undefined {
  const configured = process.env.CONTEXT_USE_DEVELOPMENT_TEMPLATE_ROOT?.trim();
  if (!configured) return undefined;
  if (production) {
    throw new Error("Production hypermedia bootstrap uses only the embedded default template");
  }
  return pathToFileURL(configured.endsWith("/") ? configured : `${configured}/`);
}

export async function runHypermediaBootstrapCommand(): Promise<void> {
  const corpusDatabaseUrl = process.env.CORPUS_DATABASE_URL;
  if (!corpusDatabaseUrl) throw new Error("CORPUS_DATABASE_URL is required");
  const parsed = new URL(corpusDatabaseUrl);
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)
      || decodeURIComponent(parsed.username) !== "context_use_corpus") {
    throw new Error("CORPUS_DATABASE_URL must use only context_use_corpus");
  }
  const pool = createPool(corpusDatabaseUrl, {
    application_name: "context-use-hypermedia-bootstrap",
  });
  try {
    const production = process.env.NODE_ENV === "production";
    const socketPath = process.env.STORAGE_SOCKET_PATH
      ?? (production ? undefined : "/tmp/context-use-storage.sock");
    const token = process.env.STORAGE_DASHBOARD_TOKEN
      ?? (production ? undefined : "development-storage-dashboard-token");
    if (!socketPath || !token) {
      throw new Error("Hypermedia bootstrap requires the dashboard storage capability");
    }
    const storage = new BrokeredStorage({ socketPath, token });
    const bodies = new BrokeredMarkdownObjectStore(storage);
    const bootstrap = new HypermediaBootstrapRepository(pool, bodies);
    const allocations = await bootstrap.begin();
    if (!allocations.length) {
      console.log(JSON.stringify({ event: "hypermedia_bootstrap_already_finalized" }));
      return;
    }
    const name = templateName(production);
    const contract = await knowledgeTemplateMigrationContract(name, templatesRoot(production));
    const completedAt = await applyHypermediaBootstrap({
      repositories: {
        bootstrap,
        settings: new KnowledgeSettingsRepository(pool),
        registry: new AutomationRegistryRepository(pool),
      },
      contract,
      allocations,
    });
    console.log(JSON.stringify({
      event: "hypermedia_bootstrap_completed",
      finalized_at: completedAt,
      documents: allocations.length,
    }));
  } finally {
    await pool.end();
  }
}

if (import.meta.main) {
  try {
    await runHypermediaBootstrapCommand();
  } catch (error) {
    console.error(JSON.stringify({
      event: "hypermedia_bootstrap_failed",
      error_name: error instanceof Error ? error.name : typeof error,
      message: error instanceof Error ? error.message : "Unknown failure",
    }));
    process.exitCode = 1;
  }
}
