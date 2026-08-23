import type {
  PathlessPublicationAdoption,
  PathlessPublicationAdoptionCandidate,
  PathlessPublicationAdoptionPhase,
  PathlessPublicationEntrypoint,
} from "@context-use/database";

type AdoptionRepository = {
  candidates(): Promise<PathlessPublicationAdoptionCandidate[]>;
  begin(
    adoptionKind: PathlessPublicationAdoptionCandidate["adoption_kind"],
    sourceDocumentId: string,
  ): Promise<PathlessPublicationAdoption>;
  apply(adoptionId: string): Promise<PathlessPublicationAdoptionPhase>;
  seedEntrypoint(): Promise<PathlessPublicationEntrypoint>;
  assertCutoverReady(): Promise<void>;
};

type ArtifactMaterializer = {
  materializePublicationArtifact(
    allocationKind: "pathless_adoption",
    allocationId: string,
  ): Promise<void>;
};

export type PathlessPublicationAdoptionResult = {
  passes: number;
  started: number;
  resumed: number;
  applied: number;
  superseded: number;
  entrypoint: PathlessPublicationEntrypoint;
  readiness: "ready";
};

export class PathlessPublicationAdoptionError extends Error {
  readonly operation: "list" | "begin" | "materialize" | "apply" | "seed" | "verify";
  readonly adoptionKind: PathlessPublicationAdoptionCandidate["adoption_kind"] | null;
  readonly sourceDocumentId: string | null;
  readonly adoptionId: string | null;
  readonly databaseCode: string | null;

  constructor(input: {
    operation: PathlessPublicationAdoptionError["operation"];
    adoptionKind?: PathlessPublicationAdoptionCandidate["adoption_kind"];
    sourceDocumentId?: string;
    adoptionId?: string;
    cause: unknown;
  }) {
    super(`Pathless publication adoption failed during ${input.operation}`, { cause: input.cause });
    this.name = "PathlessPublicationAdoptionError";
    this.operation = input.operation;
    this.adoptionKind = input.adoptionKind ?? null;
    this.sourceDocumentId = input.sourceDocumentId ?? null;
    this.adoptionId = input.adoptionId ?? null;
    this.databaseCode = typeof input.cause === "object" && input.cause !== null
      && "code" in input.cause && typeof input.cause.code === "string"
      ? input.cause.code
      : null;
  }
}

/**
 * Convert retained legacy visibility into immutable pathless artifacts before
 * the new public service starts. Every operation is independently replayable:
 * a lost begin response returns the permanent plan, materialization finalizes
 * one write-once claim, apply never repins an applied plan, and entrypoint seed
 * latches only after the worklist is empty.
 */
export async function adoptRetainedPublications(input: {
  adoptions: AdoptionRepository;
  storage: ArtifactMaterializer;
  maxPasses?: number;
}): Promise<PathlessPublicationAdoptionResult> {
  const maxPasses = input.maxPasses ?? 8;
  if (!Number.isSafeInteger(maxPasses) || maxPasses < 1 || maxPasses > 100) {
    throw new Error("Pathless publication adoption requires 1 to 100 passes");
  }

  const result = {
    passes: 0,
    started: 0,
    resumed: 0,
    applied: 0,
    superseded: 0,
  };
  for (let pass = 1; pass <= maxPasses; pass += 1) {
    let candidates: PathlessPublicationAdoptionCandidate[];
    try {
      candidates = await input.adoptions.candidates();
    } catch (cause) {
      throw new PathlessPublicationAdoptionError({ operation: "list", cause });
    }
    if (candidates.length === 0) {
      let entrypoint: PathlessPublicationEntrypoint;
      try {
        entrypoint = await input.adoptions.seedEntrypoint();
      } catch (cause) {
        throw new PathlessPublicationAdoptionError({ operation: "seed", cause });
      }
      try {
        await input.adoptions.assertCutoverReady();
      } catch (cause) {
        throw new PathlessPublicationAdoptionError({ operation: "verify", cause });
      }
      return { ...result, entrypoint, readiness: "ready" };
    }
    result.passes = pass;
    for (const candidate of candidates) {
      let adoptionId = candidate.adoption_id;
      if (adoptionId) {
        result.resumed += 1;
      } else {
        let adoption: PathlessPublicationAdoption;
        try {
          adoption = await input.adoptions.begin(
            candidate.adoption_kind,
            candidate.source_document_id,
          );
        } catch (cause) {
          throw new PathlessPublicationAdoptionError({
            operation: "begin",
            adoptionKind: candidate.adoption_kind,
            sourceDocumentId: candidate.source_document_id,
            cause,
          });
        }
        adoptionId = adoption.id;
        result.started += 1;
      }
      try {
        await input.storage.materializePublicationArtifact(
          "pathless_adoption",
          adoptionId,
        );
      } catch (cause) {
        throw new PathlessPublicationAdoptionError({
          operation: "materialize",
          adoptionKind: candidate.adoption_kind,
          sourceDocumentId: candidate.source_document_id,
          adoptionId,
          cause,
        });
      }
      let phase: PathlessPublicationAdoptionPhase;
      try {
        phase = await input.adoptions.apply(adoptionId);
      } catch (cause) {
        throw new PathlessPublicationAdoptionError({
          operation: "apply",
          adoptionKind: candidate.adoption_kind,
          sourceDocumentId: candidate.source_document_id,
          adoptionId,
          cause,
        });
      }
      if (phase === "applied") result.applied += 1;
      else if (phase === "superseded") result.superseded += 1;
      else throw new Error("Pathless publication adoption remained planned after apply");
    }
  }
  let remaining: PathlessPublicationAdoptionCandidate[];
  try {
    remaining = await input.adoptions.candidates();
  } catch (cause) {
    throw new PathlessPublicationAdoptionError({ operation: "list", cause });
  }
  throw new Error(
    `Pathless publication adoption did not converge (${remaining.length} candidate${remaining.length === 1 ? "" : "s"} remain)`,
  );
}
