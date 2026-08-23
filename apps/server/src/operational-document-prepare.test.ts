import { describe, expect, test } from "bun:test";
import {
  AutomationRegistryIdentityConflictError,
  OperationalDocumentReplacementDriftError,
  VersionConflictError,
  knowledgeTemplateMigrationContract,
  markdownObjectMetadata,
  type AutomationRegistration,
  type KnowledgeTemplateMigrationContract,
  type MarkdownObjectMetadata,
  type MarkdownObjectStore,
  type OperationalDocumentReplacementPlan,
  type OperationalDocumentReplacementTarget,
} from "@context-use/database";
import {
  operationalTemplateSkipPaths,
  reconcileManagedOperationalDocuments,
  type OperationalDocumentPreparationRepositories,
} from "./operational-document-prepare.ts";
import type { ResolvedAutomationRegistration } from "./corpus-migration.ts";

const template = await knowledgeTemplateMigrationContract("default");
const TEMPLATE_ACTOR = "context-use-template/default";

function id(sequence: number): string {
  return `00000000-0000-4000-8000-${sequence.toString().padStart(12, "0")}`;
}

type FakePage = {
  id: string;
  current_path: string;
  current_version_id: string;
  published_version_id: string | null;
  public_path: string | null;
  archived_at: null;
  version_number: number;
  title: string;
  summary: string;
  body_markdown: string;
  actor_subject: string;
};

function contract(path: string) {
  return path === "agents"
    ? template.root_guide
    : template.pages.find((page) => page.path === path)!;
}

function page(
  documentId: string,
  path: string,
  options: Partial<FakePage> = {},
): FakePage {
  const desired = contract(path);
  return {
    id: documentId,
    current_path: path,
    current_version_id: id(Number(documentId.slice(-4)) + 100),
    published_version_id: null,
    public_path: null,
    archived_at: null,
    version_number: 1,
    title: desired.title,
    summary: desired.summary,
    body_markdown: desired.body_markdown,
    actor_subject: TEMPLATE_ACTOR,
    ...options,
  };
}

function customPage(
  documentId: string,
  path: string,
  bodyMarkdown: string,
  options: Partial<FakePage> = {},
): FakePage {
  return {
    id: documentId,
    current_path: path,
    current_version_id: id(Number(documentId.slice(-4)) + 100),
    published_version_id: null,
    public_path: null,
    archived_at: null,
    version_number: 1,
    title: "Owner automation",
    summary: "An owner-authored automation contract.",
    body_markdown: bodyMarkdown,
    actor_subject: "context-use-owner",
    ...options,
  };
}

class MemoryBodies implements MarkdownObjectStore {
  readonly values = new Map<string, string>();
  readonly writes: string[] = [];

  async write(revisionId: string, markdown: string): Promise<MarkdownObjectMetadata> {
    const existing = this.values.get(revisionId);
    if (existing !== undefined && existing !== markdown) throw new Error("immutable object conflict");
    this.values.set(revisionId, markdown);
    this.writes.push(revisionId);
    return markdownObjectMetadata(revisionId, markdown);
  }

  async read(metadata: MarkdownObjectMetadata): Promise<string> {
    const revisionId = metadata.body_object_key.split("/").at(-1)!.replace(/\.md$/, "");
    const value = this.values.get(revisionId);
    if (value === undefined) throw new Error("missing object");
    return value;
  }
}

class FakeOperationalRepositories {
  readonly pages = new Map<string, FakePage>();
  readonly registrations = new Map<string, AutomationRegistration>();
  readonly plans = new Map<string, OperationalDocumentReplacementPlan>();
  readonly replacementTargets: OperationalDocumentReplacementTarget[] = [];
  readonly updates: string[] = [];
  readonly bodies: MemoryBodies;
  globalGuideId: string | null;
  nextSequence = 700;
  driftBegins = 0;

  constructor(bodies: MemoryBodies, globalGuideId: string | null) {
    this.bodies = bodies;
    this.globalGuideId = globalGuideId;
  }

  add(page: FakePage): FakePage {
    this.pages.set(page.id, page);
    return page;
  }

  registration(
    key: string,
    instructionsDocumentId: string,
    stateDocumentId: string | null,
    options: Partial<AutomationRegistration> = {},
  ): AutomationRegistration {
    const value: AutomationRegistration = {
      id: id(this.nextSequence++),
      key,
      name: `${key} owner name`,
      instructions_document_id: instructionsDocumentId,
      state_document_id: stateDocumentId,
      created_at: new Date(0),
      updated_at: new Date(0),
      disabled_at: null,
      ...options,
    };
    this.registrations.set(key, value);
    return value;
  }

  asRepositories(): OperationalDocumentPreparationRepositories {
    return {
      settings: {
        get: async () => ({
          global_guide_document_id: this.globalGuideId,
          updated_at: new Date(0),
        }),
      },
      pages: {
        get: async (documentId: string) => this.pages.get(documentId) ?? null,
        getByPath: async (path: string) => [...this.pages.values()].find((item) => (
          item.current_path === path && item.archived_at === null
        )) ?? null,
        metadata: async (documentId: string) => this.pages.get(documentId) ?? null,
        metadataByPath: async (path: string) => [...this.pages.values()].find((item) => (
          item.current_path === path && item.archived_at === null
        )) ?? null,
        version: async (documentId: string, versionNumber: number) => {
          const found = this.pages.get(documentId);
          return found?.version_number === versionNumber
            ? { actor_subject: found.actor_subject }
            : null;
        },
        update: async (documentId: string, input: any, actor: any) => {
          const found = this.pages.get(documentId);
          if (!found) return null;
          if (found.version_number !== input.expected_version_number) {
            throw new VersionConflictError(found.version_number);
          }
          found.current_path = input.path;
          found.current_version_id = id(this.nextSequence++);
          found.version_number += 1;
          found.title = input.title;
          found.summary = input.summary;
          found.body_markdown = input.body_markdown;
          found.actor_subject = actor.subject;
          this.updates.push(documentId);
          return found;
        },
      } as OperationalDocumentPreparationRepositories["pages"],
      registry: {
        byKey: async (key: string) => this.registrations.get(key) ?? null,
        register: async (input) => {
          const current = this.registrations.get(input.key);
          if (current && (
            current.instructions_document_id !== input.instructions_document_id
            || current.state_document_id !== input.state_document_id
          )) throw new AutomationRegistryIdentityConflictError(input.key);
          if (current) return current;
          const value = this.registration(
            input.key,
            input.instructions_document_id,
            input.state_document_id,
            { id: input.id ?? id(this.nextSequence++), name: input.name },
          );
          return value;
        },
      },
      replacements: {
        beginOrResume: async (input) => {
          if (this.driftBegins > 0) {
            this.driftBegins -= 1;
            throw new OperationalDocumentReplacementDriftError(null);
          }
          const key = input.target.kind === "global_guide"
            ? "global"
            : `automation:${input.target.key}`;
          const existing = this.plans.get(key);
          if (existing && existing.source_document_id === input.source_document_id
              && existing.source_revision_id === input.source_revision_id) return existing;
          const replacementDocumentId = id(this.nextSequence++);
          const replacementRevisionId = id(this.nextSequence++);
          const source = this.pages.get(input.source_document_id);
          if (!source) throw new Error("replacement source missing");
          const agentsOccupant = input.target.kind === "global_guide"
            ? [...this.pages.values()].find((item) => item.current_path === "agents") ?? null
            : null;
          const occupantMetadata = agentsOccupant ? markdownObjectMetadata(
            agentsOccupant.current_version_id,
            agentsOccupant.body_markdown,
          ) : null;
          const preservationRevisionId = agentsOccupant
            ? id(this.nextSequence++)
            : null;
          let state: OperationalDocumentReplacementPlan["state"] = null;
          if (input.target.kind === "automation_instructions"
              && input.target.state?.mode === "clone") {
            state = {
              ...input.target.state,
              replacement_document_id: id(this.nextSequence++),
              replacement_path: `managed-operational-${id(this.nextSequence - 1)}`,
              replacement_revision: {
                revision_id: id(this.nextSequence++),
                revision_number: 1 as const,
                body_object_key: `documents/private/${id(this.nextSequence - 1)}.md`,
              },
            };
          } else if (input.target.kind === "automation_instructions"
              && input.target.state?.mode === "existing") {
            state = input.target.state;
          }
          const plan: OperationalDocumentReplacementPlan = {
            replacement_id: id(this.nextSequence++),
            phase: "planned",
            target: input.target,
            source_document_id: input.source_document_id,
            source_revision_id: input.source_revision_id,
            replacement_document_id: replacementDocumentId,
            replacement_path: `managed-operational-${replacementDocumentId}`,
            replacement_revision: {
              revision_id: replacementRevisionId,
              revision_number: 1,
              body_object_key: `documents/private/${replacementRevisionId}.md`,
            },
            managed: input.managed,
            agents_occupant_preservation: preservationRevisionId && agentsOccupant
              && occupantMetadata ? {
              document_id: agentsOccupant.id,
              source_revision_id: agentsOccupant.current_version_id,
              path: `preserved-agents-page-${replacementDocumentId}`,
              title: agentsOccupant.title,
              summary: agentsOccupant.summary,
              revision: {
                revision_id: preservationRevisionId,
                revision_number: agentsOccupant.version_number + 1,
                body_object_key: `documents/private/${preservationRevisionId}.md`,
              },
              body_size_bytes: occupantMetadata.body_size_bytes,
              body_content_hash: occupantMetadata.body_content_hash,
            } : null,
            registration_id: input.target.kind === "automation_instructions"
              ? this.registrations.get(input.target.key)?.id ?? id(this.nextSequence++)
              : null,
            state,
          };
          this.plans.set(key, plan);
          this.replacementTargets.push(input.target);
          return plan;
        },
        apply: async (input) => {
          const entry = [...this.plans.entries()].find(([, value]) => (
            value.replacement_id === input.replacement_id
          ));
          if (!entry) throw new Error("plan missing");
          const [key, plan] = entry;
          const source = this.pages.get(plan.source_document_id);
          if (!source) throw new Error("replacement source missing");
          if (plan.agents_occupant_preservation) {
            if (!input.agents_occupant_preservation) {
              throw new Error("agents occupant preservation missing");
            }
            const occupant = this.pages.get(plan.agents_occupant_preservation.document_id);
            if (!occupant) throw new Error("agents occupant missing");
            occupant.current_path = plan.agents_occupant_preservation.path;
            occupant.current_version_id = plan.agents_occupant_preservation.revision.revision_id;
            occupant.version_number = plan.agents_occupant_preservation.revision.revision_number;
          } else if (input.agents_occupant_preservation) {
            throw new Error("agents occupant preservation was not planned");
          }
          this.add({
            id: plan.replacement_document_id,
            current_path: plan.target.kind === "global_guide" ? "agents" : plan.replacement_path,
            current_version_id: plan.replacement_revision.revision_id,
            published_version_id: null,
            public_path: null,
            archived_at: null,
            version_number: 1,
            title: plan.managed.title,
            summary: plan.managed.summary,
            body_markdown: input.body_markdown_for_index,
            actor_subject: TEMPLATE_ACTOR,
          });
          if (plan.state?.mode === "clone") {
            if (!input.state_clone) throw new Error("state clone missing");
            this.add({
              id: plan.state.replacement_document_id,
              current_path: plan.state.replacement_path,
              current_version_id: plan.state.replacement_revision.revision_id,
              published_version_id: null,
              public_path: null,
              archived_at: null,
              version_number: 1,
              title: plan.state.title,
              summary: plan.state.summary,
              body_markdown: input.state_clone.body_markdown_for_index,
              actor_subject: TEMPLATE_ACTOR,
            });
          }
          if (plan.target.kind === "global_guide") {
            this.globalGuideId = plan.replacement_document_id;
          } else {
            const current = this.registrations.get(plan.target.key);
            const stateDocumentId = plan.state?.mode === "clone"
              ? plan.state.replacement_document_id
              : plan.state?.document_id ?? null;
            this.registrations.set(plan.target.key, {
              id: current?.id ?? plan.registration_id!,
              key: plan.target.key,
              name: current?.name ?? plan.target.name,
              instructions_document_id: plan.replacement_document_id,
              state_document_id: stateDocumentId,
              created_at: current?.created_at ?? new Date(0),
              updated_at: new Date(),
              disabled_at: current?.disabled_at ?? null,
            });
          }
          const applied = { ...plan, phase: "applied" as const };
          this.plans.set(key, applied);
          return applied;
        },
      },
    };
  }
}

function fixture() {
  const bodies = new MemoryBodies();
  const ids = {
    guide: id(1),
    activityInstructions: id(2),
    activityState: id(3),
    diaryInstructions: id(4),
    diaryState: id(5),
  };
  const fake = new FakeOperationalRepositories(bodies, ids.guide);
  fake.add(page(ids.guide, "agents"));
  fake.add(page(ids.activityInstructions, "automations/activity-distiller/instructions"));
  fake.add(page(ids.activityState, "automations/activity-distiller/state"));
  fake.add(page(ids.diaryInstructions, "automations/diary-composer/instructions"));
  fake.add(page(ids.diaryState, "automations/diary-composer/state"));
  return { bodies, fake, repositories: fake.asRepositories(), ids };
}

async function prepare(
  value: ReturnType<typeof fixture>,
  automations: ResolvedAutomationRegistration[] = [],
): Promise<void> {
  await reconcileManagedOperationalDocuments({
    repositories: value.repositories,
    bodies: value.bodies,
    template,
    automations,
  });
}

describe("managed operational document preparation", () => {
  test("replaces a custom global guide and preserves it as an ordinary opaque page", async () => {
    const value = fixture();
    const oldGuide = value.fake.pages.get(value.ids.guide)!;
    oldGuide.body_markdown = "# Owner guide\n";
    oldGuide.actor_subject = "context-use-owner";
    const descendant = value.fake.add({
      ...page(id(20), "agents"),
      current_path: "people/agents",
      body_markdown: "# Owner people guide\n",
      actor_subject: "context-use-owner",
    });

    const skipped = await operationalTemplateSkipPaths({
      repositories: value.repositories,
      template,
    });
    expect(skipped.has("agents")).toBe(true);

    await prepare(value);

    expect(value.fake.globalGuideId).not.toBe(value.ids.guide);
    expect(oldGuide).toMatchObject({
      current_path: expect.stringMatching(/^preserved-agents-page-/),
      body_markdown: "# Owner guide\n",
      actor_subject: "context-use-owner",
    });
    expect(descendant).toMatchObject({
      current_path: "people/agents",
      body_markdown: "# Owner people guide\n",
    });
    expect(value.fake.replacementTargets).toContainEqual({ kind: "global_guide" });
  });

  test("preserves a distinct agents occupant when the configured guide is elsewhere", async () => {
    const value = fixture();
    const occupant = value.fake.pages.get(value.ids.guide)!;
    occupant.body_markdown = "# Owner root page\n";
    occupant.actor_subject = "context-use-owner";
    occupant.published_version_id = occupant.current_version_id;
    occupant.public_path = "agents";
    const configured = value.fake.add(customPage(
      id(21),
      "owner-guidance",
      "# Configured owner guide\n",
    ));
    const configuredRevision = configured.current_version_id;
    value.fake.globalGuideId = configured.id;

    await prepare(value);

    expect(configured).toMatchObject({
      current_path: "owner-guidance",
      current_version_id: configuredRevision,
      body_markdown: "# Configured owner guide\n",
    });
    expect(occupant).toMatchObject({
      current_path: expect.stringMatching(/^preserved-agents-page-/),
      published_version_id: expect.any(String),
      public_path: "agents",
      body_markdown: "# Owner root page\n",
    });
    const configuredReplacement = value.fake.pages.get(value.fake.globalGuideId!)!;
    expect(configuredReplacement.current_path).toBe("agents");
    expect([...value.fake.pages.values()].filter((item) => item.current_path === "agents"))
      .toEqual([configuredReplacement]);
  });

  test("installs the managed guide at agents when the legacy path is empty", async () => {
    const value = fixture();
    value.fake.pages.delete(value.ids.guide);
    const configured = value.fake.add(customPage(
      id(22),
      "owner-guidance",
      "# Configured owner guide\n",
    ));
    value.fake.globalGuideId = configured.id;

    await prepare(value);

    expect(configured.current_path).toBe("owner-guidance");
    expect(value.fake.pages.get(value.fake.globalGuideId!)?.current_path).toBe("agents");
    expect(value.bodies.writes).toHaveLength(1);
  });

  test("retargets a disabled custom instruction without changing its state or owner name", async () => {
    const value = fixture();
    const instructions = value.fake.pages.get(value.ids.activityInstructions)!;
    instructions.body_markdown = "# Owner distiller\n";
    instructions.actor_subject = "context-use-owner";
    const disabledAt = new Date("2026-01-01T00:00:00Z");
    const registration = value.fake.registration(
      "activity-distiller",
      instructions.id,
      value.ids.activityState,
      { name: "Owner distiller name", disabled_at: disabledAt },
    );

    await prepare(value);

    const after = value.fake.registrations.get("activity-distiller")!;
    expect(after.id).toBe(registration.id);
    expect(after.name).toBe("Owner distiller name");
    expect(after.disabled_at).toBe(disabledAt);
    expect(after.instructions_document_id).not.toBe(instructions.id);
    expect(after.state_document_id).toBe(value.ids.activityState);
    expect(instructions.body_markdown).toBe("# Owner distiller\n");
  });

  test("protects an unregistered owner instruction from template force before adopting a replacement", async () => {
    const value = fixture();
    const instructions = value.fake.pages.get(value.ids.activityInstructions)!;
    instructions.body_markdown = "# Owner distiller\n";
    instructions.actor_subject = "context-use-owner";

    const skipped = await operationalTemplateSkipPaths({
      repositories: value.repositories,
      template,
    });
    expect(skipped.has("automations/activity-distiller/instructions")).toBe(true);

    await prepare(value);

    expect(instructions.body_markdown).toBe("# Owner distiller\n");
    expect(value.fake.registrations.get("activity-distiller")?.instructions_document_id)
      .not.toBe(instructions.id);
  });

  test("clones published state byte-exact before atomically retargeting the registry", async () => {
    const value = fixture();
    const state = value.fake.pages.get(value.ids.activityState)!;
    state.body_markdown = "# Activity distiller state\n\n**Checkpoint:** `owner.live`\n";
    state.published_version_id = id(30);
    state.public_path = "automations/activity-distiller/state";
    const registration = value.fake.registration(
      "activity-distiller",
      value.ids.activityInstructions,
      state.id,
      { disabled_at: new Date("2026-01-01T00:00:00Z") },
    );

    await prepare(value);

    const after = value.fake.registrations.get("activity-distiller")!;
    expect(after.id).toBe(registration.id);
    expect(after.instructions_document_id).not.toBe(value.ids.activityInstructions);
    expect(after.state_document_id).not.toBe(state.id);
    expect(value.fake.pages.get(after.state_document_id!)?.body_markdown).toBe(state.body_markdown);
    expect(state).toMatchObject({
      published_version_id: id(30),
      public_path: "automations/activity-distiller/state",
      body_markdown: "# Activity distiller state\n\n**Checkpoint:** `owner.live`\n",
    });
  });

  test("byte-clones a registered published custom automation and preserves owner registry state", async () => {
    const value = fixture();
    const instructions = value.fake.add(customPage(
      id(30),
      "automations/owner-workflow/instructions",
      "# Owner workflow\n\nRun the owner's exact process.\n",
      { published_version_id: id(130), public_path: "owner-workflow/instructions" },
    ));
    const state = value.fake.add(customPage(
      id(31),
      "automations/owner-workflow/state",
      "# Owner workflow state\n\n**Checkpoint:** `owner.42`\n",
      { published_version_id: id(131), public_path: "owner-workflow/state" },
    ));
    const disabledAt = new Date("2026-01-02T03:04:05Z");
    const before = value.fake.registration(
      "owner-workflow",
      instructions.id,
      state.id,
      { name: "Owner renamed workflow", disabled_at: disabledAt },
    );

    await prepare(value, [{
      key: "owner-workflow",
      name: before.name,
      instructionsDocumentId: instructions.id,
      stateDocumentId: state.id,
    }]);

    const after = value.fake.registrations.get("owner-workflow")!;
    expect(after.id).toBe(before.id);
    expect(after.name).toBe("Owner renamed workflow");
    expect(after.disabled_at).toBe(disabledAt);
    expect(after.instructions_document_id).not.toBe(instructions.id);
    expect(after.state_document_id).not.toBe(state.id);
    expect(value.fake.pages.get(after.instructions_document_id)?.body_markdown)
      .toBe(instructions.body_markdown);
    expect(value.fake.pages.get(after.state_document_id!)?.body_markdown)
      .toBe(state.body_markdown);
    expect(value.fake.pages.get(after.instructions_document_id)?.published_version_id).toBeNull();
    expect(value.fake.pages.get(after.state_document_id!)?.published_version_id).toBeNull();
    expect(instructions.public_path).toBe("owner-workflow/instructions");
    expect(state.public_path).toBe("owner-workflow/state");
  });

  test("adopts an unregistered published custom automation through a private exact clone", async () => {
    const value = fixture();
    const instructions = value.fake.add(customPage(
      id(32),
      "automations/research-digest/instructions",
      "# Research digest\n\nPreserve this exact custom instruction.\n",
      { published_version_id: id(132), public_path: "research-digest/instructions" },
    ));

    await prepare(value, [{
      key: "research-digest",
      name: "Research digest",
      instructionsDocumentId: instructions.id,
      stateDocumentId: null,
    }]);

    const registration = value.fake.registrations.get("research-digest")!;
    expect(registration.name).toBe("Research digest");
    expect(registration.state_document_id).toBeNull();
    expect(registration.instructions_document_id).not.toBe(instructions.id);
    expect(value.fake.pages.get(registration.instructions_document_id)?.body_markdown)
      .toBe(instructions.body_markdown);
    expect(value.fake.pages.get(registration.instructions_document_id)?.public_path).toBeNull();
    expect(instructions.public_path).toBe("research-digest/instructions");
  });

  test("registers private custom automation documents without changing their identities or bodies", async () => {
    const value = fixture();
    const instructions = value.fake.add(customPage(
      id(33),
      "automations/private-workflow/instructions",
      "# Private workflow\n\nKeep this private body and identity.\n",
    ));
    const writesBefore = value.bodies.writes.length;

    await prepare(value, [{
      key: "private-workflow",
      name: "Private workflow",
      instructionsDocumentId: instructions.id,
      stateDocumentId: null,
    }]);

    const registration = value.fake.registrations.get("private-workflow")!;
    expect(registration.instructions_document_id).toBe(instructions.id);
    expect(registration.state_document_id).toBeNull();
    expect(value.fake.pages.get(instructions.id)?.body_markdown).toBe(instructions.body_markdown);
    expect(value.bodies.writes).toHaveLength(writesBefore);
  });

  test("updates stale private template-owned documents in place", async () => {
    const value = fixture();
    const guide = value.fake.pages.get(value.ids.guide)!;
    const instructions = value.fake.pages.get(value.ids.activityInstructions)!;
    guide.body_markdown = "# Old managed guide\n";
    instructions.body_markdown = "# Old managed instructions\n";
    value.fake.registration(
      "activity-distiller",
      instructions.id,
      value.ids.activityState,
    );

    await prepare(value);

    expect(value.fake.globalGuideId).toBe(guide.id);
    expect(value.fake.registrations.get("activity-distiller")?.instructions_document_id)
      .toBe(instructions.id);
    expect(value.fake.updates).toEqual(expect.arrayContaining([guide.id, instructions.id]));
    expect(value.fake.replacementTargets).toEqual([]);
  });

  test("a second preparation after replacement performs no additional object write", async () => {
    const value = fixture();
    const guide = value.fake.pages.get(value.ids.guide)!;
    guide.body_markdown = "# Owner guide\n";
    guide.actor_subject = "context-use-owner";

    await prepare(value);
    const firstWrites = value.bodies.writes.length;
    await prepare(value);

    expect(firstWrites).toBe(2);
    expect(value.bodies.writes).toHaveLength(firstWrites);
    expect(value.fake.replacementTargets).toHaveLength(1);
  });

  test("retries only an explicit operational authority drift", async () => {
    const value = fixture();
    const guide = value.fake.pages.get(value.ids.guide)!;
    guide.body_markdown = "# Owner guide\n";
    guide.actor_subject = "context-use-owner";
    value.fake.driftBegins = 1;

    await prepare(value);

    expect(value.fake.replacementTargets).toHaveLength(1);
    expect(value.fake.globalGuideId).not.toBe(guide.id);
  });

  test("fresh reset documents register defaults without allocating replacements", async () => {
    const value = fixture();

    await prepare(value);

    expect(value.fake.registrations.get("activity-distiller")).toMatchObject({
      instructions_document_id: value.ids.activityInstructions,
      state_document_id: value.ids.activityState,
    });
    expect(value.fake.registrations.get("diary-composer")).toMatchObject({
      instructions_document_id: value.ids.diaryInstructions,
      state_document_id: value.ids.diaryState,
    });
    expect(value.fake.replacementTargets).toEqual([]);
  });
});
