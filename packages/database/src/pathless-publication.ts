import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type {
  PathlessPublicationArtifactReceipt,
  PathlessPublicationEntrypointInput,
  PathlessPublicationIntentInput,
  PathlessPublicRouteInput,
} from "@context-use/shared";

export type PathlessPublicationPrincipal = {
  ownerUserId: string;
  sessionId: string;
};

type PathlessPublicationIntentBase = {
  id: string;
  target_document_id: string;
  expires_at: Date | string;
};

export type PathlessPublicationIntent =
  | PathlessPublicationIntentBase & {
    action: "publish";
    target_kind: "page";
    expected_revision_id: string;
    candidate_public_id: string;
  }
  | PathlessPublicationIntentBase & {
    action: "publish";
    target_kind: "asset";
    expected_revision_id: null;
    candidate_public_id: string;
  }
  | PathlessPublicationIntentBase & {
    action: "unpublish";
    target_kind: "page";
    expected_revision_id: null;
    candidate_public_id: null;
  }
  | PathlessPublicationIntentBase & {
    action: "unpublish";
    target_kind: "asset";
    expected_revision_id: null;
    candidate_public_id: null;
  };

export type PathlessPublicationProjectionOutcome =
  | "self"
  | "active_public"
  | "inactive_public"
  | "namespace_conflict"
  | "private"
  | "dangling";

export type PathlessPublicationProjectionTarget = {
  target_document_id: string;
  outcome: PathlessPublicationProjectionOutcome;
  public_id: string | null;
  public_target_kind: "page" | "asset" | null;
};

type PathlessPublicationWriteAuthorizationBase = {
  intent_id: string;
  candidate_public_id: string;
  artifact_id: string;
  source_body_object_key: string;
  source_body_size_bytes: number | string;
  source_body_content_hash: string;
  body_object_key: string;
  max_body_size_bytes: number | string;
};

export type PathlessPagePublicationWriteAuthorization =
  PathlessPublicationWriteAuthorizationBase & {
    target_kind: "page";
    public_title: string;
    public_summary: string;
    public_last_edited_at: string;
    public_filename: null;
    public_content_type: null;
    public_width: null;
    public_height: null;
    public_duration_seconds: null;
    projected_target_public_ids: string[];
    projection_receipt_hash: string;
    target_projection: PathlessPublicationProjectionTarget[];
  };

export type PathlessAssetPublicationWriteAuthorization =
  PathlessPublicationWriteAuthorizationBase & {
    target_kind: "asset";
    public_title: null;
    public_summary: null;
    public_last_edited_at: null;
    public_filename: string;
    public_content_type: string;
    public_width: number | null;
    public_height: number | null;
    public_duration_seconds: string | null;
    projected_target_public_ids: [];
    projection_receipt_hash: null;
    target_projection: [];
  };

/**
 * A short-lived database authorization to copy or project one exact object.
 * It is not a write-once claim on the destination object; server activation
 * still requires a conditional-create broker protocol around the object write.
 */
export type PathlessPublicationWriteAuthorization =
  | PathlessPagePublicationWriteAuthorization
  | PathlessAssetPublicationWriteAuthorization;

export type PathlessPublicationAdoptionKind =
  | "legacy_page"
  | "legacy_asset"
  | "directory_hub";

export type PathlessPublicationAdoptionPhase = "planned" | "applied" | "superseded";

type PathlessPublicationAdoptionBase = {
  id: string;
  source_document_id: string;
  public_id: string;
  candidate_artifact_id: string;
  phase: PathlessPublicationAdoptionPhase;
};

export type PathlessPublicationAdoption =
  | PathlessPublicationAdoptionBase & {
    adoption_kind: "legacy_page" | "directory_hub";
    source_revision_id: string;
  }
  | PathlessPublicationAdoptionBase & {
    adoption_kind: "legacy_asset";
    source_revision_id: null;
  };

type PathlessPublicationAdoptionWriteAuthorizationBase = {
  adoption_id: string;
  public_id: string;
  artifact_id: string;
  source_body_object_key: string;
  source_body_size_bytes: number | string;
  source_body_content_hash: string;
  body_object_key: string;
  max_body_size_bytes: number | string;
};

export type PathlessPagePublicationAdoptionWriteAuthorization =
  PathlessPublicationAdoptionWriteAuthorizationBase & {
    adoption_kind: "legacy_page" | "directory_hub";
    resource_kind: "page";
    public_title: string;
    public_summary: string;
    public_last_edited_at: string;
    public_filename: null;
    public_content_type: null;
    public_width: null;
    public_height: null;
    public_duration_seconds: null;
    projected_target_public_ids: string[];
    projection_receipt_hash: string;
    target_projection: PathlessPublicationProjectionTarget[];
  };

export type PathlessAssetPublicationAdoptionWriteAuthorization =
  PathlessPublicationAdoptionWriteAuthorizationBase & {
    adoption_kind: "legacy_asset";
    resource_kind: "asset";
    public_title: null;
    public_summary: null;
    public_last_edited_at: null;
    public_filename: string;
    public_content_type: string;
    public_width: number | null;
    public_height: number | null;
    public_duration_seconds: string | null;
    projected_target_public_ids: [];
    projection_receipt_hash: string;
    target_projection: [];
  };

/** Like ordinary writes, this authorizes work but does not claim the object key. */
export type PathlessPublicationAdoptionWriteAuthorization =
  | PathlessPagePublicationAdoptionWriteAuthorization
  | PathlessAssetPublicationAdoptionWriteAuthorization;

type PathlessPublicationAdoptionArtifactReceiptBase = {
  adoption_id: string;
  body_size_bytes: number;
  body_content_hash: string;
};

export type PathlessPagePublicationAdoptionArtifactReceipt =
  PathlessPublicationAdoptionArtifactReceiptBase & {
    adoption_kind: "legacy_page" | "directory_hub";
    public_title: string;
    public_summary: string;
    public_last_edited_at: string;
    projected_target_public_ids: string[];
    observed_public_uuid_tokens: string[];
    projection_receipt_hash: string;
  };

export type PathlessAssetPublicationAdoptionArtifactReceipt =
  PathlessPublicationAdoptionArtifactReceiptBase & {
    adoption_kind: "legacy_asset";
    public_filename: string;
    public_content_type: string;
    public_width?: number | null;
    public_height?: number | null;
    public_duration_seconds?: string | null;
    projection_receipt_hash: string;
  };

/** Adoption receipts use `adoption_id`; ordinary intent receipts remain unchanged. */
export type PathlessPublicationAdoptionArtifactReceipt =
  | PathlessPagePublicationAdoptionArtifactReceipt
  | PathlessAssetPublicationAdoptionArtifactReceipt;

export type PathlessPublicationEntrypoint = {
  public_id: string | null;
  configured: boolean;
  active: boolean;
};

export type PathlessPublicationEntrypointCandidate = {
  public_id: string;
  public_title: string;
  public_summary: string;
  public_last_edited_at: string;
  representation_token: string;
};

export type PathlessPublicPage = PathlessPublicationEntrypointCandidate & {
  canonical_path: string;
  markdown_path: string;
};

export type PathlessPublicAsset = {
  public_id: string;
  canonical_path: string;
  public_filename: string;
  public_content_type: string;
  public_width: number | null;
  public_height: number | null;
  public_duration_seconds: string | null;
  representation_token: string;
};

export type PathlessPublicRouteKind = "page" | "directory" | "markdown" | "asset";

export type PathlessPublicUnassignedRoute = {
  state: "unassigned";
  route_kind: PathlessPublicRouteKind;
};

export type PathlessPublicInactiveRoute = {
  state: "inactive";
  route_kind: PathlessPublicRouteKind;
};

export type PathlessPublicUnavailableRoute =
  | PathlessPublicUnassignedRoute
  | PathlessPublicInactiveRoute;

export type PathlessPublicActivePageRoute = {
  state: "active";
  route_kind: "page" | "directory" | "markdown";
  canonical_path: string;
  public_id: string;
  representation_token: string;
  public_title: string;
  public_summary: string;
  public_last_edited_at: string;
};

export type PathlessPublicActiveAssetRoute = {
  state: "active";
  route_kind: "asset";
  canonical_path: string;
  public_id: string;
  representation_token: string;
  public_filename: string;
  public_content_type: string;
  public_width: number | null;
  public_height: number | null;
  public_duration_seconds: string | null;
};

export type PathlessPublicRouteResolution =
  | PathlessPublicUnavailableRoute
  | PathlessPublicActivePageRoute
  | PathlessPublicActiveAssetRoute;

type PathlessPublicRouteRow = {
  state: "unassigned" | "inactive" | "active";
  route_kind: PathlessPublicRouteKind;
  canonical_path: string | null;
  public_id: string | null;
  representation_token: string | null;
  public_title: string | null;
  public_summary: string | null;
  public_last_edited_at: string | null;
  public_filename: string | null;
  public_content_type: string | null;
  public_width: number | null;
  public_height: number | null;
  public_duration_seconds: string | null;
};

export type PathlessStorageRoute = {
  resource_kind: "page" | "asset";
  representation_token: string;
  body_object_key: string;
  body_size_bytes: number | string;
  body_content_hash: string;
};

function requireRow<T>(row: T | undefined, description: string): T {
  if (!row) throw new Error(`${description} was not returned`);
  return row;
}

function publicRoute(row: PathlessPublicRouteRow): PathlessPublicRouteResolution {
  if (row.state !== "active") {
    return { state: row.state, route_kind: row.route_kind };
  }
  if (row.route_kind === "asset") {
    if (!row.canonical_path || !row.public_id || !row.representation_token
      || !row.public_filename || !row.public_content_type) {
      throw new Error("Active pathless asset route is incomplete");
    }
    return {
      state: "active",
      route_kind: "asset",
      canonical_path: row.canonical_path,
      public_id: row.public_id,
      representation_token: row.representation_token,
      public_filename: row.public_filename,
      public_content_type: row.public_content_type,
      public_width: row.public_width,
      public_height: row.public_height,
      public_duration_seconds: row.public_duration_seconds,
    };
  }
  if (!row.canonical_path || !row.public_id || !row.representation_token
    || !row.public_title || !row.public_summary || !row.public_last_edited_at) {
    throw new Error("Active pathless page route is incomplete");
  }
  return {
    state: "active",
    route_kind: row.route_kind,
    canonical_path: row.canonical_path,
    public_id: row.public_id,
    representation_token: row.representation_token,
    public_title: row.public_title,
    public_summary: row.public_summary,
    public_last_edited_at: row.public_last_edited_at,
  };
}

export class PathlessPublicationRepository {
  constructor(private readonly dashboardPool: Pool) {}

  /** Reuse `intentId` after a lost response to replay the same immutable plan. */
  async begin(
    input: PathlessPublicationIntentInput,
    principal: PathlessPublicationPrincipal,
    intentId = randomUUID(),
  ): Promise<PathlessPublicationIntent> {
    const result = await this.dashboardPool.query<PathlessPublicationIntent>(
      `SELECT id,action,target_kind,target_document_id,expected_revision_id,
         candidate_public_id,expires_at
       FROM begin_pathless_publication_intent($1,$2,$3,$4,$5,$6,$7)`,
      [
        intentId,
        input.action,
        input.target_kind,
        input.target_document_id,
        "expected_revision_id" in input ? input.expected_revision_id : null,
        principal.ownerUserId,
        principal.sessionId,
      ],
    );
    const intent = result.rows[0];
    if (!intent) throw new Error("Pathless publication intent was not returned");
    return intent;
  }

  async cancel(intentId: string, principal: PathlessPublicationPrincipal): Promise<void> {
    await this.dashboardPool.query(
      "SELECT cancel_pathless_publication_intent($1,$2,$3)",
      [intentId, principal.ownerUserId, principal.sessionId],
    );
  }
}

export class PathlessPublicationAdoptionRepository {
  constructor(
    private readonly corpusPool: Pool,
    private readonly storagePool: Pool,
  ) {}

  /** Reuse `adoptionId` after a lost response to replay the same immutable plan. */
  async begin(
    adoptionKind: PathlessPublicationAdoptionKind,
    sourceDocumentId: string,
    adoptionId = randomUUID(),
  ): Promise<PathlessPublicationAdoption> {
    const result = await this.corpusPool.query<PathlessPublicationAdoption>(
      `SELECT id,adoption_kind,source_document_id,source_revision_id,public_id,
         candidate_artifact_id,phase
       FROM begin_pathless_publication_adoption($1,$2,$3)`,
      [adoptionId, adoptionKind, sourceDocumentId],
    );
    return requireRow(result.rows[0], "Pathless publication adoption");
  }

  /** Re-authorizes one pending adoption write without claiming its object key. */
  async writeTarget(adoptionId: string): Promise<PathlessPublicationAdoptionWriteAuthorization> {
    const result = await this.storagePool.query<PathlessPublicationAdoptionWriteAuthorization>(
      `SELECT adoption_id,adoption_kind,resource_kind,public_id,artifact_id,
         source_body_object_key,source_body_size_bytes,source_body_content_hash,
         body_object_key,max_body_size_bytes,public_title,public_summary,
         public_last_edited_at,public_filename,public_content_type,public_width,
         public_height,public_duration_seconds,projected_target_public_ids,
         projection_receipt_hash,target_projection
       FROM get_pathless_publication_adoption_write_target($1)`,
      [adoptionId],
    );
    return requireRow(result.rows[0], "Pathless publication adoption write target");
  }

  async stage(receipt: PathlessPublicationAdoptionArtifactReceipt): Promise<void> {
    const page = receipt.adoption_kind !== "legacy_asset";
    await this.storagePool.query(
      `SELECT stage_pathless_publication_adoption(
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15
       )`,
      [
        receipt.adoption_id,
        receipt.adoption_kind,
        receipt.body_size_bytes,
        receipt.body_content_hash,
        page ? receipt.public_title : null,
        page ? receipt.public_summary : null,
        page ? receipt.public_last_edited_at : null,
        page ? null : receipt.public_filename,
        page ? null : receipt.public_content_type,
        page ? null : (receipt.public_width ?? null),
        page ? null : (receipt.public_height ?? null),
        page ? null : (receipt.public_duration_seconds ?? null),
        page ? receipt.projected_target_public_ids : [],
        page ? receipt.observed_public_uuid_tokens : [],
        receipt.projection_receipt_hash,
      ],
    );
  }

  async apply(adoptionId: string): Promise<PathlessPublicationAdoptionPhase> {
    const result = await this.corpusPool.query<{ phase: PathlessPublicationAdoptionPhase }>(
      "SELECT apply_pathless_publication_adoption($1) AS phase",
      [adoptionId],
    );
    return requireRow(result.rows[0], "Pathless publication adoption phase").phase;
  }

  async seedEntrypoint(): Promise<PathlessPublicationEntrypoint> {
    const result = await this.corpusPool.query<PathlessPublicationEntrypoint>(
      `SELECT public_id,configured,active
       FROM seed_pathless_publication_entrypoint()`,
    );
    const row = requireRow(result.rows[0], "Seeded pathless publication entrypoint");
    return { public_id: row.public_id, configured: row.configured, active: row.active };
  }
}

export class PathlessStoragePublicationRepository {
  constructor(private readonly storagePool: Pool) {}

  /**
   * Re-authorizes an exact pending object write. The database rejects staged or
   * challenged intents, but this lookup does not itself claim the object key.
   */
  async writeTarget(intentId: string): Promise<PathlessPublicationWriteAuthorization> {
    const result = await this.storagePool.query<PathlessPublicationWriteAuthorization>(
      `SELECT intent_id,target_kind,candidate_public_id,artifact_id,
         source_body_object_key,source_body_size_bytes,source_body_content_hash,
         body_object_key,max_body_size_bytes,public_title,public_summary,
         public_last_edited_at,public_filename,public_content_type,public_width,
         public_height,public_duration_seconds,projected_target_public_ids,
         projection_receipt_hash,target_projection
       FROM get_pathless_publication_write_target($1)`,
      [intentId],
    );
    const target = result.rows[0];
    if (!target) throw new Error("Pathless publication write target was not returned");
    return target;
  }

  async stage(receipt: PathlessPublicationArtifactReceipt): Promise<void> {
    const page = receipt.target_kind === "page";
    await this.storagePool.query(
      `SELECT stage_pathless_publication_artifact(
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15
       )`,
      [
        receipt.intent_id,
        receipt.target_kind,
        receipt.body_size_bytes,
        receipt.body_content_hash,
        page ? receipt.public_title : null,
        page ? receipt.public_summary : null,
        page ? receipt.public_last_edited_at : null,
        page ? null : receipt.public_filename,
        page ? null : receipt.public_content_type,
        page ? null : (receipt.public_width ?? null),
        page ? null : (receipt.public_height ?? null),
        page ? null : (receipt.public_duration_seconds ?? null),
        page ? receipt.projected_target_public_ids : [],
        page ? receipt.observed_public_uuid_tokens : [],
        page ? receipt.projection_receipt_hash : null,
      ],
    );
  }

  async resolve(representationToken: string): Promise<PathlessStorageRoute | null> {
    const result = await this.storagePool.query<PathlessStorageRoute>(
      `SELECT resource_kind,representation_token,body_object_key,
         body_size_bytes,body_content_hash
       FROM resolve_pathless_storage_route($1)`,
      [representationToken],
    );
    if (result.rows.length > 1) {
      throw new Error("Pathless representation token resolves ambiguously");
    }
    return result.rows[0] ?? null;
  }
}

export class PathlessPublicEntrypointRepository {
  constructor(private readonly dashboardPool: Pool) {}

  async get(): Promise<PathlessPublicationEntrypoint> {
    const result = await this.dashboardPool.query<PathlessPublicationEntrypoint>(
      `SELECT public_id,configured,active
       FROM get_pathless_publication_entrypoint()`,
    );
    const row = requireRow(result.rows[0], "Pathless publication entrypoint");
    return { public_id: row.public_id, configured: row.configured, active: row.active };
  }

  async candidates(): Promise<PathlessPublicationEntrypointCandidate[]> {
    const result = await this.dashboardPool.query<PathlessPublicationEntrypointCandidate>(
      `SELECT public_id,public_title,public_summary,public_last_edited_at,
         representation_token
       FROM list_pathless_publication_entrypoint_candidates()
       ORDER BY public_title,public_id`,
    );
    return result.rows.map((row) => ({
      public_id: row.public_id,
      public_title: row.public_title,
      public_summary: row.public_summary,
      public_last_edited_at: row.public_last_edited_at,
      representation_token: row.representation_token,
    }));
  }

  async set(input: PathlessPublicationEntrypointInput): Promise<PathlessPublicationEntrypoint> {
    const result = await this.dashboardPool.query<PathlessPublicationEntrypoint>(
      `SELECT public_id,configured,active
       FROM set_pathless_publication_entrypoint($1)`,
      [input.public_id],
    );
    const row = requireRow(result.rows[0], "Pathless publication entrypoint");
    return { public_id: row.public_id, configured: row.configured, active: row.active };
  }
}

export class PathlessPublicRepository {
  constructor(private readonly publicPool: Pool) {}

  async pages(): Promise<PathlessPublicPage[]> {
    const result = await this.publicPool.query<PathlessPublicPage>(
      `SELECT public_id,canonical_path,markdown_path,public_title,public_summary,
         public_last_edited_at,representation_token
       FROM pathless_public_pages
       ORDER BY public_id`,
    );
    return result.rows.map((row) => ({
      public_id: row.public_id,
      canonical_path: row.canonical_path,
      markdown_path: row.markdown_path,
      public_title: row.public_title,
      public_summary: row.public_summary,
      public_last_edited_at: row.public_last_edited_at,
      representation_token: row.representation_token,
    }));
  }

  async assets(): Promise<PathlessPublicAsset[]> {
    const result = await this.publicPool.query<PathlessPublicAsset>(
      `SELECT public_id,canonical_path,public_filename,public_content_type,
         public_width,public_height,public_duration_seconds,representation_token
       FROM pathless_public_assets
       ORDER BY public_id`,
    );
    return result.rows.map((row) => ({
      public_id: row.public_id,
      canonical_path: row.canonical_path,
      public_filename: row.public_filename,
      public_content_type: row.public_content_type,
      public_width: row.public_width,
      public_height: row.public_height,
      public_duration_seconds: row.public_duration_seconds,
      representation_token: row.representation_token,
    }));
  }

  async entrypoint(): Promise<PathlessPublicRouteResolution> {
    return this.resolve("/p/");
  }

  async resolve(route: PathlessPublicRouteInput): Promise<PathlessPublicRouteResolution> {
    const result = await this.publicPool.query<PathlessPublicRouteRow>(
      `SELECT state,route_kind,canonical_path,public_id,representation_token,
         public_title,public_summary,public_last_edited_at,public_filename,
         public_content_type,public_width,public_height,public_duration_seconds
       FROM resolve_pathless_public_route($1)`,
      [route],
    );
    if (result.rows.length !== 1) {
      throw new Error("Pathless public route did not resolve to exactly one state");
    }
    return publicRoute(result.rows[0]!);
  }
}
