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
  target_object_id: string;
  expires_at: Date | string;
};

export type PublicationIntent =
  | (PublicationIntentBase & {
      action: "publish";
      target_kind: "page";
      expected_revision_id: string;
      candidate_public_id: string;
    })
  | (PublicationIntentBase & {
      action: "publish";
      target_kind: "asset";
      expected_revision_id: null;
      candidate_public_id: string;
    })
  | (PublicationIntentBase & {
      action: "unpublish";
      target_kind: "page";
      expected_revision_id: null;
      candidate_public_id: null;
    })
  | (PublicationIntentBase & {
      action: "unpublish";
      target_kind: "asset";
      expected_revision_id: null;
      candidate_public_id: null;
    });

export type PublicationProjectionOutcome =
  | "self"
  | "active_public"
  | "inactive_public"
  | "namespace_conflict"
  | "private"
  | "dangling";

export type PublicationProjectionTarget = {
  target_object_id: string;
  outcome: PublicationProjectionOutcome;
  public_id: string | null;
  public_target_kind: "page" | "asset" | null;
};

export type StoredPublicationProjectionTarget = Omit<
  PublicationProjectionTarget,
  "target_object_id"
> & {
  target_document_id: string;
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

export type PagePublicationWriteAuthorization = PublicationWriteAuthorizationBase & {
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

export type AssetPublicationWriteAuthorization = PublicationWriteAuthorizationBase & {
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

export type PublicUnavailableRoute = PublicUnassignedRoute | PublicInactiveRoute;

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

export type PublicRouteRow = {
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
