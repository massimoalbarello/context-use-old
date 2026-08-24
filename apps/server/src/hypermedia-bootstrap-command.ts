import {
  AutomationRegistryRepository,
  defaultHypermediaBootstrapTemplate,
  HypermediaBootstrapRepository,
  KnowledgeDocumentRepository,
  KnowledgeSettingsRepository,
  createPool,
  type HypermediaBootstrapAllocation,
  type HypermediaBootstrapDocument,
  type HypermediaBootstrapDocumentKind,
  type HypermediaBootstrapTemplate,
} from "@context-use/database";
import { BrokeredMarkdownObjectStore } from "./markdown-object-store.ts";
import { BrokeredStorage } from "./storage-client.ts";

type BootstrapRepositories = {
  bootstrap: Pick<HypermediaBootstrapRepository,
    "ensureDocument" | "complete"
  >;
  settings: Pick<KnowledgeSettingsRepository, "updateGlobalGuide">;
  registry: Pick<AutomationRegistryRepository, "register">;
};

type GuideSynchronizationRepositories = {
  settings: Pick<KnowledgeSettingsRepository, "globalGuide">;
  documents: Pick<KnowledgeDocumentRepository, "get" | "update">;
};

export type GlobalGuideSynchronization = {
  document_id: string;
  revision_number: number;
  updated: boolean;
};

const MANAGED_GUIDE_ACTOR = {
  kind: "dashboard" as const,
  subject: "context-use-managed-global-guide/v1",
};

function documentInput(
  document: HypermediaBootstrapTemplate["documents"][HypermediaBootstrapDocumentKind],
  templateName: string,
) {
  return {
    title: document.title,
    summary: document.summary,
    body_markdown: document.body_markdown,
    commit_message: `Install ${templateName} hypermedia bootstrap`,
  };
}

export function hypermediaBootstrapDocuments(
  template: HypermediaBootstrapTemplate,
  allocations: HypermediaBootstrapAllocation[],
): HypermediaBootstrapDocument[] {
  const allocationByKind = new Map(allocations.map((allocation) => [
    allocation.document_kind,
    allocation,
  ]));
  const documents: HypermediaBootstrapDocument[] = [];
  for (const kind of Object.keys(template.documents) as HypermediaBootstrapDocumentKind[]) {
    const allocation = allocationByKind.get(kind);
    const document = template.documents[kind];
    if (!allocation || !document) {
      throw new Error(`Hypermedia bootstrap contract is incomplete: ${kind}`);
    }
    documents.push({ ...allocation, input: documentInput(document, template.name) });
  }
  if (allocationByKind.size !== documents.length) {
    throw new Error("Hypermedia bootstrap returned an unexpected allocation");
  }
  return documents;
}

export async function applyHypermediaBootstrap(input: {
  repositories: BootstrapRepositories;
  template: HypermediaBootstrapTemplate;
  allocations: HypermediaBootstrapAllocation[];
}): Promise<Date | string> {
  const documents = hypermediaBootstrapDocuments(input.template, input.allocations);
  for (const document of documents) {
    await input.repositories.bootstrap.ensureDocument(document);
  }
  const byKind = new Map(documents.map((document) => [document.document_kind, document]));
  await input.repositories.settings.updateGlobalGuide(
    byKind.get("global_guide")!.document_id,
  );
  for (const automation of input.template.automations) {
    const instructions = byKind.get(automation.instructions);
    const state = byKind.get(automation.state);
    if (!instructions || !state) {
      throw new Error(`Hypermedia bootstrap automation contract is incomplete: ${automation.key}`);
    }
    await input.repositories.registry.register({
      key: automation.key,
      name: automation.name,
      instructions_document_id: instructions.document_id,
      state_document_id: state.document_id,
    });
  }
  return input.repositories.bootstrap.complete();
}

export async function synchronizeGlobalGuide(input: {
  repositories: GuideSynchronizationRepositories;
  guide: HypermediaBootstrapTemplate["documents"]["global_guide"];
  templateName: string;
}): Promise<GlobalGuideSynchronization> {
  const configured = await input.repositories.settings.globalGuide();
  if (!configured) {
    throw new Error("The configured global guide is unavailable after hypermedia bootstrap");
  }
  const current = await input.repositories.documents.get(configured.document_id);
  if (!current || current.archived_at) {
    throw new Error("The configured global guide document could not be loaded");
  }
  if (current.current_revision_id !== configured.current_revision_id) {
    throw new Error("The configured global guide changed during synchronization");
  }
  if (current.title === input.guide.title
      && current.summary === input.guide.summary
      && current.body_markdown === input.guide.body_markdown) {
    return {
      document_id: current.document_id,
      revision_number: current.revision_number,
      updated: false,
    };
  }
  const updated = await input.repositories.documents.update(current.document_id, {
    title: input.guide.title,
    summary: input.guide.summary,
    body_markdown: input.guide.body_markdown,
    commit_message: `Synchronize ${input.templateName} managed global guide`,
    expected_revision_number: current.revision_number,
  }, MANAGED_GUIDE_ACTOR);
  if (!updated) throw new Error("The configured global guide disappeared during synchronization");
  return {
    document_id: updated.document_id,
    revision_number: updated.revision_number,
    updated: true,
  };
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
    const settings = new KnowledgeSettingsRepository(pool);
    const knowledgeDocuments = new KnowledgeDocumentRepository(pool, bodies);
    const allocations = await bootstrap.begin();
    if (!allocations.length) {
      const synchronization = await synchronizeGlobalGuide({
        repositories: { settings, documents: knowledgeDocuments },
        guide: defaultHypermediaBootstrapTemplate.documents.global_guide,
        templateName: defaultHypermediaBootstrapTemplate.name,
      });
      console.log(JSON.stringify({
        event: synchronization.updated
          ? "managed_global_guide_updated"
          : "managed_global_guide_current",
        document_id: synchronization.document_id,
        revision_number: synchronization.revision_number,
      }));
      return;
    }
    const completedAt = await applyHypermediaBootstrap({
      repositories: {
        bootstrap,
        settings,
        registry: new AutomationRegistryRepository(pool),
      },
      template: defaultHypermediaBootstrapTemplate,
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
