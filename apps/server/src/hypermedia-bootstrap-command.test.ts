import { describe, expect, test } from "bun:test";
import {
  defaultHypermediaBootstrapTemplate,
  type HypermediaBootstrapAllocation,
  type HypermediaBootstrapPage,
} from "@context-use/database";
import {
  applyHypermediaBootstrap,
  hypermediaBootstrapPages,
  synchronizeGlobalGuide,
} from "./hypermedia-bootstrap-command.ts";

const kinds = [
  "global_guide",
  "activity_distiller_instructions",
  "activity_distiller_state",
  "diary_composer_instructions",
  "diary_composer_state",
] as const;

function allocations(): HypermediaBootstrapAllocation[] {
  return kinds.map((document_kind, index) => ({
    document_kind,
    document_id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    revision_id: `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
  }));
}

describe("hypermedia bootstrap command", () => {
  test("maps the embedded contract to five stable semantic allocations", async () => {
    const documents = hypermediaBootstrapPages(defaultHypermediaBootstrapTemplate, allocations());

    expect(documents.map(({ document_kind }) => document_kind)).toEqual([...kinds]);
    expect(documents[0]?.input.title).toBe("AGENTS.md");
    expect(documents[0]?.input.body_markdown).toContain("# Hypermedia maintenance guide");
    expect(documents[0]?.input.body_markdown).toContain("Every object is a\npage, record or asset");
    expect(documents[0]?.input.body_markdown).toContain("context-use://object/<uuid>");
    expect(documents[0]?.input.body_markdown).not.toContain("context-use://document/");
    expect(documents[1]?.input.title).toBe("Activity distiller");
    expect(documents[1]?.input.body_markdown).toContain("stable object reference");
    expect(documents[4]?.input.title).toBe("Diary composer state");
    expect(documents[3]?.input.body_markdown).toContain("`object_id`");
    expect(documents[3]?.input.body_markdown).toContain("`PAGE_DELTA_UNAVAILABLE`");
  });

  test("writes documents before atomically wiring operational identities and finalizing", async () => {
    const events: string[] = [];
    const written: HypermediaBootstrapPage[] = [];
    const registrations: Array<Record<string, unknown>> = [];
    const completedAt = new Date("2026-08-24T12:00:00.000Z");
    const result = await applyHypermediaBootstrap({
      template: defaultHypermediaBootstrapTemplate,
      allocations: allocations(),
      repositories: {
        bootstrap: {
          async ensurePage(document) {
            events.push(`document:${document.document_kind}`);
            written.push(document);
          },
          async complete() {
            events.push("complete");
            return completedAt;
          },
        },
        settings: {
          async updateGlobalGuide(documentId) {
            events.push(`guide:${documentId}`);
            return { global_guide_document_id: documentId, updated_at: completedAt };
          },
        },
        registry: {
          async register(input) {
            events.push(`automation:${input.key}`);
            registrations.push(input);
            return { ...input, id: crypto.randomUUID(), created_at: completedAt,
              updated_at: completedAt, disabled_at: null };
          },
        },
      },
    });

    expect(result).toBe(completedAt);
    expect(written).toHaveLength(5);
    expect(events.slice(0, 5)).toEqual(kinds.map((kind) => `document:${kind}`));
    expect(events.at(-1)).toBe("complete");
    expect(registrations).toEqual([
      expect.objectContaining({
        key: "activity-distiller",
        instructions_document_id: allocations()[1]!.document_id,
        state_document_id: allocations()[2]!.document_id,
      }),
      expect.objectContaining({
        key: "diary-composer",
        instructions_document_id: allocations()[3]!.document_id,
        state_document_id: allocations()[4]!.document_id,
      }),
    ]);
  });

  test("rejects incomplete or extra allocation sets", async () => {
    expect(() => hypermediaBootstrapPages(defaultHypermediaBootstrapTemplate, allocations().slice(0, 4)))
      .toThrow("diary_composer_state");
    expect(() => hypermediaBootstrapPages(defaultHypermediaBootstrapTemplate, [
      ...allocations(),
      { ...allocations()[0]!, document_kind: "unexpected" as never },
    ])).toThrow("unexpected allocation");
  });

  test("leaves an existing configured guide unchanged when it matches the embedded template", async () => {
    const guide = defaultHypermediaBootstrapTemplate.pages.global_guide;
    const documentId = crypto.randomUUID();
    const revisionId = crypto.randomUUID();
    let updates = 0;
    const result = await synchronizeGlobalGuide({
      guide,
      templateName: defaultHypermediaBootstrapTemplate.name,
      repositories: {
        settings: {
          async globalGuide() {
            return {
              document_id: documentId,
              current_revision_id: revisionId,
              revision_number: 4,
              title: guide.title,
              summary: guide.summary,
              body_object_key: "knowledge/test.md",
              body_size_bytes: guide.body_markdown.length,
              body_content_hash: "a".repeat(64),
              settings_updated_at: new Date(),
            };
          },
        },
        pages: {
          async get() {
            return {
              object_id: documentId,
              current_revision_id: revisionId,
              public_id: null,
              revision_number: 4,
              title: guide.title,
              summary: guide.summary,
              archived_at: null,
              current_link_contract: "generic_document_v1" as const,
              search_ready: true,
              created_at: new Date(),
              updated_at: new Date(),
              body_markdown: guide.body_markdown,
            };
          },
          async update() {
            updates += 1;
            throw new Error("unexpected update");
          },
        },
      },
    });

    expect(result).toEqual({ object_id: documentId, revision_number: 4, updated: false });
    expect(updates).toBe(0);
  });

  test("replaces a customized configured guide with a new managed revision", async () => {
    const guide = defaultHypermediaBootstrapTemplate.pages.global_guide;
    const documentId = crypto.randomUUID();
    const revisionId = crypto.randomUUID();
    const updates: Array<Record<string, unknown>> = [];
    const result = await synchronizeGlobalGuide({
      guide,
      templateName: defaultHypermediaBootstrapTemplate.name,
      repositories: {
        settings: {
          async globalGuide() {
            return {
              document_id: documentId,
              current_revision_id: revisionId,
              revision_number: 7,
              title: "Customized guide",
              summary: "Customized instructions.",
              body_object_key: "knowledge/test.md",
              body_size_bytes: 12,
              body_content_hash: "b".repeat(64),
              settings_updated_at: new Date(),
            };
          },
        },
        pages: {
          async get() {
            return {
              object_id: documentId,
              current_revision_id: revisionId,
              public_id: null,
              revision_number: 7,
              title: "Customized guide",
              summary: "Customized instructions.",
              archived_at: null,
              current_link_contract: "generic_document_v1" as const,
              search_ready: true,
              created_at: new Date(),
              updated_at: new Date(),
              body_markdown: "# Customized\n",
            };
          },
          async update(id, update, actor) {
            updates.push({ id, update, actor });
            return {
              object_id: documentId,
              current_revision_id: crypto.randomUUID(),
              public_id: null,
              revision_number: 8,
              title: update.title,
              summary: update.summary,
              archived_at: null,
              current_link_contract: "generic_document_v1" as const,
              search_ready: true,
              created_at: new Date(),
              updated_at: new Date(),
              body_markdown: update.body_markdown,
            };
          },
        },
      },
    });

    expect(result).toEqual({ object_id: documentId, revision_number: 8, updated: true });
    expect(updates).toEqual([{
      id: documentId,
      update: {
        title: guide.title,
        summary: guide.summary,
        body_markdown: guide.body_markdown,
        commit_message: "Synchronize default managed global guide",
        expected_revision_number: 7,
      },
      actor: {
        kind: "dashboard",
        subject: "context-use-managed-global-guide/v1",
      },
    }]);
  });
});
