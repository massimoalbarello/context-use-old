import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  assertMarkdownObject,
  AutomationRegistryIdentityConflictError,
  CorpusMigrationInventoryDriftError,
  type CorpusMigrationInspection,
  type CorpusMigrationPlan,
  type CorpusMigrationStatus,
  type CorpusObjectRef,
  type CorpusReadyObject,
  knowledgeTemplateMigrationContract,
  type LegacyCorpusPage,
  markdownObjectMetadata,
  neutralPublicDirectoryTitle,
  type MarkdownObjectMetadata,
  type MarkdownObjectStore,
  type PlannedCorpusDirectory,
} from "@context-use/database";
import {
  CorpusMigrationBlockedError,
  migrateCorpusToHypermedia,
  type CorpusMigrationRepositoryLike,
} from "./corpus-migration.ts";
import { renderDirectoryHubMarkdown } from "./corpus-migration-planner.ts";

const template = await knowledgeTemplateMigrationContract("default");

function id(value: number): string {
  return `00000000-0000-4000-8000-${value.toString().padStart(12, "0")}`;
}

class MemoryMarkdownStore implements MarkdownObjectStore {
  readonly values = new Map<string, string>();
  readonly writes: Array<{ revisionId: string; markdown: string }> = [];

  add(revisionId: string, markdown: string): CorpusObjectRef {
    const stored = markdownObjectMetadata(revisionId, markdown);
    this.values.set(stored.body_object_key, markdown);
    return {
      revision_id: revisionId,
      revision_number: 1,
      ...stored,
      links_indexed_at: new Date(0),
    };
  }

  async write(revisionId: string, markdown: string): Promise<MarkdownObjectMetadata> {
    const stored = markdownObjectMetadata(revisionId, markdown);
    const existing = this.values.get(stored.body_object_key);
    if (existing !== undefined && existing !== markdown) throw new Error("object collision");
    this.values.set(stored.body_object_key, markdown);
    this.writes.push({ revisionId, markdown });
    return stored;
  }

  async read(metadata: MarkdownObjectMetadata): Promise<string> {
    const markdown = this.values.get(metadata.body_object_key);
    if (markdown === undefined) throw new Error("missing object");
    return assertMarkdownObject(markdown, metadata);
  }
}

function operationalPage(
  bodies: MemoryMarkdownStore,
  path: string,
  documentId: string,
): LegacyCorpusPage {
  const contract = path === "agents"
    ? template.root_guide
    : template.pages.find((page) => page.path === path)!;
  return {
    document_id: documentId,
    path,
    title: contract.title,
    summary: contract.summary,
    archived_at: null,
    current_revision: bodies.add(id(Number(documentId.slice(-4)) + 100), contract.body_markdown),
    published_revision: null,
    published_artifact: null,
    published_title: null,
    published_summary: null,
    public_path: null,
    public_id: null,
    public_aliases: [],
    is_global_guide: path === "agents",
  };
}

function fixture() {
  const bodies = new MemoryMarkdownStore();
  const rootDirectory = id(1);
  const automationsDirectory = id(2);
  const activityDirectory = id(3);
  const diaryDirectory = id(4);
  const projectsDirectory = id(5);
  const placesDirectory = id(6);
  const guide = id(11);
  const activityInstructions = id(12);
  const activityState = id(13);
  const diaryInstructions = id(14);
  const diaryState = id(15);
  const automationNotes = id(16);
  const article = id(17);
  const asset = id(18);
  const record = id(19);

  const pages: LegacyCorpusPage[] = [
    operationalPage(bodies, "agents", guide),
    operationalPage(bodies, "automations/activity-distiller/instructions", activityInstructions),
    operationalPage(bodies, "automations/activity-distiller/state", activityState),
    operationalPage(bodies, "automations/diary-composer/instructions", diaryInstructions),
    operationalPage(bodies, "automations/diary-composer/state", diaryState),
    {
      document_id: automationNotes,
      path: "automations/activity-distiller/notes",
      title: "Operator notes",
      summary: "Unrecognized but preserved.",
      archived_at: null,
      current_revision: bodies.add(id(116), [
        "# Operator notes",
        "",
        "Keep this ordinary document.",
        "",
        `\`[Example](context-use://document/${article})\``,
        `<!-- [Comment](context-use://document/${article}) -->`,
        "",
      ].join("\n")),
      published_revision: null,
      published_artifact: null,
      published_title: null,
      published_summary: null,
      public_path: null,
      public_id: null,
      public_aliases: [],
      is_global_guide: false,
    },
  ];
  const articleCurrent = bodies.add(
    id(117),
    `[Projects](context-use://directory/${projectsDirectory}#active)\n\nPrivate current note.\n`,
  );
  const articlePublished = bodies.add(id(118), "# Public article\n\nPublished account.\n");
  const articleArtifactBody = "# Public article\n\nPublished account.\n";
  const articleArtifactId = id(317);
  pages.push({
    document_id: article,
    path: "projects/article",
    title: "PRIVATE current title",
    summary: "Private current summary.",
    archived_at: null,
    current_revision: articleCurrent,
    published_revision: articlePublished,
    published_artifact: {
      artifact_id: articleArtifactId,
      projection_generation: "1",
      body_object_key: `documents/public/${articleArtifactId}.md`,
      body_size_bytes: Buffer.byteLength(articleArtifactBody, "utf8"),
      body_content_hash: createHash("sha256").update(articleArtifactBody).digest("hex"),
    },
    published_title: "Public article",
    published_summary: "Public summary.",
    public_path: "projects/article",
    public_id: id(217),
    public_aliases: [],
    is_global_guide: false,
  });

  const directoryPresentation = (path: string) => {
    const presentation = template.directories.find((item) => item.path === path)!;
    return { title: presentation.title, summary: presentation.summary };
  };
  const rootPresentation = directoryPresentation("");
  const automationsPresentation = directoryPresentation("automations");
  const activityPresentation = directoryPresentation("automations/activity-distiller");
  const diaryPresentation = directoryPresentation("automations/diary-composer");
  const placesPresentation = directoryPresentation("places");
  const inspection: CorpusMigrationInspection = {
    active_run_id: null,
    inventory_token: "a".repeat(64),
    readable_document_ids: [
      ...pages.map((page) => page.document_id),
      asset,
      record,
    ],
      global_guide_document_id: guide,
      public_entrypoint_document_id: article,
      automation_registrations: [],
      directories: [
      {
        directory_id: rootDirectory,
        path: "",
        parent_path: null,
        version_number: 1,
        ...rootPresentation,
        created_at: new Date(0),
        updated_at: new Date(0),
        legacy_public_reachable: true,
        public_title: rootPresentation.title,
        public_summary: rootPresentation.summary,
        has_existing_hub: false,
        direct_directory_ids: [automationsDirectory, projectsDirectory, placesDirectory],
        direct_page_ids: [guide],
        direct_asset_ids: [],
      },
      {
        directory_id: automationsDirectory,
        path: "automations",
        parent_path: "",
        version_number: 1,
        ...automationsPresentation,
        created_at: new Date(0),
        updated_at: new Date(0),
        legacy_public_reachable: false,
        public_title: null,
        public_summary: null,
        has_existing_hub: false,
        direct_directory_ids: [activityDirectory, diaryDirectory],
        direct_page_ids: [],
        direct_asset_ids: [],
      },
      {
        directory_id: activityDirectory,
        path: "automations/activity-distiller",
        parent_path: "automations",
        version_number: 1,
        ...activityPresentation,
        created_at: new Date(0),
        updated_at: new Date(0),
        legacy_public_reachable: false,
        public_title: null,
        public_summary: null,
        has_existing_hub: false,
        direct_directory_ids: [],
        direct_page_ids: [activityInstructions, activityState, automationNotes],
        direct_asset_ids: [],
      },
      {
        directory_id: diaryDirectory,
        path: "automations/diary-composer",
        parent_path: "automations",
        version_number: 1,
        ...diaryPresentation,
        created_at: new Date(0),
        updated_at: new Date(0),
        legacy_public_reachable: false,
        public_title: null,
        public_summary: null,
        has_existing_hub: false,
        direct_directory_ids: [],
        direct_page_ids: [diaryInstructions, diaryState],
        direct_asset_ids: [],
      },
      {
        directory_id: projectsDirectory,
        path: "projects",
        parent_path: "",
        version_number: 1,
        title: "Projects",
        summary: "Current projects and their relationships.",
        created_at: new Date(0),
        updated_at: new Date(0),
        legacy_public_reachable: true,
        public_title: "Projects",
        public_summary: "Current projects and their relationships.",
        has_existing_hub: false,
        direct_directory_ids: [],
        direct_page_ids: [article],
        direct_asset_ids: [asset],
      },
      {
        directory_id: placesDirectory,
        path: "places",
        parent_path: "",
        version_number: 1,
        ...placesPresentation,
        created_at: new Date(0),
        updated_at: new Date(0),
        legacy_public_reachable: false,
        public_title: null,
        public_summary: null,
        has_existing_hub: false,
        direct_directory_ids: [],
        direct_page_ids: [],
        direct_asset_ids: [],
      },
    ],
    pages,
    assets: [{
      document_id: asset,
      path: "projects/private-photo",
      deleted_at: null,
      filename: "PRIVATE photo.png",
      content_type: "image/png",
      size_bytes: 4,
      content_hash: "b".repeat(64),
      object_key: "objects/private-key-never-log",
      public_path: "projects/private-photo",
      public_id: id(218),
      public_aliases: [],
    }],
    records: [{
      document_id: record,
      integration: "gmail",
      connection_id: "gmail",
      connection_instance_id: id(219),
      model: "message",
      source_record_id: "message-1",
      source_created_at: new Date(0),
      source_updated_at: new Date(0),
      deleted_at: null,
      current_revision: bodies.add(
        id(119),
        `[Incidental](context-use://document/${article}) remains immutable evidence.\n`,
      ),
    }],
  };
  return {
    bodies,
    inspection,
    ids: {
      rootDirectory,
      automationsDirectory,
      activityDirectory,
      diaryDirectory,
      projectsDirectory,
      placesDirectory,
      guide,
      activityInstructions,
      activityState,
      diaryInstructions,
      diaryState,
      article,
      articleCurrent: articleCurrent.revision_id,
      articlePublished: articlePublished.revision_id,
      articleArtifact: articleArtifactId,
      asset,
      record,
      automationNotes,
    },
  };
}

function fakePublicHubBody(
  inspection: CorpusMigrationInspection,
  directoryId: string,
  dispositions: ReadonlyMap<string, string>,
  automations: Array<{ instructions_document_id: string; state_document_id: string | null }>,
): string {
  const directory = inspection.directories.find(({ directory_id }) => (
    directory_id === directoryId
  ))!;
  const parentPath = (path: string) => path.includes("/")
    ? path.replace(/\/[^/]+$/, "")
    : "";
  const excluded = new Set([
    inspection.global_guide_document_id,
    ...automations.flatMap(({ instructions_document_id, state_document_id }) => [
      instructions_document_id,
      state_document_id,
    ]),
  ].filter((value): value is string => value !== null).map((value) => value.toLowerCase()));
  const links = inspection.pages
    .filter((page) => page.archived_at === null
      && page.published_revision !== null
      && page.public_path !== null
      && parentPath(page.public_path) === directory.path
      && !excluded.has(page.document_id.toLowerCase()))
    .map((page) => ({
      documentId: page.document_id,
      label: page.published_title ?? "Untitled",
      summary: page.published_summary,
      sortKey: page.public_path!,
    }));
  for (const child of inspection.directories.filter(({ parent_path }) => (
    parent_path === directory.path
  ))) {
    const disposition = dispositions.get(child.directory_id);
    if ((disposition !== "hub" && disposition !== "public_compatibility")
        || !child.legacy_public_reachable) continue;
    links.push({
      documentId: child.directory_id,
      label: child.public_title ?? neutralPublicDirectoryTitle(child.path),
      summary: child.public_summary,
      sortKey: child.path,
    });
  }
  return renderDirectoryHubMarkdown({
    title: directory.public_title ?? neutralPublicDirectoryTitle(directory.path),
    summary: directory.public_summary
      ?? "Published knowledge formerly available under this public collection.",
    links,
  });
}

class FakeRepository implements CorpusMigrationRepositoryLike {
  readonly completed: Parameters<CorpusMigrationRepositoryLike["completeExisting"]>[0][] = [];
  readonly pageWrites: Parameters<CorpusMigrationRepositoryLike["applyPage"]>[0][] = [];
  readonly hubWrites: Parameters<CorpusMigrationRepositoryLike["applyHub"]>[0][] = [];
  readonly events: string[] = [];
  readonly hubOverrides = new Map<
    string,
    Omit<NonNullable<PlannedCorpusDirectory["hub"]>, "public_body_markdown">
      & { public_body_markdown?: string | null }
  >();
  beginInput: Parameters<CorpusMigrationRepositoryLike["beginOrResume"]>[0] | null = null;

  constructor(
    readonly inspection: CorpusMigrationInspection,
    public phase: "applying" | "ready" = "applying",
  ) {}

  async inspectSource() {
    return this.inspection;
  }

  async beginOrResume(
    input: Parameters<CorpusMigrationRepositoryLike["beginOrResume"]>[0],
  ): Promise<CorpusMigrationPlan> {
    this.beginInput = input;
    const disposition = new Map(input.directories.map((item) => [item.directory_id, item.disposition]));
    return {
      run_id: id(300),
      inventory_token: this.inspection.inventory_token,
      phase: this.phase,
      readable_document_ids: [...new Set([
        ...this.inspection.readable_document_ids,
        ...this.inspection.directories
          .filter((directory) => {
            const kind = disposition.get(directory.directory_id);
            return kind === "hub" || kind === "public_compatibility";
          })
          .map((directory) => directory.directory_id),
      ])].sort(),
      global_guide_document_id: this.inspection.global_guide_document_id,
      public_entrypoint_document_id: this.inspection.public_entrypoint_document_id,
      directories: this.inspection.directories.map((directory, index) => {
        const kind = disposition.get(directory.directory_id)!;
        const materializes = kind === "hub" || kind === "public_compatibility";
        const override = this.hubOverrides.get(directory.directory_id);
        const publicBody = directory.legacy_public_reachable
          ? fakePublicHubBody(this.inspection, directory.directory_id, disposition, input.automations)
          : null;
        return {
          ...directory,
          disposition: kind,
          hub: materializes
            ? override ? { ...override, public_body_markdown: override.public_body_markdown ?? publicBody } : {
                document_id: directory.directory_id,
                temporary_path: `${directory.path}/migration-hub-${directory.directory_id}`,
                private_revision_mode: "render",
                public_revision_mode: directory.legacy_public_reachable ? "render" : null,
                private_revision: {
                  revision_id: id(400 + index),
                  revision_number: directory.legacy_public_reachable ? 2 : 1,
                  body_object_key: `documents/private/${id(400 + index)}.md`,
                },
                public_revision: directory.legacy_public_reachable ? {
                  revision_id: id(500 + index),
                  revision_number: 1,
                  body_object_key: `documents/private/${id(500 + index)}.md`,
                } : null,
                private_source_revision: null,
                public_source_revision: null,
                public_body_markdown: publicBody,
                public_id: directory.legacy_public_reachable ? id(550 + index) : null,
              }
            : null,
        };
      }),
      pages: this.inspection.pages.map((page, index) => ({
        ...page,
        rewrite_revision: {
          revision_id: id(600 + index),
          revision_number: page.current_revision.revision_number + 1,
          body_object_key: `documents/private/${id(600 + index)}.md`,
        },
      })),
      assets: this.inspection.assets,
      records: this.inspection.records,
      automations: input.automations.map((automation, index) => ({ id: id(700 + index), ...automation })),
    };
  }

  async status(): Promise<CorpusMigrationStatus> {
    return this.readyStatus();
  }

  async readyObjects(): Promise<CorpusReadyObject[]> {
    const ready: CorpusReadyObject[] = [];
    for (const page of this.inspection.pages.filter((candidate) => candidate.archived_at === null)) {
      const output = this.pageWrites.findLast((write) => write.document_id === page.document_id);
      const current: CorpusObjectRef = output ? {
        revision_id: output.revision.id,
        revision_number: page.current_revision.revision_number + 1,
        body_object_key: output.revision.body_object_key,
        body_size_bytes: output.revision.body_size_bytes,
        body_content_hash: output.revision.body_content_hash,
        links_indexed_at: new Date(0),
      } : page.current_revision;
      const completion = this.completed.findLast((item) => (
        item.item_kind === "page" && item.item_id === page.document_id
      ));
      const currentTargets = output?.target_document_ids ?? completion?.target_document_ids ?? [];
      ready.push({
        document_id: page.document_id,
        kind: "knowledge",
        revision: current,
        target_document_ids: currentTargets,
        indexed_document_ids: currentTargets,
        target_asset_ids: currentTargets.filter((id) => (
          this.inspection.assets.some((asset) => asset.document_id === id)
        )),
      });
    }
    const hubs = new Map<string, Parameters<CorpusMigrationRepositoryLike["applyHub"]>[0]>();
    for (const write of this.hubWrites) hubs.set(write.directory_id, write);
    for (const write of hubs.values()) {
      ready.push({
        document_id: write.directory_id,
        kind: "knowledge",
        revision: {
          revision_id: write.private_revision.id,
          revision_number: 1,
          body_object_key: write.private_revision.body_object_key,
          body_size_bytes: write.private_revision.body_size_bytes,
          body_content_hash: write.private_revision.body_content_hash,
          links_indexed_at: new Date(0),
        },
        target_document_ids: write.private_revision.target_document_ids,
        indexed_document_ids: write.private_revision.target_document_ids,
        target_asset_ids: write.private_revision.target_document_ids.filter((id) => (
          this.inspection.assets.some((asset) => asset.document_id === id)
        )),
      });
      if (write.public_revision) {
        ready.push({
          document_id: write.directory_id,
          kind: "published",
          revision: {
            revision_id: write.public_revision.id,
            revision_number: 1,
            body_object_key: write.public_revision.body_object_key,
            body_size_bytes: write.public_revision.body_size_bytes,
            body_content_hash: write.public_revision.body_content_hash,
            links_indexed_at: new Date(0),
          },
          target_document_ids: write.public_revision.target_document_ids,
          indexed_document_ids: write.public_revision.target_document_ids,
          target_asset_ids: write.public_revision.target_document_ids.filter((id) => (
            this.inspection.assets.some((asset) => asset.document_id === id)
          )),
        });
      }
    }
    return ready;
  }

  async completeExisting(input: Parameters<CorpusMigrationRepositoryLike["completeExisting"]>[0]) {
    this.completed.push(input);
  }

  async applyPage(input: Parameters<CorpusMigrationRepositoryLike["applyPage"]>[0]) {
    this.pageWrites.push(input);
    this.events.push(`page:${input.document_id}`);
  }

  async applyHub(input: Parameters<CorpusMigrationRepositoryLike["applyHub"]>[0]) {
    this.hubWrites.push(input);
    this.events.push(`hub:${input.directory_id}`);
  }

  async seal(): Promise<CorpusMigrationStatus> {
    this.phase = "ready";
    return this.readyStatus();
  }

  private readyStatus(): CorpusMigrationStatus {
    const total = this.inspection.directories.length + this.inspection.pages.length
      + this.inspection.assets.length + this.inspection.records.length;
    return {
      run_id: id(300),
      phase: "ready",
      inventory_token: this.inspection.inventory_token,
      counts: { total, completed: total },
      blockers: [],
    };
  }
}

describe("corpus migration orchestration", () => {
  test("verifies the active corpus, rewrites current knowledge, and creates privacy-safe hubs", async () => {
    const { bodies, inspection, ids } = fixture();
    const repository = new FakeRepository(inspection);
    const verifiedAssets: string[] = [];
    const registered: string[] = [];
    const report = await migrateCorpusToHypermedia({
      repository,
      bodies,
      assets: {
        verify: async (objectKey) => {
          verifiedAssets.push(objectKey);
          return true;
        },
      },
      automationRegistry: {
        byKey: async () => null,
        register: async ({ key }) => registered.push(key),
      },
      template,
    });

    expect(report.status.phase).toBe("ready");
    expect(report.unrecognized_automation_document_ids).toEqual([ids.automationNotes]);
    expect(repository.beginInput?.directories).toContainEqual({
      directory_id: ids.projectsDirectory,
      disposition: "hub",
    });
    expect(repository.beginInput?.directories).toContainEqual({
      directory_id: ids.placesDirectory,
      disposition: "retired_template_scaffold",
    });
    expect(registered.sort()).toEqual(["activity-distiller", "diary-composer"]);
    expect(verifiedAssets).toEqual([
      `documents/public/${ids.articleArtifact}.md`,
      "objects/private-key-never-log",
    ]);

    expect(repository.pageWrites).toHaveLength(1);
    expect(repository.pageWrites[0]).toMatchObject({
      document_id: ids.article,
      source_revision_id: ids.articleCurrent,
      verified_source_revision_ids: [ids.articleCurrent, ids.articlePublished].sort(),
      verified_public_artifact_ids: [ids.articleArtifact],
      target_document_ids: [ids.projectsDirectory],
    });
    expect(repository.pageWrites[0]!.body_markdown_for_index).toContain(
      `context-use://document/${ids.projectsDirectory}#active`,
    );
    expect(repository.completed).toContainEqual(expect.objectContaining({
      item_kind: "record",
      item_id: ids.record,
    }));
    expect(repository.completed).toContainEqual(expect.objectContaining({
      item_kind: "asset",
      item_id: ids.asset,
    }));
    expect(repository.completed).toContainEqual(expect.objectContaining({
      item_kind: "page",
      item_id: ids.automationNotes,
      target_document_ids: [],
      body_markdown_for_index: expect.stringContaining("context-use://document/"),
    }));

    expect(repository.hubWrites).toHaveLength(1);
    const hub = repository.hubWrites[0]!;
    expect(hub.private_revision.body_markdown_for_index).toContain("PRIVATE current title");
    expect(hub.private_revision.body_markdown_for_index).toContain("PRIVATE photo\\.png");
    const publicBody = bodies.values.get(hub.public_revision!.body_object_key)!;
    expect(publicBody).toContain("Public article");
    expect(publicBody).toContain("Public summary\\.");
    expect(publicBody).not.toContain("PRIVATE current title");
    expect(publicBody).not.toContain("PRIVATE current summary");
    expect(publicBody).not.toContain("PRIVATE photo");
    expect(hub.public_revision!.target_document_ids).toEqual([ids.article]);
  });

  test("uses the configured guide ID and keeps descendant AGENTS pages as ordinary knowledge", async () => {
    const { bodies, inspection, ids } = fixture();
    const guide = inspection.pages.find((page) => page.document_id === ids.guide)!;
    guide.path = `managed-operational/${guide.document_id}`;
    const formerRootGuideId = id(928);
    const descendantGuideId = id(930);
    const ownerGuide = (
      documentId: string,
      path: string,
      revisionId: string,
      title: string,
    ): LegacyCorpusPage => ({
      document_id: documentId,
      path,
      title,
      summary: "Historical owner writing guidance.",
      archived_at: null,
      current_revision: bodies.add(
        revisionId,
        `[Project collection](context-use://directory/${ids.projectsDirectory})\n`,
      ),
      published_revision: null,
      published_artifact: null,
      published_title: null,
      published_summary: null,
      public_path: null,
      public_id: null,
      public_aliases: [],
      is_global_guide: false,
    });
    inspection.pages.push(ownerGuide(
      formerRootGuideId,
      "agents",
      id(929),
      "Owner root guide",
    ), {
      document_id: descendantGuideId,
      path: "projects/agents",
      title: "Owner project guide",
      summary: "Historical project writing guidance.",
      archived_at: null,
      current_revision: bodies.add(
        id(931),
        `[Project collection](context-use://directory/${ids.projectsDirectory})\n`,
      ),
      published_revision: null,
      published_artifact: null,
      published_title: null,
      published_summary: null,
      public_path: null,
      public_id: null,
      public_aliases: [],
      is_global_guide: false,
    });
    inspection.readable_document_ids.push(formerRootGuideId, descendantGuideId);
    inspection.directories.find(({ directory_id }) => (
      directory_id === ids.rootDirectory
    ))!.direct_page_ids.push(formerRootGuideId);
    inspection.directories.find(({ directory_id }) => (
      directory_id === ids.projectsDirectory
    ))!.direct_page_ids.push(descendantGuideId);
    const repository = new FakeRepository(inspection);

    const report = await migrateCorpusToHypermedia({
      repository,
      bodies,
      assets: { verify: async () => true },
      automationRegistry: { byKey: async () => null, register: async () => undefined },
      template,
    });

    expect(report.status.phase).toBe("ready");
    const rewritten = repository.pageWrites.find(({ document_id }) => (
      document_id === descendantGuideId
    ));
    expect(rewritten?.body_markdown_for_index).toContain(
      `context-use://document/${ids.projectsDirectory}`,
    );
    expect(repository.pageWrites.find(({ document_id }) => (
      document_id === formerRootGuideId
    ))?.body_markdown_for_index).toContain(
      `context-use://document/${ids.projectsDirectory}`,
    );
    const hub = repository.hubWrites.find(({ directory_id }) => (
      directory_id === ids.projectsDirectory
    ))!;
    expect(hub.private_revision.body_markdown_for_index).toContain("Owner project guide");
    expect(hub.private_revision.target_document_ids).toContain(descendantGuideId);
  });

  test("preserves registered opaque automation IDs and reports the abandoned legacy path page", async () => {
    const { bodies, inspection, ids } = fixture();
    const instructions = inspection.pages.find(({ document_id }) => (
      document_id === ids.activityInstructions
    ))!;
    const state = inspection.pages.find(({ document_id }) => (
      document_id === ids.activityState
    ))!;
    instructions.path = `managed-operational/${instructions.document_id}`;
    state.path = `managed-operational/${state.document_id}`;
    const registrationId = id(932);
    inspection.automation_registrations.push({
      id: registrationId,
      key: "activity-distiller",
      name: "Owner activity distiller",
      instructions_document_id: instructions.document_id,
      state_document_id: state.document_id,
      disabled_at: new Date("2026-01-01T00:00:00Z"),
    });
    const abandonedId = id(933);
    inspection.pages.push({
      document_id: abandonedId,
      path: "automations/activity-distiller/instructions",
      title: "Old owner instructions",
      summary: "Preserved after the operational authority moved.",
      archived_at: null,
      current_revision: bodies.add(id(934), "# Old owner instructions\n"),
      published_revision: null,
      published_artifact: null,
      published_title: null,
      published_summary: null,
      public_path: null,
      public_id: null,
      public_aliases: [],
      is_global_guide: false,
    });
    inspection.readable_document_ids.push(abandonedId);
    inspection.directories.find(({ directory_id }) => (
      directory_id === ids.activityDirectory
    ))!.direct_page_ids.push(abandonedId);
    const repository = new FakeRepository(inspection);

    const report = await migrateCorpusToHypermedia({
      repository,
      bodies,
      assets: { verify: async () => true },
      automationRegistry: { byKey: async () => null, register: async () => undefined },
      template,
    });

    expect(report.unrecognized_automation_document_ids).toEqual([
      ids.automationNotes,
      abandonedId,
    ].sort());
    expect(repository.beginInput?.automations).toContainEqual({
      key: "activity-distiller",
      name: "Owner activity distiller",
      instructions_document_id: instructions.document_id,
      state_document_id: state.document_id,
    });
    expect(repository.beginInput?.directories).toContainEqual({
      directory_id: ids.activityDirectory,
      disposition: "operational",
    });
    expect(repository.completed).toContainEqual(expect.objectContaining({
      item_kind: "page",
      item_id: abandonedId,
    }));
  });

  test("preserves published automation directory routes through public-only compatibility carriers", async () => {
    const { bodies, inspection, ids } = fixture();
    const oldState = inspection.pages.find(({ document_id }) => (
      document_id === ids.activityState
    ))!;
    const oldStateBody = bodies.values.get(oldState.current_revision.body_object_key)!;
    const artifactId = id(938);
    oldState.published_revision = oldState.current_revision;
    oldState.published_artifact = {
      artifact_id: artifactId,
      projection_generation: "1",
      body_object_key: `documents/public/${artifactId}.md`,
      body_size_bytes: Buffer.byteLength(oldStateBody, "utf8"),
      body_content_hash: createHash("sha256").update(oldStateBody).digest("hex"),
    };
    oldState.published_title = "Public legacy activity state";
    oldState.published_summary = "The formerly published activity checkpoint.";
    oldState.public_path = "automations/activity-distiller/state";
    for (const directoryId of [ids.automationsDirectory, ids.activityDirectory]) {
      const directory = inspection.directories.find(({ directory_id }) => (
        directory_id === directoryId
      ))!;
      directory.legacy_public_reachable = true;
      directory.public_title = null;
      directory.public_summary = null;
    }

    const managedInstructionsId = id(939);
    const managedStateId = id(940);
    const managedInstructions = operationalPage(
      bodies,
      "automations/activity-distiller/instructions",
      managedInstructionsId,
    );
    const managedState = operationalPage(
      bodies,
      "automations/activity-distiller/state",
      managedStateId,
    );
    managedInstructions.path = `managed-operational/${managedInstructionsId}`;
    managedState.path = `managed-operational/${managedStateId}`;
    inspection.pages.push(managedInstructions, managedState);
    inspection.readable_document_ids.push(managedInstructionsId, managedStateId);
    inspection.automation_registrations.push({
      id: id(941),
      key: "activity-distiller",
      name: "Activity distiller",
      instructions_document_id: managedInstructionsId,
      state_document_id: managedStateId,
      disabled_at: null,
    });
    const notes = inspection.pages.find(({ document_id }) => (
      document_id === ids.automationNotes
    ))!;
    notes.current_revision = bodies.add(
      id(942),
      `[Compatibility example](context-use://document/${ids.activityDirectory})\n`,
    );
    const repository = new FakeRepository(inspection);

    const report = await migrateCorpusToHypermedia({
      repository,
      bodies,
      assets: { verify: async () => true },
      automationRegistry: { byKey: async () => null, register: async () => undefined },
      template,
    });

    expect(report.status.phase).toBe("ready");
    expect(repository.beginInput?.directories).toContainEqual({
      directory_id: ids.automationsDirectory,
      disposition: "public_compatibility",
    });
    expect(repository.beginInput?.directories).toContainEqual({
      directory_id: ids.activityDirectory,
      disposition: "public_compatibility",
    });
    expect(repository.beginInput?.directories).toContainEqual({
      directory_id: ids.diaryDirectory,
      disposition: "operational",
    });
    const activity = repository.hubWrites.find(({ directory_id }) => (
      directory_id === ids.activityDirectory
    ))!;
    expect(activity.private_revision.body_markdown_for_index ?? "")
      .toBe(activity.public_revision?.body_markdown_for_index ?? "");
    expect(activity.private_revision.body_markdown_for_index)
      .toContain("Public legacy activity state");
    expect(activity.private_revision.body_markdown_for_index)
      .not.toContain("Operator notes");
    expect(activity.private_revision.target_document_ids).toEqual([ids.activityState]);
    const parent = repository.hubWrites.find(({ directory_id }) => (
      directory_id === ids.automationsDirectory
    ))!;
    expect(parent.private_revision.body_markdown_for_index ?? "")
      .toBe(parent.public_revision?.body_markdown_for_index ?? "");
    expect(parent.private_revision.target_document_ids).toEqual([ids.activityDirectory]);
    const notesCompletion = repository.completed.find(({ item_kind, item_id }) => (
      item_kind === "page" && item_id === ids.automationNotes
    ))!;
    expect(notesCompletion.target_document_ids).toEqual([ids.activityDirectory]);
    expect(notesCompletion.body_markdown_for_index).toContain(
      `context-use://document/${ids.activityDirectory}`,
    );
  });

  test("copies an owner-edited compatibility carrier while refreshing only its public projection", async () => {
    const { bodies, inspection, ids } = fixture();
    const state = inspection.pages.find(({ document_id }) => (
      document_id === ids.activityState
    ))!;
    const stateBody = bodies.values.get(state.current_revision.body_object_key)!;
    const artifactId = id(943);
    state.published_revision = state.current_revision;
    state.published_artifact = {
      artifact_id: artifactId,
      projection_generation: "1",
      body_object_key: `documents/public/${artifactId}.md`,
      body_size_bytes: Buffer.byteLength(stateBody, "utf8"),
      body_content_hash: createHash("sha256").update(stateBody).digest("hex"),
    };
    state.published_title = "Public activity state";
    state.published_summary = "The public activity checkpoint.";
    state.public_path = "automations/activity-distiller/state";
    const activity = inspection.directories.find(({ directory_id }) => (
      directory_id === ids.activityDirectory
    ))!;
    activity.legacy_public_reachable = true;
    activity.has_existing_hub = true;
    activity.public_title = null;
    activity.public_summary = null;
    const parent = inspection.directories.find(({ directory_id }) => (
      directory_id === ids.automationsDirectory
    ))!;
    parent.legacy_public_reachable = true;
    const managedInstructionsId = id(948);
    const managedStateId = id(949);
    const managedInstructions = operationalPage(
      bodies,
      "automations/activity-distiller/instructions",
      managedInstructionsId,
    );
    const managedState = operationalPage(
      bodies,
      "automations/activity-distiller/state",
      managedStateId,
    );
    managedInstructions.path = `managed-operational/${managedInstructionsId}`;
    managedState.path = `managed-operational/${managedStateId}`;
    inspection.pages.push(managedInstructions, managedState);
    inspection.readable_document_ids.push(managedInstructionsId, managedStateId);
    inspection.automation_registrations.push({
      id: id(950),
      key: "activity-distiller",
      name: "Activity distiller",
      instructions_document_id: managedInstructionsId,
      state_document_id: managedStateId,
      disabled_at: null,
    });
    const repository = new FakeRepository(inspection);
    const privateBody = "# Owner-edited compatibility carrier\n\nPRIVATE editorial note.\n";
    const privateSource = bodies.add(id(944), privateBody);
    const privateTarget = id(945);
    const publicTarget = id(946);
    repository.hubOverrides.set(ids.activityDirectory, {
      document_id: ids.activityDirectory,
      temporary_path: `automations/activity-distiller/migration-hub-${ids.activityDirectory}`,
      private_revision_mode: "copy",
      public_revision_mode: "render",
      private_revision: {
        revision_id: privateTarget,
        revision_number: 3,
        body_object_key: `documents/private/${privateTarget}.md`,
      },
      public_revision: {
        revision_id: publicTarget,
        revision_number: 2,
        body_object_key: `documents/private/${publicTarget}.md`,
      },
      private_source_revision: privateSource,
      public_source_revision: null,
      public_id: id(947),
    });

    await migrateCorpusToHypermedia({
      repository,
      bodies,
      assets: { verify: async () => true },
      automationRegistry: { byKey: async () => null, register: async () => undefined },
      template,
    });

    expect(bodies.values.get(`documents/private/${privateTarget}.md`)).toBe(privateBody);
    const write = repository.hubWrites.find(({ directory_id }) => (
      directory_id === ids.activityDirectory
    ))!;
    expect(write.private_revision.body_markdown_for_index).toBe(privateBody);
    expect(write.public_revision?.body_markdown_for_index).toContain("Public activity state");
    expect(write.public_revision?.body_markdown_for_index).not.toContain("PRIVATE editorial note");
  });

  test("preserves a private custom automation by registered identity without default comparison", async () => {
    const { bodies, inspection, ids } = fixture();
    const customInstructionsId = id(935);
    inspection.pages.push({
      document_id: customInstructionsId,
      path: "projects/custom-automation",
      title: "Owner automation",
      summary: "A private owner-defined operational contract.",
      archived_at: null,
      current_revision: bodies.add(id(936), "# Owner automation\n\nDo the owner's work.\n"),
      published_revision: null,
      published_artifact: null,
      published_title: null,
      published_summary: null,
      public_path: null,
      public_id: null,
      public_aliases: [],
      is_global_guide: false,
    });
    inspection.readable_document_ids.push(customInstructionsId);
    inspection.directories.find(({ directory_id }) => (
      directory_id === ids.projectsDirectory
    ))!.direct_page_ids.push(customInstructionsId);
    inspection.automation_registrations.push({
      id: id(937),
      key: "owner-automation",
      name: "Owner automation",
      instructions_document_id: customInstructionsId,
      state_document_id: null,
      disabled_at: new Date("2026-01-01T00:00:00Z"),
    });
    const repository = new FakeRepository(inspection);

    const report = await migrateCorpusToHypermedia({
      repository,
      bodies,
      assets: { verify: async () => true },
      automationRegistry: { byKey: async () => null, register: async () => undefined },
      template,
    });

    expect(report.status.phase).toBe("ready");
    expect(repository.beginInput?.automations).toContainEqual({
      key: "owner-automation",
      name: "Owner automation",
      instructions_document_id: customInstructionsId,
      state_document_id: null,
    });
    const hub = repository.hubWrites.find(({ directory_id }) => (
      directory_id === ids.projectsDirectory
    ))!;
    expect(hub.private_revision.target_document_ids).not.toContain(customInstructionsId);
    expect(hub.private_revision.body_markdown_for_index).not.toContain("Owner automation");
  });

  test("a public asset alone never creates a discoverable public hub", async () => {
    const { bodies, inspection, ids } = fixture();
    const projects = inspection.directories.find((directory) => (
      directory.directory_id === ids.projectsDirectory
    ))!;
    const article = inspection.pages.find((page) => page.document_id === ids.article)!;
    projects.legacy_public_reachable = false;
    projects.public_title = null;
    projects.public_summary = null;
    article.published_revision = null;
    article.published_artifact = null;
    article.published_title = null;
    article.published_summary = null;
    article.public_path = null;
    const repository = new FakeRepository(inspection);

    await migrateCorpusToHypermedia({
      repository,
      bodies,
      assets: { verify: async () => true },
      automationRegistry: { byKey: async () => null, register: async () => undefined },
      template,
    });

    const hub = repository.hubWrites.find((write) => (
      write.directory_id === ids.projectsDirectory
    ))!;
    expect(hub.private_revision.target_document_ids).toContain(ids.asset);
    expect(hub.public_revision).toBeNull();
  });

  test("uses the capped neutral title for a long public-only directory prefix", async () => {
    const { bodies, inspection, ids } = fixture();
    const longPrefix = `long-${"a".repeat(300)}`;
    const projects = inspection.directories.find((directory) => (
      directory.directory_id === ids.projectsDirectory
    ))!;
    const article = inspection.pages.find((page) => page.document_id === ids.article)!;
    projects.path = longPrefix;
    projects.parent_path = "";
    projects.public_title = null;
    projects.public_summary = null;
    article.public_path = `${longPrefix}/article`;
    const repository = new FakeRepository(inspection);

    await migrateCorpusToHypermedia({
      repository,
      bodies,
      assets: { verify: async () => true },
      automationRegistry: { byKey: async () => null, register: async () => undefined },
      template,
    });

    const hub = repository.hubWrites.find(({ directory_id }) => (
      directory_id === ids.projectsDirectory
    ))!;
    const heading = hub.public_revision!.body_markdown_for_index.split("\n", 1)[0]!;
    expect(heading).toBe(`# ${longPrefix.replaceAll("-", " ").slice(0, 240)}`);
    expect([...heading.slice(2)]).toHaveLength(240);
  });

  test("blocks a modified managed automation contract before planning or object writes", async () => {
    const { bodies, inspection } = fixture();
    const instructions = inspection.pages.find((page) => (
      page.path === "automations/activity-distiller/instructions"
    ))!;
    instructions.current_revision = bodies.add(id(999), "# Locally replaced instructions\n");
    const repository = new FakeRepository(inspection);

    await expect(migrateCorpusToHypermedia({
      repository,
      bodies,
      assets: { verify: async () => true },
      automationRegistry: { byKey: async () => null, register: async () => undefined },
      template,
    })).rejects.toMatchObject({
      name: "CorpusMigrationBlockedError",
      blockers: [expect.objectContaining({
        code: "operational_contract_conflict",
        item_id: instructions.document_id,
      })],
    } satisfies Partial<CorpusMigrationBlockedError>);
    expect(repository.beginInput).toBeNull();
    expect(bodies.writes).toEqual([]);
  });

  test("preserves mutable create-only automation state while registering its identity", async () => {
    const { bodies, inspection } = fixture();
    const state = inspection.pages.find((page) => (
      page.path === "automations/activity-distiller/state"
    ))!;
    state.current_revision = bodies.add(
      id(997),
      "# Activity distiller state\n\n**Checkpoint:** 42\n\nOwner-maintained note.\n",
    );
    const repository = new FakeRepository(inspection);
    const registered: Array<{ key: string; state: string | null }> = [];

    const report = await migrateCorpusToHypermedia({
      repository,
      bodies,
      assets: { verify: async () => true },
      automationRegistry: {
        byKey: async () => null,
        register: async ({ key, state_document_id }) => {
          registered.push({ key, state: state_document_id });
        },
      },
      template,
    });

    expect(report.status.phase).toBe("ready");
    expect(registered).toContainEqual({ key: "activity-distiller", state: state.document_id });
    expect(bodies.values.get(state.current_revision.body_object_key)).toContain("**Checkpoint:** 42");
  });

  test("blocks a structurally corrupt default automation state before planning", async () => {
    const { bodies, inspection } = fixture();
    const state = inspection.pages.find((page) => (
      page.path === "automations/activity-distiller/state"
    ))!;
    state.current_revision = bodies.add(id(996), "# Owner state\n\nNo checkpoint marker.\n");
    const repository = new FakeRepository(inspection);

    await expect(migrateCorpusToHypermedia({
      repository,
      bodies,
      assets: { verify: async () => true },
      automationRegistry: { byKey: async () => null, register: async () => undefined },
      template,
    })).rejects.toMatchObject({
      name: "CorpusMigrationBlockedError",
      blockers: [expect.objectContaining({
        code: "operational_contract_conflict",
        item_id: state.document_id,
      })],
    } satisfies Partial<CorpusMigrationBlockedError>);
    expect(repository.beginInput).toBeNull();
    expect(bodies.writes).toEqual([]);
  });

  test("reports an existing automation identity conflict as an audited blocker", async () => {
    const { bodies, inspection } = fixture();
    const repository = new FakeRepository(inspection);

    await expect(migrateCorpusToHypermedia({
      repository,
      bodies,
      assets: { verify: async () => true },
      automationRegistry: {
        byKey: async () => null,
        register: async ({ key }) => {
          if (key === "activity-distiller") {
            throw new AutomationRegistryIdentityConflictError(key);
          }
        },
      },
      template,
    })).rejects.toMatchObject({
      name: "CorpusMigrationBlockedError",
      blockers: [{
        code: "automation_registry_identity_conflict",
        detail: "Automation registry identity conflicts for key activity-distiller",
      }],
    } satisfies Partial<CorpusMigrationBlockedError>);
  });

  test("does not replay a stale planned name over a live renamed and disabled registration", async () => {
    const { bodies, inspection, ids } = fixture();
    const repository = new FakeRepository(inspection);
    const disabledAt = new Date("2026-01-01T00:00:00Z");
    const live = {
      id: id(700),
      key: "activity-distiller",
      name: "Owner renamed during migration",
      instructions_document_id: ids.activityInstructions,
      state_document_id: ids.activityState,
      created_at: new Date(0),
      updated_at: new Date(),
      disabled_at: disabledAt,
    };
    const registered: string[] = [];

    const report = await migrateCorpusToHypermedia({
      repository,
      bodies,
      assets: { verify: async () => true },
      automationRegistry: {
        byKey: async (key) => key === live.key ? live : null,
        register: async ({ key }) => { registered.push(key); },
      },
      template,
    });

    expect(report.status.phase).toBe("ready");
    expect(live).toMatchObject({
      name: "Owner renamed during migration",
      disabled_at: disabledAt,
    });
    expect(registered).toEqual(["diary-composer"]);
  });

  test("completes a legacy source record that has no body revision", async () => {
    const { bodies, inspection } = fixture();
    const recordId = id(996);
    inspection.records.push({
      document_id: recordId,
      integration: "legacy",
      connection_id: "legacy-connection",
      connection_instance_id: null,
      model: "record",
      source_record_id: "body-pending",
      source_created_at: null,
      source_updated_at: new Date(0),
      deleted_at: null,
      current_revision: null,
    });
    const repository = new FakeRepository(inspection);

    const report = await migrateCorpusToHypermedia({
      repository,
      bodies,
      assets: { verify: async () => true },
      automationRegistry: { byKey: async () => null, register: async () => undefined },
      template,
    });

    expect(report.status.phase).toBe("ready");
    expect(repository.completed).toContainEqual(expect.objectContaining({
      item_kind: "record",
      item_id: recordId,
      verified_revision_ids: [],
    }));
  });

  test("preserves a knowledge link to a tombstoned source-record identity", async () => {
    const { bodies, inspection, ids } = fixture();
    const tombstoneId = id(994);
    const tombstoneRevision = bodies.add(id(995), "# Deleted upstream record\n");
    inspection.records.push({
      document_id: tombstoneId,
      integration: "gmail",
      connection_id: "gmail",
      connection_instance_id: id(219),
      model: "message",
      source_record_id: "deleted-message",
      source_created_at: new Date(0),
      source_updated_at: new Date(1),
      deleted_at: new Date(2),
      current_revision: tombstoneRevision,
    });
    inspection.readable_document_ids.push(tombstoneId);
    const article = inspection.pages.find((page) => page.document_id === ids.article)!;
    article.current_revision = bodies.add(
      id(993),
      `${bodies.values.get(article.current_revision.body_object_key)!}\n`
        + `[Deleted evidence](context-use://document/${tombstoneId})\n`,
    );
    const repository = new FakeRepository(inspection);

    await migrateCorpusToHypermedia({
      repository,
      bodies,
      assets: { verify: async () => true },
      automationRegistry: { byKey: async () => null, register: async () => undefined },
      template,
    });

    const rewrite = repository.pageWrites.find((write) => write.document_id === ids.article)!;
    expect(rewrite.body_markdown_for_index).toContain(
      `context-use://document/${tombstoneId}`,
    );
    expect(rewrite.target_document_ids).toContain(tombstoneId);
    expect(repository.completed).toContainEqual(expect.objectContaining({
      item_kind: "record",
      item_id: tombstoneId,
      verified_revision_ids: [tombstoneRevision.revision_id],
    }));
  });

  test("preserves a canonical link to an archived page without path-resolving it", async () => {
    const { bodies, inspection, ids } = fixture();
    const archivedPageId = id(992);
    inspection.readable_document_ids.push(archivedPageId);
    const article = inspection.pages.find((page) => page.document_id === ids.article)!;
    article.current_revision = bodies.add(
      id(991),
      `${bodies.values.get(article.current_revision.body_object_key)!}\n`
        + `[Archived note](context-use://document/${archivedPageId})\n`
        + "[[archived-note|Path lookup stays inactive]]\n",
    );
    const repository = new FakeRepository(inspection);

    await migrateCorpusToHypermedia({
      repository,
      bodies,
      assets: { verify: async () => true },
      automationRegistry: { byKey: async () => null, register: async () => undefined },
      template,
    });

    const rewrite = repository.pageWrites.find((write) => write.document_id === ids.article)!;
    expect(rewrite.body_markdown_for_index).toContain(
      `[Archived note](context-use://document/${archivedPageId})`,
    );
    expect(rewrite.target_document_ids).toContain(archivedPageId);
    expect(rewrite.body_markdown_for_index).toContain("Path lookup stays inactive");
    expect(rewrite.body_markdown_for_index).not.toContain("[[archived-note");
  });

  test("a ready retry re-audits the seal without replaying historical allocations", async () => {
    const { bodies, inspection } = fixture();
    const repository = new FakeRepository(inspection, "ready");
    const verified: string[] = [];
    await migrateCorpusToHypermedia({
      repository,
      bodies,
      assets: { verify: async (key) => { verified.push(key); return true; } },
      automationRegistry: {
        byKey: async () => null,
        register: async () => { throw new Error("must not reregister"); },
      },
      template,
    });
    expect(repository.completed).toEqual([]);
    expect(repository.pageWrites).toEqual([]);
    expect(repository.hubWrites).toEqual([]);
    expect(bodies.writes).toEqual([]);
    expect(verified).toHaveLength(2);
  });

  test("a completed first preparation is byte-write-free on the next command", async () => {
    const { bodies, inspection } = fixture();
    const repository = new FakeRepository(inspection);
    const input = {
      repository,
      bodies,
      assets: { verify: async () => true },
      automationRegistry: { byKey: async () => null, register: async () => undefined },
      template,
    };
    await migrateCorpusToHypermedia(input);
    const writesAfterFirst = bodies.writes.length;
    const pageWritesAfterFirst = repository.pageWrites.length;
    const hubWritesAfterFirst = repository.hubWrites.length;

    await migrateCorpusToHypermedia(input);

    expect(bodies.writes).toHaveLength(writesAfterFirst);
    expect(repository.pageWrites).toHaveLength(pageWritesAfterFirst);
    expect(repository.hubWrites).toHaveLength(hubWritesAfterFirst);
  });

  test("a ready deploy fails if a rewritten current page object is missing", async () => {
    const { bodies, inspection, ids } = fixture();
    const repository = new FakeRepository(inspection);
    const input = {
      repository,
      bodies,
      assets: { verify: async () => true },
      automationRegistry: { byKey: async () => null, register: async () => undefined },
      template,
    };
    await migrateCorpusToHypermedia(input);
    const rewritten = repository.pageWrites.find((write) => write.document_id === ids.article)!;
    bodies.values.delete(rewritten.revision.body_object_key);

    await expect(migrateCorpusToHypermedia(input)).rejects.toMatchObject({
      name: "CorpusMigrationObjectError",
      documentKind: "knowledge",
      documentId: ids.article,
    });
  });

  test("a ready deploy verifies a distinct pinned published page object without indexing it", async () => {
    const { bodies, inspection, ids } = fixture();
    const repository = new FakeRepository(inspection, "ready");
    const article = inspection.pages.find((page) => page.document_id === ids.article)!;
    bodies.values.delete(article.published_revision!.body_object_key);

    await expect(migrateCorpusToHypermedia({
      repository,
      bodies,
      assets: { verify: async () => true },
      automationRegistry: { byKey: async () => null, register: async () => undefined },
      template,
    })).rejects.toMatchObject({
      name: "CorpusMigrationObjectError",
      documentKind: "published",
      documentId: ids.article,
    });
  });

  test("a ready deploy verifies migrated hub current and public-safe objects", async () => {
    const { bodies, inspection, ids } = fixture();
    const repository = new FakeRepository(inspection);
    const input = {
      repository,
      bodies,
      assets: { verify: async () => true },
      automationRegistry: { byKey: async () => null, register: async () => undefined },
      template,
    };
    await migrateCorpusToHypermedia(input);
    const hub = repository.hubWrites.find((write) => write.directory_id === ids.projectsDirectory)!;
    bodies.values.delete(hub.public_revision!.body_object_key);

    await expect(migrateCorpusToHypermedia(input)).rejects.toMatchObject({
      name: "CorpusMigrationObjectError",
      documentKind: "published",
      documentId: ids.projectsDirectory,
    });
  });

  test("restarts from a fresh inventory after a seal supersedes audited state", async () => {
    const { bodies, inspection } = fixture();
    class SupersededOnceRepository extends FakeRepository {
      inspections = 0;
      seals = 0;
      override async inspectSource() {
        this.inspections += 1;
        return super.inspectSource();
      }
      override async seal(): Promise<CorpusMigrationStatus> {
        this.seals += 1;
        if (this.seals === 1) {
          return {
            ...this.readyStatusForTest(),
            phase: "superseded",
            blockers: [{ code: "inventory_drift", detail: "Audited inventory changed" }],
          };
        }
        return super.seal();
      }
      private readyStatusForTest(): CorpusMigrationStatus {
        return {
          run_id: id(300),
          phase: "ready",
          inventory_token: this.inspection.inventory_token,
          counts: { total: 1, completed: 1 },
          blockers: [],
        };
      }
    }
    const repository = new SupersededOnceRepository(inspection, "ready");
    const report = await migrateCorpusToHypermedia({
      repository,
      bodies,
      assets: { verify: async () => true },
      automationRegistry: { byKey: async () => null, register: async () => undefined },
      template,
    });
    expect(report.status.phase).toBe("ready");
    expect(repository.inspections).toBe(2);
    expect(repository.seals).toBe(2);
  });

  test("supersedes a ready run before interpreting its stale operational snapshot", async () => {
    const { bodies, inspection } = fixture();
    const guide = inspection.pages.find((page) => page.path === "agents")!;
    guide.current_revision = bodies.add(id(980), "# Stale guide contract\n");
    inspection.active_run_id = id(300);
    class ReadyUpgradeRepository extends FakeRepository {
      sealCalls = 0;
      override async seal(): Promise<CorpusMigrationStatus> {
        this.sealCalls += 1;
        if (this.inspection.active_run_id) {
          this.inspection.active_run_id = null;
          guide.current_revision = bodies.add(id(981), template.root_guide.body_markdown);
          return {
            run_id: id(300),
            phase: "superseded",
            inventory_token: this.inspection.inventory_token,
            counts: { total: 1, completed: 1 },
            blockers: [{ code: "inventory_drift", detail: "Managed guide advanced" }],
          };
        }
        return super.seal();
      }
    }
    const repository = new ReadyUpgradeRepository(inspection, "ready");
    const report = await migrateCorpusToHypermedia({
      repository,
      bodies,
      assets: { verify: async () => true },
      automationRegistry: { byKey: async () => null, register: async () => undefined },
      template,
    });
    expect(report.status.phase).toBe("ready");
    expect(repository.sealCalls).toBeGreaterThanOrEqual(2);
    expect(bodies.writes).toEqual([]);
  });

  test("retries an applying boundary only for the typed committed-drift signal", async () => {
    const { bodies, inspection, ids } = fixture();
    class ApplyingDriftRepository extends FakeRepository {
      failed = false;
      override async applyPage(input: Parameters<CorpusMigrationRepositoryLike["applyPage"]>[0]) {
        if (!this.failed) {
          this.failed = true;
          throw new CorpusMigrationInventoryDriftError(
            "simulated audited database drift",
            id(300),
          );
        }
        return super.applyPage(input);
      }
    }
    const repository = new ApplyingDriftRepository(inspection);
    const report = await migrateCorpusToHypermedia({
      repository,
      bodies,
      assets: { verify: async () => true },
      automationRegistry: { byKey: async () => null, register: async () => undefined },
      template,
    });
    expect(report.status.phase).toBe("ready");
    expect(repository.failed).toBeTrue();
    expect(repository.pageWrites).toHaveLength(1);
    expect(repository.pageWrites[0]!.document_id).toBe(ids.article);
  });

  test("retries a typed stale-inventory race before a run is allocated", async () => {
    const { bodies, inspection } = fixture();
    class BeginDriftRepository extends FakeRepository {
      beginCalls = 0;
      override async beginOrResume(
        input: Parameters<CorpusMigrationRepositoryLike["beginOrResume"]>[0],
      ): Promise<CorpusMigrationPlan> {
        this.beginCalls += 1;
        if (this.beginCalls === 1) {
          throw new CorpusMigrationInventoryDriftError("simulated stale inventory");
        }
        return super.beginOrResume(input);
      }
    }
    const repository = new BeginDriftRepository(inspection);

    const report = await migrateCorpusToHypermedia({
      repository,
      bodies,
      assets: { verify: async () => true },
      automationRegistry: { byKey: async () => null, register: async () => undefined },
      template,
    });

    expect(report.status.phase).toBe("ready");
    expect(repository.beginCalls).toBe(2);
  });

  test("does not retry an untyped transient repository failure", async () => {
    const { bodies, inspection } = fixture();
    const transient = new Error("simulated transient database failure");
    class TransientRepository extends FakeRepository {
      beginCalls = 0;
      override async beginOrResume(): Promise<CorpusMigrationPlan> {
        this.beginCalls += 1;
        throw transient;
      }
    }
    const repository = new TransientRepository(inspection);

    await expect(migrateCorpusToHypermedia({
      repository,
      bodies,
      assets: { verify: async () => true },
      automationRegistry: { byKey: async () => null, register: async () => undefined },
      template,
    })).rejects.toBe(transient);
    expect(repository.beginCalls).toBe(1);
  });

  test("bounds repeated typed inventory drift to three fresh attempts", async () => {
    const { bodies, inspection } = fixture();
    class RepeatedDriftRepository extends FakeRepository {
      beginCalls = 0;
      override async beginOrResume(): Promise<CorpusMigrationPlan> {
        this.beginCalls += 1;
        throw new CorpusMigrationInventoryDriftError("simulated repeated drift");
      }
    }
    const repository = new RepeatedDriftRepository(inspection);

    await expect(migrateCorpusToHypermedia({
      repository,
      bodies,
      assets: { verify: async () => true },
      automationRegistry: { byKey: async () => null, register: async () => undefined },
      template,
    })).rejects.toMatchObject({
      name: "CorpusMigrationBlockedError",
      blockers: [expect.objectContaining({ code: "migration_retry_exhausted" })],
    });
    expect(repository.beginCalls).toBe(3);
  });

  test("creates public hierarchy from frozen public paths and applies child hubs before page links", async () => {
    const { bodies, inspection, ids } = fixture();
    const publicChild = id(21);
    const privateDrafts = id(22);
    const root = inspection.directories.find((directory) => directory.path === "")!;
    const projects = inspection.directories.find((directory) => (
      directory.directory_id === ids.projectsDirectory
    ))!;
    const article = inspection.pages.find((page) => page.document_id === ids.article)!;
    const asset = inspection.assets.find((candidate) => candidate.document_id === ids.asset)!;
    root.direct_directory_ids.push(privateDrafts);
    projects.direct_directory_ids = [publicChild];
    projects.title = "PRIVATE project taxonomy";
    projects.summary = "PRIVATE project taxonomy summary.";
    projects.public_title = null;
    projects.public_summary = null;
    projects.direct_page_ids = [];
    projects.direct_asset_ids = [];
    article.path = "private-drafts/article";
    article.public_path = "projects/published/article";
    asset.path = "private-drafts/photo";
    asset.public_path = "projects/published/photo";
    inspection.directories.push(
      {
        directory_id: publicChild,
        path: "projects/published",
        parent_path: "projects",
        version_number: 1,
        title: "PRIVATE child taxonomy",
        summary: "PRIVATE child taxonomy summary.",
        created_at: new Date(0),
        updated_at: new Date(0),
        legacy_public_reachable: true,
        public_title: null,
        public_summary: null,
        has_existing_hub: false,
        direct_directory_ids: [],
        direct_page_ids: [],
        direct_asset_ids: [],
      },
      {
        directory_id: privateDrafts,
        path: "private-drafts",
        parent_path: "",
        version_number: 1,
        title: "Private drafts",
        summary: "Current private placement.",
        created_at: new Date(0),
        updated_at: new Date(0),
        legacy_public_reachable: false,
        public_title: null,
        public_summary: null,
        has_existing_hub: false,
        direct_directory_ids: [],
        direct_page_ids: [ids.article],
        direct_asset_ids: [ids.asset],
      },
    );
    const repository = new FakeRepository(inspection);

    await migrateCorpusToHypermedia({
      repository,
      bodies,
      assets: { verify: async () => true },
      automationRegistry: { byKey: async () => null, register: async () => undefined },
      template,
    });

    const childWrite = repository.hubWrites.find((write) => write.directory_id === publicChild)!;
    const projectWrite = repository.hubWrites.find((write) => (
      write.directory_id === ids.projectsDirectory
    ))!;
    const privateWrite = repository.hubWrites.find((write) => write.directory_id === privateDrafts)!;
    const publicChildBody = bodies.values.get(childWrite.public_revision!.body_object_key)!;
    const publicProjectBody = bodies.values.get(projectWrite.public_revision!.body_object_key)!;
    expect(publicChildBody).toContain("Public article");
    expect(publicChildBody).not.toContain("PRIVATE photo");
    expect(publicChildBody).not.toContain("PRIVATE current title");
    expect(publicChildBody).not.toContain("PRIVATE child taxonomy");
    expect(childWrite.public_revision!.target_document_ids).toEqual([ids.article]);
    expect(publicProjectBody).toContain(`context-use://document/${publicChild}`);
    expect(publicProjectBody).toContain("[published]");
    expect(publicProjectBody).not.toContain("PRIVATE project taxonomy");
    expect(publicProjectBody).not.toContain("PRIVATE child taxonomy");
    expect(publicProjectBody).not.toContain(`context-use://document/${ids.article}`);
    expect(privateWrite.private_revision.body_markdown_for_index).toContain("PRIVATE current title");
    expect(projectWrite.private_revision.body_markdown_for_index).not.toContain("PRIVATE current title");
    expect(repository.events.indexOf(`hub:${publicChild}`)).toBeLessThan(
      repository.events.indexOf(`hub:${ids.projectsDirectory}`),
    );
    expect(repository.events.indexOf(`hub:${ids.projectsDirectory}`)).toBeLessThan(
      repository.events.indexOf(`page:${ids.article}`),
    );
  });

  for (const collisionKind of ["page", "asset"] as const) {
    test(`keeps a private ${collisionKind} colliding with a synthetic public prefix out of its public hub`, async () => {
      const { bodies, inspection, ids } = fixture();
      const syntheticPrefix = id(collisionKind === "page" ? 989 : 990);
      const projects = inspection.directories.find((directory) => (
        directory.directory_id === ids.projectsDirectory
      ))!;
      const article = inspection.pages.find((page) => page.document_id === ids.article)!;
      projects.direct_directory_ids = [syntheticPrefix];
      article.public_path = "projects/archive/article";
      inspection.directories.push({
        directory_id: syntheticPrefix,
        path: "projects/archive",
        parent_path: "projects",
        version_number: 1,
        title: "archive",
        summary: "Published knowledge formerly available under this public collection.",
        created_at: new Date(0),
        updated_at: new Date(0),
        legacy_public_reachable: true,
        public_title: null,
        public_summary: null,
        has_existing_hub: false,
        direct_directory_ids: [],
        direct_page_ids: [],
        direct_asset_ids: [],
      });
      if (collisionKind === "page") {
        const collisionId = id(991);
        inspection.pages.push({
          document_id: collisionId,
          path: "projects/archive",
          title: "PRIVATE colliding page",
          summary: "Private page occupying the public directory stem.",
          archived_at: null,
          current_revision: bodies.add(id(992), "# PRIVATE colliding page\n"),
          published_revision: null,
          published_artifact: null,
          published_title: null,
          published_summary: null,
          public_path: null,
          public_id: null,
          public_aliases: [],
          is_global_guide: false,
        });
        inspection.readable_document_ids.push(collisionId);
        projects.direct_page_ids.push(collisionId);
      } else {
        const asset = inspection.assets.find((candidate) => candidate.document_id === ids.asset)!;
        asset.path = "projects/archive";
        asset.public_path = null;
      }
      const repository = new FakeRepository(inspection);

      await migrateCorpusToHypermedia({
        repository,
        bodies,
        assets: { verify: async () => true },
        automationRegistry: { byKey: async () => null, register: async () => undefined },
        template,
      });

      const prefix = repository.hubWrites.find(({ directory_id }) => (
        directory_id === syntheticPrefix
      ))!;
      const publicBody = prefix.public_revision!.body_markdown_for_index;
      expect(publicBody).toContain("Public article");
      expect(publicBody).not.toContain("PRIVATE colliding page");
      expect(publicBody).not.toContain("PRIVATE photo");
      expect(prefix.public_revision!.target_document_ids).toEqual([ids.article]);
    });
  }

  test("publishes existing parent and child hubs child-first when both gain reachability", async () => {
    const { bodies, inspection, ids } = fixture();
    const childId = id(978);
    const projects = inspection.directories.find((directory) => (
      directory.directory_id === ids.projectsDirectory
    ))!;
    const article = inspection.pages.find((page) => page.document_id === ids.article)!;
    projects.has_existing_hub = true;
    projects.direct_directory_ids = [childId];
    projects.direct_page_ids = [];
    article.public_path = "projects/child/article";
    inspection.directories.push({
      directory_id: childId,
      path: "projects/child",
      parent_path: "projects",
      version_number: 1,
      title: "Child",
      summary: "Child knowledge.",
      created_at: new Date(0),
      updated_at: new Date(0),
      legacy_public_reachable: true,
      public_title: "Child",
      public_summary: "Child knowledge.",
      has_existing_hub: true,
      direct_directory_ids: [],
      direct_page_ids: [ids.article],
      direct_asset_ids: [],
    });
    const repository = new FakeRepository(inspection);
    const configureGain = (directoryId: string, sequence: number) => {
      const source = bodies.add(id(sequence), `# Existing ${directoryId}\n`);
      const privateTarget = id(sequence + 1);
      const publicTarget = id(sequence + 2);
      repository.hubOverrides.set(directoryId, {
        document_id: directoryId,
        temporary_path: `${inspection.directories.find(({ directory_id }) => (
          directory_id === directoryId
        ))!.path}/migration-hub-${directoryId}`,
        private_revision_mode: "copy",
        public_revision_mode: "render",
        private_revision: {
          revision_id: privateTarget,
          revision_number: 3,
          body_object_key: `documents/private/${privateTarget}.md`,
        },
        public_revision: {
          revision_id: publicTarget,
          revision_number: 2,
          body_object_key: `documents/private/${publicTarget}.md`,
        },
        private_source_revision: source,
        public_source_revision: null,
        public_id: id(sequence + 3),
      });
    };
    configureGain(ids.projectsDirectory, 970);
    configureGain(childId, 974);

    await migrateCorpusToHypermedia({
      repository,
      bodies,
      assets: { verify: async () => true },
      automationRegistry: { byKey: async () => null, register: async () => undefined },
      template,
    });

    expect(repository.events.indexOf(`hub:${childId}`)).toBeLessThan(
      repository.events.indexOf(`hub:${ids.projectsDirectory}`),
    );
    const parent = repository.hubWrites.find(({ directory_id }) => (
      directory_id === ids.projectsDirectory
    ))!;
    expect(parent.public_revision?.target_document_ids).toEqual([childId]);
  });

  test("fails closed if a repository plan tries to regenerate an existing private hub", async () => {
    const { bodies, inspection, ids } = fixture();
    const projects = inspection.directories.find((directory) => (
      directory.directory_id === ids.projectsDirectory
    ))!;
    projects.has_existing_hub = true;
    const repository = new FakeRepository(inspection);

    await expect(migrateCorpusToHypermedia({
      repository,
      bodies,
      assets: { verify: async () => true },
      automationRegistry: { byKey: async () => null, register: async () => undefined },
      template,
    })).rejects.toMatchObject({
      name: "CorpusMigrationBlockedError",
      blockers: [expect.objectContaining({
        code: "existing_hub_regeneration_forbidden",
        item_id: ids.projectsDirectory,
      })],
    } satisfies Partial<CorpusMigrationBlockedError>);
    expect(bodies.writes).toEqual([]);
  });

  test("preserves private child drift when a ready hub becomes ordinary owner-maintained knowledge", async () => {
    const { bodies, inspection, ids } = fixture();
    const projects = inspection.directories.find((directory) => (
      directory.directory_id === ids.projectsDirectory
    ))!;
    projects.has_existing_hub = true;
    inspection.active_run_id = id(300);
    class OwnerEditedReadyRepository extends FakeRepository {
      private staleReady = true;

      override async seal(): Promise<CorpusMigrationStatus> {
        if (this.staleReady) {
          this.staleReady = false;
          this.inspection.active_run_id = null;
          this.phase = "applying";
          return {
            run_id: id(300),
            phase: "superseded",
            inventory_token: this.inspection.inventory_token,
            counts: { total: 0, completed: 0 },
            blockers: [{
              code: "hub_current_revision_drift",
              item_kind: "directory",
              item_id: ids.projectsDirectory,
              detail: "Mapped hub current revision advanced after the ready audit",
            }],
          };
        }
        return super.seal();
      }
    }
    const repository = new OwnerEditedReadyRepository(inspection, "ready");
    const danglingDocumentId = id(979);
    const privateBody = [
      "# Owner-curated projects",
      "",
      `[Article](context-use://document/${ids.article})`,
      `[Former note](context-use://document/${danglingDocumentId})`,
      "",
    ].join("\n");
    const publicBody = `# Published projects\n\n[Article](context-use://document/${ids.article})\n`;
    const privateSource = bodies.add(id(980), privateBody);
    const publicSource = bodies.add(id(981), publicBody);
    repository.hubOverrides.set(ids.projectsDirectory, {
      document_id: ids.projectsDirectory,
      temporary_path: `projects/migration-hub-${ids.projectsDirectory}`,
      private_revision_mode: "existing",
      public_revision_mode: "existing",
      private_revision: {
        revision_id: privateSource.revision_id,
        revision_number: privateSource.revision_number,
        body_object_key: privateSource.body_object_key,
      },
      public_revision: {
        revision_id: publicSource.revision_id,
        revision_number: publicSource.revision_number,
        body_object_key: publicSource.body_object_key,
      },
      private_source_revision: privateSource,
      public_source_revision: publicSource,
      public_body_markdown: publicBody,
      public_id: id(982),
    });
    const writesBefore = bodies.writes.length;

    await migrateCorpusToHypermedia({
      repository,
      bodies,
      assets: { verify: async () => true },
      automationRegistry: { byKey: async () => null, register: async () => undefined },
      template,
    });

    const hub = repository.hubWrites.find((write) => (
      write.directory_id === ids.projectsDirectory
    ))!;
    expect(hub.private_revision.body_markdown_for_index).toBe(privateBody);
    expect(hub.private_revision.body_markdown_for_index).not.toContain("PRIVATE photo.png");
    expect(hub.public_revision?.body_markdown_for_index).toBe(publicBody);
    expect(hub.private_revision.target_document_ids).toEqual([
      ids.article,
      danglingDocumentId,
    ]);
    expect(bodies.writes).toHaveLength(writesBefore + 1); // only the article rewrite
    expect(bodies.writes.some(({ revisionId }) => (
      revisionId === privateSource.revision_id || revisionId === publicSource.revision_id
    ))).toBeFalse();
    expect(repository.pageWrites[0]!.target_document_ids).toContain(ids.projectsDirectory);
  });

  test("copies an owner-maintained private hub byte-exact when public reachability is gained", async () => {
    const { bodies, inspection, ids } = fixture();
    const projects = inspection.directories.find((directory) => (
      directory.directory_id === ids.projectsDirectory
    ))!;
    projects.has_existing_hub = true;
    const repository = new FakeRepository(inspection);
    const privateBody = "# Curated by the owner\n\nThis body must not be regenerated.\n";
    const privateSource = bodies.add(id(983), privateBody);
    const privateTarget = id(984);
    const publicTarget = id(985);
    repository.hubOverrides.set(ids.projectsDirectory, {
      document_id: ids.projectsDirectory,
      temporary_path: `projects/migration-hub-${ids.projectsDirectory}`,
      private_revision_mode: "copy",
      public_revision_mode: "render",
      private_revision: {
        revision_id: privateTarget,
        revision_number: 3,
        body_object_key: `documents/private/${privateTarget}.md`,
      },
      public_revision: {
        revision_id: publicTarget,
        revision_number: 2,
        body_object_key: `documents/private/${publicTarget}.md`,
      },
      private_source_revision: privateSource,
      public_source_revision: null,
      public_id: id(986),
    });

    await migrateCorpusToHypermedia({
      repository,
      bodies,
      assets: { verify: async () => true },
      automationRegistry: { byKey: async () => null, register: async () => undefined },
      template,
    });

    expect(bodies.values.get(`documents/private/${privateTarget}.md`)).toBe(privateBody);
    const hub = repository.hubWrites.find((write) => (
      write.directory_id === ids.projectsDirectory
    ))!;
    expect(hub.private_revision.body_markdown_for_index).toBe(privateBody);
    expect(hub.public_revision?.body_markdown_for_index).toContain("Public article");
    expect(hub.public_revision?.body_markdown_for_index).not.toContain("Curated by the owner");
  });

  test("tombstones lost public reachability without overwriting the private hub", async () => {
    const { bodies, inspection, ids } = fixture();
    const projects = inspection.directories.find((directory) => (
      directory.directory_id === ids.projectsDirectory
    ))!;
    const article = inspection.pages.find((page) => page.document_id === ids.article)!;
    const asset = inspection.assets.find((candidate) => candidate.document_id === ids.asset)!;
    projects.has_existing_hub = true;
    projects.legacy_public_reachable = false;
    projects.public_title = null;
    projects.public_summary = null;
    article.published_revision = null;
    article.published_artifact = null;
    article.published_title = null;
    article.published_summary = null;
    article.public_path = null;
    asset.public_path = null;
    const repository = new FakeRepository(inspection);
    const privateBody = "# Still owner-maintained\n\nNo public projection remains.\n";
    const privateSource = bodies.add(id(987), privateBody);
    repository.hubOverrides.set(ids.projectsDirectory, {
      document_id: ids.projectsDirectory,
      temporary_path: `projects/migration-hub-${ids.projectsDirectory}`,
      private_revision_mode: "existing",
      public_revision_mode: null,
      private_revision: {
        revision_id: privateSource.revision_id,
        revision_number: privateSource.revision_number,
        body_object_key: privateSource.body_object_key,
      },
      public_revision: null,
      private_source_revision: privateSource,
      public_source_revision: null,
      public_id: id(988),
    });

    await migrateCorpusToHypermedia({
      repository,
      bodies,
      assets: { verify: async () => true },
      automationRegistry: { byKey: async () => null, register: async () => undefined },
      template,
    });

    const hub = repository.hubWrites.find((write) => (
      write.directory_id === ids.projectsDirectory
    ))!;
    expect(hub.private_revision.body_markdown_for_index).toBe(privateBody);
    expect(hub.public_revision).toBeNull();
    expect(bodies.writes.some(({ revisionId }) => revisionId === privateSource.revision_id)).toBeFalse();
  });
});
