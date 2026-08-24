import { describe, expect, test } from "bun:test";
import {
  defaultHypermediaBootstrapTemplate,
  type HypermediaBootstrapAllocation,
  type HypermediaBootstrapDocument,
} from "@context-use/database";
import {
  applyHypermediaBootstrap,
  hypermediaBootstrapDocuments,
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
    const documents = hypermediaBootstrapDocuments(defaultHypermediaBootstrapTemplate, allocations());

    expect(documents.map(({ document_kind }) => document_kind)).toEqual([...kinds]);
    expect(documents[0]?.input.title).toBe("AGENTS.md");
    expect(documents[0]?.input.body_markdown).toContain("# Hypermedia maintenance guide");
    expect(documents[1]?.input.title).toBe("Activity distiller");
    expect(documents[4]?.input.title).toBe("Diary composer state");
    expect(JSON.stringify(documents)).not.toContain("current_path");
    expect(JSON.stringify(documents)).not.toContain("public_path");
  });

  test("writes documents before atomically wiring operational identities and finalizing", async () => {
    const events: string[] = [];
    const written: HypermediaBootstrapDocument[] = [];
    const registrations: Array<Record<string, unknown>> = [];
    const completedAt = new Date("2026-08-24T12:00:00.000Z");
    const result = await applyHypermediaBootstrap({
      template: defaultHypermediaBootstrapTemplate,
      allocations: allocations(),
      repositories: {
        bootstrap: {
          async ensureDocument(document) {
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
    expect(() => hypermediaBootstrapDocuments(defaultHypermediaBootstrapTemplate, allocations().slice(0, 4)))
      .toThrow("diary_composer_state");
    expect(() => hypermediaBootstrapDocuments(defaultHypermediaBootstrapTemplate, [
      ...allocations(),
      { ...allocations()[0]!, document_kind: "unexpected" as never },
    ])).toThrow("unexpected allocation");
  });
});
