import type {
  AutomationRegistryRepository,
  HypermediaBootstrapAllocation,
  HypermediaBootstrapPage,
  HypermediaBootstrapPageKind,
  HypermediaBootstrapRepository,
  HypermediaBootstrapTemplate,
  KnowledgePageRepository,
  KnowledgeSettingsRepository,
} from "@context-use/database";

type BootstrapRepositories = {
  bootstrap: Pick<HypermediaBootstrapRepository, "ensurePage" | "complete">;
  settings: Pick<KnowledgeSettingsRepository, "updateGlobalGuide">;
  registry: Pick<AutomationRegistryRepository, "register">;
};

type GuideSynchronizationRepositories = {
  settings: Pick<KnowledgeSettingsRepository, "globalGuide">;
  pages: Pick<KnowledgePageRepository, "get" | "update">;
};

export type GlobalGuideSynchronization = {
  object_id: string;
  revision_number: number;
  updated: boolean;
};

const MANAGED_GUIDE_ACTOR = {
  kind: "dashboard" as const,
  subject: "context-use-managed-global-guide/v1",
};

function pageInput({
  page,
  templateName,
}: {
  page: HypermediaBootstrapTemplate["pages"][HypermediaBootstrapPageKind];
  templateName: string;
}) {
  return {
    title: page.title,
    summary: page.summary,
    body_markdown: page.body_markdown,
    commit_message: `Install ${templateName} hypermedia bootstrap`,
  };
}

export function hypermediaBootstrapPages({
  template,
  allocations,
}: {
  template: HypermediaBootstrapTemplate;
  allocations: HypermediaBootstrapAllocation[];
}): HypermediaBootstrapPage[] {
  const allocationByKind = new Map(
    allocations.map((allocation) => [allocation.document_kind, allocation]),
  );
  const pages: HypermediaBootstrapPage[] = [];
  for (const kind of Object.keys(template.pages) as HypermediaBootstrapPageKind[]) {
    const allocation = allocationByKind.get(kind);
    const page = template.pages[kind];
    if (!allocation || !page) {
      throw new Error(`Hypermedia bootstrap contract is incomplete: ${kind}`);
    }
    pages.push({ ...allocation, input: pageInput({ page, templateName: template.name }) });
  }
  if (allocationByKind.size !== pages.length) {
    throw new Error("Hypermedia bootstrap returned an unexpected allocation");
  }
  return pages;
}

export async function applyHypermediaBootstrap(input: {
  repositories: BootstrapRepositories;
  template: HypermediaBootstrapTemplate;
  allocations: HypermediaBootstrapAllocation[];
}): Promise<Date | string> {
  const pages = hypermediaBootstrapPages({
    template: input.template,
    allocations: input.allocations,
  });
  for (const page of pages) {
    await input.repositories.bootstrap.ensurePage(page);
  }
  const byKind = new Map(pages.map((page) => [page.document_kind, page]));
  await input.repositories.settings.updateGlobalGuide(byKind.get("global_guide")!.document_id);
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
  guide: HypermediaBootstrapTemplate["pages"]["global_guide"];
  templateName: string;
}): Promise<GlobalGuideSynchronization> {
  const configured = await input.repositories.settings.globalGuide();
  if (!configured) {
    throw new Error("The configured global guide is unavailable after hypermedia bootstrap");
  }
  const current = await input.repositories.pages.get(configured.document_id);
  if (!current || current.archived_at) {
    throw new Error("The configured global guide page could not be loaded");
  }
  if (current.current_revision_id !== configured.current_revision_id) {
    throw new Error("The configured global guide changed during synchronization");
  }
  if (
    current.title === input.guide.title &&
    current.summary === input.guide.summary &&
    current.body_markdown === input.guide.body_markdown
  ) {
    return {
      object_id: current.object_id,
      revision_number: current.revision_number,
      updated: false,
    };
  }
  const updated = await input.repositories.pages.update(
    current.object_id,
    {
      title: input.guide.title,
      summary: input.guide.summary,
      body_markdown: input.guide.body_markdown,
      commit_message: `Synchronize ${input.templateName} managed global guide`,
      expected_revision_number: current.revision_number,
    },
    MANAGED_GUIDE_ACTOR,
  );
  if (!updated) {
    throw new Error("The configured global guide disappeared during synchronization");
  }
  return {
    object_id: updated.object_id,
    revision_number: updated.revision_number,
    updated: true,
  };
}
