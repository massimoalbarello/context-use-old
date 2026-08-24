import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type {
  PublicationArtifactReceipt,
  PublicationEntrypointInput,
  PublicationIntentInput,
  PublicRouteInput,
} from "@context-use/shared";

export type PublicationPrincipal = {
  ownerUserId: string;
  sessionId: string;
};

export type DashboardPublicationStatus = {
  public_id: string | null;
  published_revision_id: string | null;
  published_revision_number: number | null;
  active: boolean;
};

type PublicationIntentBase = {
  id: string;
  target_document_id: string;
  expires_at: Date | string;
};

export type PublicationIntent =
  | PublicationIntentBase & {
    action: "publish";
    target_kind: "page";
    expected_revision_id: string;
    candidate_public_id: string;
  }
  | PublicationIntentBase & {
    action: "publish";
    target_kind: "asset";
    expected_revision_id: null;
    candidate_public_id: string;
  }
  | PublicationIntentBase & {
    action: "unpublish";
    target_kind: "page";
    expected_revision_id: null;
    candidate_public_id: null;
  }
  | PublicationIntentBase & {
    action: "unpublish";
    target_kind: "asset";
    expected_revision_id: null;
    candidate_public_id: null;
  };

export type PublicationProjectionOutcome =
  | "self"
  | "active_public"
  | "inactive_public"
  | "namespace_conflict"
  | "private"
  | "dangling";

export type PublicationProjectionTarget = {
  target_document_id: string;
  outcome: PublicationProjectionOutcome;
  public_id: string | null;
  public_target_kind: "page" | "asset" | null;
};

type PublicationWriteAuthorizationBase = {
  intent_id: string;
  candidate_public_id: string;
  artifact_id: string;
  source_body_object_key: string;
  source_body_size_bytes: number | string;
  source_body_content_hash: string;
  body_object_key: string;
  max_body_size_bytes: number | string;
};

export type PagePublicationWriteAuthorization =
  PublicationWriteAuthorizationBase & {
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
    target_projection: PublicationProjectionTarget[];
  };

export type AssetPublicationWriteAuthorization =
  PublicationWriteAuthorizationBase & {
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

/** Exact source, destination, metadata and projection frozen by a live intent. */
export type PublicationWriteAuthorization =
  | PagePublicationWriteAuthorization
  | AssetPublicationWriteAuthorization;

type FinalizedObjectClaim = {
  claim_token: string;
  finalized: true;
  artifact_id: string;
  body_object_key: string;
  body_size_bytes: number | string;
  body_content_hash: string;
};

export type PublicationObjectClaim<Authorization> =
  | FinalizedObjectClaim
  | {
    claim_token: string;
    finalized: false;
    artifact_id: string;
    body_object_key: string;
    authorization: Authorization;
  };

export type PublicationEntrypoint = {
  public_id: string | null;
  configured: boolean;
  active: boolean;
};

export type PublicationEntrypointCandidate = {
  public_id: string;
  public_title: string;
  public_summary: string;
  public_last_edited_at: string;
  representation_token: string;
};

export type PublicPage = PublicationEntrypointCandidate & {
  canonical_path: string;
  markdown_path: string;
};

export type PublicAsset = {
  public_id: string;
  canonical_path: string;
  public_filename: string;
  public_content_type: string;
  public_width: number | null;
  public_height: number | null;
  public_duration_seconds: string | null;
  representation_token: string;
};

export type PublicRouteKind = "page" | "directory" | "markdown" | "asset";

export type PublicUnassignedRoute = {
  state: "unassigned";
  route_kind: PublicRouteKind;
};

export type PublicInactiveRoute = {
  state: "inactive";
  route_kind: PublicRouteKind;
};

export type PublicUnavailableRoute =
  | PublicUnassignedRoute
  | PublicInactiveRoute;

export type PublicActivePageRoute = {
  state: "active";
  route_kind: "page" | "directory" | "markdown";
  canonical_path: string;
  public_id: string;
  representation_token: string;
  public_title: string;
  public_summary: string;
  public_last_edited_at: string;
};

export type PublicActiveAssetRoute = {
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

export type PublicRouteResolution =
  | PublicUnavailableRoute
  | PublicActivePageRoute
  | PublicActiveAssetRoute;

type PublicRouteRow = {
  state: "unassigned" | "inactive" | "active";
  route_kind: PublicRouteKind;
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

export type StorageRoute = {
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

function publicRoute(row: PublicRouteRow): PublicRouteResolution {
  if (row.state !== "active") {
    return { state: row.state, route_kind: row.route_kind };
  }
  if (row.route_kind === "asset") {
    if (!row.canonical_path || !row.public_id || !row.representation_token
      || !row.public_filename || !row.public_content_type) {
      throw new Error("Active asset route is incomplete");
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
    throw new Error("Active page route is incomplete");
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

export class PublicationRepository {
  constructor(private readonly dashboardPool: Pool) {}

  /** Reuse `intentId` after a lost response to replay the same immutable plan. */
  async begin(
    input: PublicationIntentInput,
    principal: PublicationPrincipal,
    intentId: string = randomUUID(),
  ): Promise<PublicationIntent> {
    const result = await this.dashboardPool.query<PublicationIntent>(
      `SELECT id,action,target_kind,target_document_id,expected_revision_id,
         candidate_public_id,expires_at
       FROM begin_publication_intent($1,$2,$3,$4,$5,$6,$7)`,
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
    if (!intent) throw new Error("Publication intent was not returned");
    return intent;
  }

  async cancel(intentId: string, principal: PublicationPrincipal): Promise<void> {
    await this.dashboardPool.query(
      "SELECT cancel_publication_intent($1,$2,$3)",
      [intentId, principal.ownerUserId, principal.sessionId],
    );
  }

  async status(
    targetKind: "page" | "asset",
    targetDocumentId: string,
  ): Promise<DashboardPublicationStatus> {
    const result = await this.dashboardPool.query<DashboardPublicationStatus>(
      `SELECT public_id,published_revision_id,published_revision_number,active
       FROM get_dashboard_publication_status($1,$2)`,
      [targetKind, targetDocumentId],
    );
    return requireRow(result.rows[0], "Dashboard publication status");
  }
}

export class StoragePublicationRepository {
  constructor(private readonly storagePool: Pool) {}

  private claimRow<Authorization>(row: {
    claim_token: string;
    finalized: boolean;
    artifact_id: string;
    body_object_key: string;
    body_size_bytes: number | string | null;
    body_content_hash: string | null;
    authorization: Authorization | null;
  } | undefined): PublicationObjectClaim<Authorization> {
    const claim = requireRow(row, "Publication object claim");
    if (claim.finalized) {
      if (claim.body_size_bytes === null || claim.body_content_hash === null) {
        throw new Error("Finalized publication claim is missing its byte receipt");
      }
      return {
        claim_token: claim.claim_token,
        finalized: true,
        artifact_id: claim.artifact_id,
        body_object_key: claim.body_object_key,
        body_size_bytes: claim.body_size_bytes,
        body_content_hash: claim.body_content_hash,
      };
    }
    if (!claim.authorization) throw new Error("Pending publication claim is missing its authorization");
    return {
      claim_token: claim.claim_token,
      finalized: false,
      artifact_id: claim.artifact_id,
      body_object_key: claim.body_object_key,
      authorization: claim.authorization,
    };
  }

  async claimIntent(
    intentId: string,
    requestedClaimToken = randomUUID(),
  ): Promise<PublicationObjectClaim<PublicationWriteAuthorization>> {
    const result = await this.storagePool.query<{
      claim_token: string;
      finalized: boolean;
      artifact_id: string;
      body_object_key: string;
      body_size_bytes: number | string | null;
      body_content_hash: string | null;
      authorization: PublicationWriteAuthorization | null;
    }>(
      `SELECT claim_token,finalized,artifact_id,body_object_key,
         body_size_bytes,body_content_hash,"authorization"
       FROM claim_publication_artifact($1,$2)`,
      [intentId, requestedClaimToken],
    );
    return this.claimRow(result.rows[0]);
  }

  async finalizeIntent(claimToken: string, receipt: PublicationArtifactReceipt): Promise<void> {
    const page = receipt.target_kind === "page";
    await this.storagePool.query(
      `SELECT finalize_publication_artifact_claim(
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16
       )`,
      [
        claimToken,
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

  async resolve(representationToken: string): Promise<StorageRoute | null> {
    const result = await this.storagePool.query<StorageRoute>(
      `SELECT resource_kind,representation_token,body_object_key,
         body_size_bytes,body_content_hash
       FROM resolve_storage_route($1)`,
      [representationToken],
    );
    if (result.rows.length > 1) {
      throw new Error("Canonical representation token resolves ambiguously");
    }
    return result.rows[0] ?? null;
  }
}

export class PublicEntrypointRepository {
  constructor(private readonly dashboardPool: Pool) {}

  async get(): Promise<PublicationEntrypoint> {
    const result = await this.dashboardPool.query<PublicationEntrypoint>(
      `SELECT public_id,configured,active
       FROM get_publication_entrypoint()`,
    );
    const row = requireRow(result.rows[0], "Publication entrypoint");
    return { public_id: row.public_id, configured: row.configured, active: row.active };
  }

  async candidates(): Promise<PublicationEntrypointCandidate[]> {
    const result = await this.dashboardPool.query<PublicationEntrypointCandidate>(
      `SELECT public_id,public_title,public_summary,public_last_edited_at,
         representation_token
       FROM list_publication_entrypoint_candidates()
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

  async set(input: PublicationEntrypointInput): Promise<PublicationEntrypoint> {
    const result = await this.dashboardPool.query<PublicationEntrypoint>(
      `SELECT public_id,configured,active
       FROM set_publication_entrypoint($1)`,
      [input.public_id],
    );
    const row = requireRow(result.rows[0], "Publication entrypoint");
    return { public_id: row.public_id, configured: row.configured, active: row.active };
  }
}

export class PublicRepository {
  constructor(private readonly publicPool: Pool) {}

  async pages(): Promise<PublicPage[]> {
    const result = await this.publicPool.query<PublicPage>(
      `SELECT public_id,canonical_path,markdown_path,public_title,public_summary,
         public_last_edited_at,representation_token
       FROM public_pages
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

  async assets(): Promise<PublicAsset[]> {
    const result = await this.publicPool.query<PublicAsset>(
      `SELECT public_id,canonical_path,public_filename,public_content_type,
         public_width,public_height,public_duration_seconds,representation_token
       FROM public_assets
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

  async entrypoint(): Promise<PublicRouteResolution> {
    return this.resolve("/p/");
  }

  async resolve(route: PublicRouteInput): Promise<PublicRouteResolution> {
    const result = await this.publicPool.query<PublicRouteRow>(
      `SELECT state,route_kind,canonical_path,public_id,representation_token,
         public_title,public_summary,public_last_edited_at,public_filename,
         public_content_type,public_width,public_height,public_duration_seconds
       FROM resolve_public_route($1)`,
      [route],
    );
    if (result.rows.length !== 1) {
      throw new Error("Public route did not resolve to exactly one state");
    }
    return publicRoute(result.rows[0]!);
  }
}
