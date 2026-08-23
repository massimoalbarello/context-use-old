import { describe, expect, test } from "bun:test";
import type {
  PathlessPublicationAdoption,
  PathlessPublicationAdoptionCandidate,
  PathlessPublicationAdoptionPhase,
} from "@context-use/database";
import { adoptRetainedPublications } from "./pathless-publication-adoption.ts";

const pageId = "11111111-1111-4111-8111-111111111111";
const assetId = "22222222-2222-4222-8222-222222222222";
const hubId = "33333333-3333-4333-8333-333333333333";
const resumedId = "44444444-4444-4444-8444-444444444444";

function plan(candidate: PathlessPublicationAdoptionCandidate, id: string): PathlessPublicationAdoption {
  const base = {
    id,
    source_document_id: candidate.source_document_id,
    public_id: "55555555-5555-4555-8555-555555555555",
    candidate_artifact_id: "66666666-6666-4666-8666-666666666666",
    phase: "planned" as const,
  };
  return candidate.adoption_kind === "legacy_asset"
    ? { ...base, adoption_kind: "legacy_asset", source_revision_id: null }
    : { ...base, adoption_kind: candidate.adoption_kind, source_revision_id: pageId };
}

describe("retained publication adoption", () => {
  test("resumes permanent plans, retries superseded snapshots, then seeds", async () => {
    const first: PathlessPublicationAdoptionCandidate[] = [
      { adoption_kind: "legacy_page", source_document_id: pageId, adoption_id: null },
      { adoption_kind: "legacy_asset", source_document_id: assetId, adoption_id: resumedId },
      { adoption_kind: "directory_hub", source_document_id: hubId, adoption_id: null },
    ];
    const retry: PathlessPublicationAdoptionCandidate[] = [
      { adoption_kind: "directory_hub", source_document_id: hubId, adoption_id: null },
    ];
    const candidatePasses = [first, retry, []];
    const begun: string[] = [];
    const materialized: string[] = [];
    const phases: PathlessPublicationAdoptionPhase[] = ["applied", "applied", "superseded", "applied"];
    let allocation = 0;
    const entrypoint = { public_id: pageId, configured: true, active: true };

    const result = await adoptRetainedPublications({
      adoptions: {
        candidates: async () => candidatePasses.shift() ?? [],
        begin: async (kind, sourceDocumentId) => {
          const id = `77777777-7777-4777-8777-77777777777${allocation++}`;
          begun.push(`${kind}:${sourceDocumentId}:${id}`);
          return plan({ adoption_kind: kind, source_document_id: sourceDocumentId, adoption_id: null }, id);
        },
        apply: async () => phases.shift()!,
        seedEntrypoint: async () => entrypoint,
        assertCutoverReady: async () => undefined,
      },
      storage: {
        materializePublicationArtifact: async (kind, id) => {
          materialized.push(`${kind}:${id}`);
        },
      },
    });

    expect(begun).toHaveLength(3);
    expect(materialized).toHaveLength(4);
    expect(materialized[1]).toBe(`pathless_adoption:${resumedId}`);
    expect(result).toEqual({
      passes: 2,
      started: 3,
      resumed: 1,
      applied: 3,
      superseded: 1,
      entrypoint,
      readiness: "ready",
    });
  });

  test("does not seed until a bounded worklist converges", async () => {
    let seeded = false;
    await expect(adoptRetainedPublications({
      maxPasses: 1,
      adoptions: {
        candidates: async () => [{
          adoption_kind: "legacy_asset",
          source_document_id: assetId,
          adoption_id: resumedId,
        }],
        begin: async () => { throw new Error("unexpected begin"); },
        apply: async () => "superseded",
        seedEntrypoint: async () => {
          seeded = true;
          return { public_id: null, configured: true, active: false };
        },
        assertCutoverReady: async () => { throw new Error("unexpected readiness check"); },
      },
      storage: { materializePublicationArtifact: async () => undefined },
    })).rejects.toThrow("did not converge (1 candidate remain)");
    expect(seeded).toBe(false);
  });
});
