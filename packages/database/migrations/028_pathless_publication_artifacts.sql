-- Add a permanent public-identity and immutable-artifact publication model in
-- parallel with the legacy path/generation projection. Nothing in this
-- migration removes or repurposes the rollback serving surfaces.

CREATE TYPE public_artifact_origin AS ENUM (
  'ordinary','legacy_adoption','directory_hub_promotion'
);
CREATE TYPE pathless_publication_adoption_kind AS ENUM (
  'legacy_page','legacy_asset','directory_hub'
);
CREATE TYPE pathless_publication_adoption_phase AS ENUM (
  'planned','applied','superseded'
);
CREATE TYPE public_artifact_allocation_kind AS ENUM (
  'legacy_page','pathless_intent','pathless_adoption'
);

CREATE FUNCTION lock_public_uuid_namespace(p_uuid uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
  SELECT pg_advisory_xact_lock(
    hashtextextended('permanent-public-uuid-namespace:'||p_uuid::text,0)
  );
$$;

-- Freeze participating legacy/private writers while the existing namespace is
-- snapshotted and the reciprocal guards are installed. Every supported writer
-- takes the shared form of this same transition lock as its first DB lock.
SELECT pg_advisory_xact_lock(
  hashtextextended('filesystem-hypermedia-corpus-transition',0)
);

-- Preserve the private identity originally assigned to a permanent public
-- resource even after the live FK is nulled by private deletion. Pre-028
-- tombstones cannot be reconstructed and deliberately remain NULL.
ALTER TABLE public_resources ADD COLUMN original_document_id uuid;
UPDATE public_resources
SET original_document_id=document_id
WHERE document_id IS NOT NULL;
CREATE UNIQUE INDEX public_resources_original_document_unique
  ON public_resources(original_document_id)
  WHERE original_document_id IS NOT NULL;
ALTER TABLE public_resources ADD CONSTRAINT public_resources_original_mapping
  CHECK (
    document_id IS NULL
    OR (original_document_id IS NOT NULL AND document_id=original_document_id)
  );
ALTER TABLE public_resources ADD CONSTRAINT public_resources_kind_identity_unique
  UNIQUE (public_id,resource_kind);
ALTER TABLE public_resources ADD CONSTRAINT public_resources_original_kind_unique
  UNIQUE (public_id,original_document_id,resource_kind);

-- Artifact UUIDs and object keys are never reusable, including after an intent
-- expires or an adoption is superseded. Existing generation artifacts seed the
-- same namespace before any v2 allocation is possible.
CREATE TABLE public_artifact_id_reservations (
  artifact_id uuid PRIMARY KEY,
  body_object_key text NOT NULL UNIQUE,
  allocation_kind public_artifact_allocation_kind NOT NULL,
  allocation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (allocation_kind,allocation_id),
  UNIQUE (artifact_id,body_object_key,allocation_kind,allocation_id)
);
LOCK TABLE published_page_artifacts IN SHARE ROW EXCLUSIVE MODE;
INSERT INTO public_artifact_id_reservations(
  artifact_id,body_object_key,allocation_kind,allocation_id,created_at
)
SELECT artifact_id,body_object_key,'legacy_page',artifact_id,created_at
FROM published_page_artifacts;

-- Intents are durable, single-use WebAuthn approval records. Candidate public
-- IDs are private planning values, not authoritative namespace reservations;
-- confirmation takes the namespace lock and revalidates them. The stable
-- artifact allocation makes object-first staging retryable after a lost reply.
CREATE TABLE pathless_publication_intents (
  id uuid PRIMARY KEY,
  action publication_action NOT NULL,
  target_kind publication_target NOT NULL,
  target_document_id uuid NOT NULL,
  expected_revision_id uuid,
  candidate_public_id uuid,
  candidate_artifact_id uuid,
  candidate_object_key text,
  artifact_allocation_kind public_artifact_allocation_kind,
  artifact_allocation_id uuid,
  projected_target_public_ids uuid[] NOT NULL DEFAULT '{}'::uuid[] CHECK (
    cardinality(projected_target_public_ids)<=100000
    AND array_position(projected_target_public_ids,NULL) IS NULL
  ),
  projection_receipt_hash text CHECK (
    projection_receipt_hash IS NULL
    OR projection_receipt_hash ~ '^[a-f0-9]{64}$'
  ),
  owner_user_id text NOT NULL CHECK (owner_user_id='context-use-owner'),
  session_id text NOT NULL CHECK (length(session_id) BETWEEN 1 AND 512),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  confirmed_at timestamptz,
  cancelled_at timestamptz,
  CHECK (expires_at>created_at AND expires_at<=created_at+interval '5 minutes'),
  CHECK (confirmed_at IS NULL OR cancelled_at IS NULL),
  CHECK (
    candidate_public_id IS NULL OR candidate_artifact_id IS NULL
    OR candidate_public_id<>candidate_artifact_id
  ),
  CHECK (
    (action='unpublish'
      AND expected_revision_id IS NULL
      AND candidate_public_id IS NULL
      AND candidate_artifact_id IS NULL
      AND candidate_object_key IS NULL
      AND artifact_allocation_kind IS NULL
      AND artifact_allocation_id IS NULL
      AND cardinality(projected_target_public_ids)=0
      AND projection_receipt_hash IS NULL)
    OR (action='publish' AND candidate_public_id IS NOT NULL
      AND candidate_artifact_id IS NOT NULL
      AND candidate_object_key IS NOT NULL
      AND artifact_allocation_kind='pathless_intent'
      AND artifact_allocation_id=id
      AND (
        (target_kind='page'
          AND expected_revision_id IS NOT NULL
          AND candidate_object_key=
            'documents/public/'||candidate_artifact_id::text||'.md'
          AND projection_receipt_hash IS NOT NULL)
        OR (target_kind='asset'
          AND expected_revision_id IS NULL
          AND candidate_object_key=
            'artifacts/public/'||candidate_artifact_id::text
          AND cardinality(projected_target_public_ids)=0
          AND projection_receipt_hash IS NULL)
      ))
  ),
  FOREIGN KEY (
    candidate_artifact_id,candidate_object_key,artifact_allocation_kind,
    artifact_allocation_id
  ) REFERENCES public_artifact_id_reservations(
    artifact_id,body_object_key,allocation_kind,allocation_id
  ) ON DELETE RESTRICT,
  UNIQUE (
    id,target_kind,candidate_public_id,candidate_artifact_id,candidate_object_key
  ),
  UNIQUE (
    id,target_kind,target_document_id,expected_revision_id,candidate_public_id,
    candidate_artifact_id,candidate_object_key
  ),
  UNIQUE (
    id,target_kind,target_document_id,candidate_public_id,candidate_artifact_id,
    candidate_object_key
  )
);
CREATE INDEX pathless_publication_intents_expiry_idx
  ON pathless_publication_intents(expires_at)
  WHERE confirmed_at IS NULL AND cancelled_at IS NULL;

-- Staging is mutable only through its later boundary, while final public
-- artifacts remain absent until passkey confirmation. The tuple is bound to
-- the exact intent allocation and freezes every byte and display field the
-- confirmation will insert.
CREATE TABLE pathless_publication_artifact_staging (
  intent_id uuid PRIMARY KEY,
  target_kind publication_target NOT NULL,
  candidate_public_id uuid NOT NULL,
  artifact_id uuid NOT NULL,
  body_object_key text NOT NULL,
  body_size_bytes bigint NOT NULL CHECK (body_size_bytes>=0),
  body_content_hash text NOT NULL CHECK (body_content_hash ~ '^[a-f0-9]{64}$'),
  public_title text,
  public_summary text,
  public_last_edited_at timestamptz,
  public_filename text,
  public_content_type text,
  public_width integer,
  public_height integer,
  public_duration_seconds numeric,
  projected_target_public_ids uuid[] NOT NULL DEFAULT '{}'::uuid[] CHECK (
    cardinality(projected_target_public_ids)<=100000
    AND array_position(projected_target_public_ids,NULL) IS NULL
  ),
  observed_public_uuid_tokens uuid[] NOT NULL DEFAULT '{}'::uuid[] CHECK (
    cardinality(observed_public_uuid_tokens)<=100000
    AND array_position(observed_public_uuid_tokens,NULL) IS NULL
  ),
  projection_receipt_hash text,
  allocation_kind public_artifact_allocation_kind NOT NULL
    DEFAULT 'pathless_intent' CHECK (allocation_kind='pathless_intent'),
  allocation_id uuid NOT NULL CHECK (allocation_id=intent_id),
  staged_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (
    intent_id,target_kind,candidate_public_id,artifact_id,body_object_key
  ) REFERENCES pathless_publication_intents(
    id,target_kind,candidate_public_id,candidate_artifact_id,candidate_object_key
  ) ON DELETE RESTRICT,
  FOREIGN KEY (artifact_id,body_object_key,allocation_kind,allocation_id)
    REFERENCES public_artifact_id_reservations(
      artifact_id,body_object_key,allocation_kind,allocation_id
    ) ON DELETE RESTRICT,
  UNIQUE (intent_id,target_kind,candidate_public_id,artifact_id,body_object_key),
  CHECK (
    (target_kind='page'
      AND body_size_bytes<=4000000
      AND public_title IS NOT NULL
      AND length(trim(public_title)) BETWEEN 1 AND 240
      AND public_summary IS NOT NULL
      AND length(trim(public_summary)) BETWEEN 1 AND 320
      AND public_last_edited_at IS NOT NULL
      AND public_filename IS NULL
      AND public_content_type IS NULL
      AND public_width IS NULL
      AND public_height IS NULL
      AND public_duration_seconds IS NULL
      AND projection_receipt_hash IS NOT NULL
      AND projection_receipt_hash ~ '^[a-f0-9]{64}$')
    OR (target_kind='asset'
      AND public_title IS NULL
      AND public_summary IS NULL
      AND public_last_edited_at IS NULL
      AND public_filename IS NOT NULL
      AND length(public_filename) BETWEEN 1 AND 1024
      AND public_content_type IS NOT NULL
      AND length(public_content_type) BETWEEN 1 AND 255
      AND (public_width IS NULL OR public_width>0)
      AND (public_height IS NULL OR public_height>0)
      AND (public_duration_seconds IS NULL OR public_duration_seconds>=0)
      AND cardinality(projected_target_public_ids)=0
      AND cardinality(observed_public_uuid_tokens)=0
      AND projection_receipt_hash IS NULL)
  )
);

-- Public artifacts retain their source UUID/hash evidence as immutable values,
-- not FKs. Revision pruning, private deletion and the legacy reset therefore
-- cannot erase public history or wedge existing destructive workflows.
CREATE TABLE public_page_artifacts (
  artifact_id uuid PRIMARY KEY,
  public_id uuid NOT NULL,
  resource_kind publication_target NOT NULL DEFAULT 'page'
    CHECK (resource_kind='page'),
  source_document_id uuid NOT NULL,
  source_revision_id uuid NOT NULL,
  source_body_size_bytes integer NOT NULL CHECK (
    source_body_size_bytes BETWEEN 0 AND 4000000
  ),
  source_body_content_hash text NOT NULL CHECK (
    source_body_content_hash ~ '^[a-f0-9]{64}$'
  ),
  body_object_key text NOT NULL UNIQUE CHECK (
    body_object_key='documents/public/'||artifact_id::text||'.md'
  ),
  body_size_bytes integer NOT NULL CHECK (body_size_bytes BETWEEN 0 AND 4000000),
  body_content_hash text NOT NULL CHECK (body_content_hash ~ '^[a-f0-9]{64}$'),
  public_title text NOT NULL CHECK (length(trim(public_title)) BETWEEN 1 AND 240),
  public_summary text NOT NULL CHECK (length(trim(public_summary)) BETWEEN 1 AND 320),
  public_last_edited_at timestamptz NOT NULL,
  projected_target_public_ids uuid[] NOT NULL DEFAULT '{}'::uuid[] CHECK (
    cardinality(projected_target_public_ids)<=100000
    AND array_position(projected_target_public_ids,NULL) IS NULL
  ),
  observed_public_uuid_tokens uuid[] NOT NULL DEFAULT '{}'::uuid[] CHECK (
    cardinality(observed_public_uuid_tokens)<=100000
    AND array_position(observed_public_uuid_tokens,NULL) IS NULL
  ),
  projection_receipt_hash text NOT NULL CHECK (
    projection_receipt_hash ~ '^[a-f0-9]{64}$'
  ),
  origin public_artifact_origin NOT NULL,
  source_intent_id uuid UNIQUE REFERENCES pathless_publication_intents(id)
    ON DELETE RESTRICT,
  source_adoption_id uuid UNIQUE,
  source_adoption_kind pathless_publication_adoption_kind,
  legacy_source_artifact_id uuid,
  legacy_projection_generation bigint CHECK (
    legacy_projection_generation IS NULL OR legacy_projection_generation>0
  ),
  representation_token text NOT NULL UNIQUE CHECK (
    representation_token ~ '^[a-f0-9]{64}$'
  ),
  reservation_allocation_kind public_artifact_allocation_kind NOT NULL,
  reservation_allocation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    public_id<>artifact_id AND source_document_id<>artifact_id
      AND source_revision_id<>artifact_id
  ),
  UNIQUE (public_id,artifact_id),
  FOREIGN KEY (public_id,resource_kind)
    REFERENCES public_resources(public_id,resource_kind) ON DELETE RESTRICT,
  FOREIGN KEY (public_id,source_document_id,resource_kind)
    REFERENCES public_resources(public_id,original_document_id,resource_kind)
    ON DELETE RESTRICT,
  FOREIGN KEY (
    artifact_id,body_object_key,reservation_allocation_kind,
    reservation_allocation_id
  ) REFERENCES public_artifact_id_reservations(
    artifact_id,body_object_key,allocation_kind,allocation_id
  ) ON DELETE RESTRICT,
  FOREIGN KEY (source_intent_id,resource_kind,public_id,artifact_id,body_object_key)
    REFERENCES pathless_publication_artifact_staging(
      intent_id,target_kind,candidate_public_id,artifact_id,body_object_key
    ) ON DELETE RESTRICT,
  FOREIGN KEY (
    source_intent_id,resource_kind,source_document_id,source_revision_id,
    public_id,artifact_id,body_object_key
  ) REFERENCES pathless_publication_intents(
    id,target_kind,target_document_id,expected_revision_id,candidate_public_id,
    candidate_artifact_id,candidate_object_key
  ) ON DELETE RESTRICT,
  CHECK (
    (origin='ordinary' AND source_intent_id IS NOT NULL
      AND source_adoption_id IS NULL
      AND source_adoption_kind IS NULL
      AND legacy_source_artifact_id IS NULL
      AND legacy_projection_generation IS NULL
      AND reservation_allocation_kind='pathless_intent'
      AND reservation_allocation_id=source_intent_id)
    OR (origin='legacy_adoption' AND source_intent_id IS NULL
      AND source_adoption_id IS NOT NULL
      AND source_adoption_kind='legacy_page'
      AND legacy_source_artifact_id IS NOT NULL
      AND legacy_projection_generation IS NOT NULL
      AND reservation_allocation_kind='pathless_adoption'
      AND reservation_allocation_id=source_adoption_id)
    OR (origin='directory_hub_promotion' AND source_intent_id IS NULL
      AND source_adoption_id IS NOT NULL
      AND source_adoption_kind='directory_hub'
      AND legacy_source_artifact_id IS NULL
      AND legacy_projection_generation IS NULL
      AND reservation_allocation_kind='pathless_adoption'
      AND reservation_allocation_id=source_adoption_id)
  )
);
CREATE INDEX public_page_artifacts_resource_history_idx
  ON public_page_artifacts(public_id,created_at DESC,artifact_id);
CREATE INDEX public_page_artifacts_source_history_idx
  ON public_page_artifacts(source_document_id,source_revision_id,created_at DESC);

CREATE TABLE public_asset_artifacts (
  artifact_id uuid PRIMARY KEY,
  public_id uuid NOT NULL,
  resource_kind publication_target NOT NULL DEFAULT 'asset'
    CHECK (resource_kind='asset'),
  source_document_id uuid NOT NULL,
  body_object_key text NOT NULL UNIQUE CHECK (
    body_object_key='artifacts/public/'||artifact_id::text
  ),
  body_size_bytes bigint NOT NULL CHECK (body_size_bytes>=0),
  body_content_hash text NOT NULL CHECK (body_content_hash ~ '^[a-f0-9]{64}$'),
  public_filename text NOT NULL CHECK (length(public_filename) BETWEEN 1 AND 1024),
  public_content_type text NOT NULL CHECK (length(public_content_type) BETWEEN 1 AND 255),
  public_width integer CHECK (public_width IS NULL OR public_width>0),
  public_height integer CHECK (public_height IS NULL OR public_height>0),
  public_duration_seconds numeric CHECK (
    public_duration_seconds IS NULL OR public_duration_seconds>=0
  ),
  origin public_artifact_origin NOT NULL CHECK (origin<>'directory_hub_promotion'),
  source_intent_id uuid UNIQUE REFERENCES pathless_publication_intents(id)
    ON DELETE RESTRICT,
  source_adoption_id uuid UNIQUE,
  source_adoption_kind pathless_publication_adoption_kind,
  representation_token text NOT NULL UNIQUE CHECK (
    representation_token ~ '^[a-f0-9]{64}$'
  ),
  reservation_allocation_kind public_artifact_allocation_kind NOT NULL,
  reservation_allocation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (public_id<>artifact_id AND source_document_id<>artifact_id),
  UNIQUE (public_id,artifact_id),
  FOREIGN KEY (public_id,resource_kind)
    REFERENCES public_resources(public_id,resource_kind) ON DELETE RESTRICT,
  FOREIGN KEY (public_id,source_document_id,resource_kind)
    REFERENCES public_resources(public_id,original_document_id,resource_kind)
    ON DELETE RESTRICT,
  FOREIGN KEY (
    artifact_id,body_object_key,reservation_allocation_kind,
    reservation_allocation_id
  ) REFERENCES public_artifact_id_reservations(
    artifact_id,body_object_key,allocation_kind,allocation_id
  ) ON DELETE RESTRICT,
  FOREIGN KEY (source_intent_id,resource_kind,public_id,artifact_id,body_object_key)
    REFERENCES pathless_publication_artifact_staging(
      intent_id,target_kind,candidate_public_id,artifact_id,body_object_key
    ) ON DELETE RESTRICT,
  FOREIGN KEY (
    source_intent_id,resource_kind,source_document_id,public_id,artifact_id,
    body_object_key
  ) REFERENCES pathless_publication_intents(
    id,target_kind,target_document_id,candidate_public_id,candidate_artifact_id,
    candidate_object_key
  ) ON DELETE RESTRICT,
  CHECK (
    (origin='ordinary' AND source_intent_id IS NOT NULL
      AND source_adoption_id IS NULL
      AND source_adoption_kind IS NULL
      AND reservation_allocation_kind='pathless_intent'
      AND reservation_allocation_id=source_intent_id)
    OR (origin='legacy_adoption' AND source_intent_id IS NULL
      AND source_adoption_id IS NOT NULL
      AND source_adoption_kind='legacy_asset'
      AND reservation_allocation_kind='pathless_adoption'
      AND reservation_allocation_id=source_adoption_id)
  )
);
CREATE INDEX public_asset_artifacts_resource_history_idx
  ON public_asset_artifacts(public_id,created_at DESC,artifact_id);
CREATE INDEX public_asset_artifacts_source_history_idx
  ON public_asset_artifacts(source_document_id,created_at DESC);

-- Only these rows are mutable publication state. Unpublish deletes a pin and
-- never an immutable artifact, resource or legacy alias.
CREATE TABLE page_publications (
  public_id uuid PRIMARY KEY,
  resource_kind publication_target NOT NULL DEFAULT 'page'
    CHECK (resource_kind='page'),
  artifact_id uuid NOT NULL UNIQUE,
  published_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (public_id,resource_kind)
    REFERENCES public_resources(public_id,resource_kind) ON DELETE RESTRICT,
  FOREIGN KEY (public_id,artifact_id)
    REFERENCES public_page_artifacts(public_id,artifact_id) ON DELETE RESTRICT
);
CREATE TABLE asset_publications (
  public_id uuid PRIMARY KEY,
  resource_kind publication_target NOT NULL DEFAULT 'asset'
    CHECK (resource_kind='asset'),
  artifact_id uuid NOT NULL UNIQUE,
  published_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (public_id,resource_kind)
    REFERENCES public_resources(public_id,resource_kind) ON DELETE RESTRICT,
  FOREIGN KEY (public_id,artifact_id)
    REFERENCES public_asset_artifacts(public_id,artifact_id) ON DELETE RESTRICT
);

-- NULL updated_at means the one-time legacy/corpus seed has never run. Once a
-- corpus seed or owner setter runs (including an explicit NULL), legacy
-- entrypoint updates can never silently retarget this authority.
CREATE TABLE pathless_publication_settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  entrypoint_public_id uuid,
  entrypoint_resource_kind publication_target NOT NULL DEFAULT 'page'
    CHECK (entrypoint_resource_kind='page'),
  updated_at timestamptz,
  FOREIGN KEY (entrypoint_public_id,entrypoint_resource_kind)
    REFERENCES public_resources(public_id,resource_kind) ON DELETE RESTRICT
);
INSERT INTO pathless_publication_settings(singleton,entrypoint_public_id,updated_at)
VALUES (true,NULL,NULL);

-- Corpus adoption/promotion is also object-first and resumable. The snapshot
-- freezes the exact legacy generation/asset tuple or hub source proof; a lost
-- reply retries the same artifact ID and key rather than producing an orphan.
CREATE TABLE pathless_publication_adoptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  adoption_kind pathless_publication_adoption_kind NOT NULL,
  source_document_id uuid NOT NULL,
  source_revision_id uuid,
  public_id uuid NOT NULL,
  candidate_artifact_id uuid NOT NULL UNIQUE,
  candidate_object_key text NOT NULL UNIQUE,
  reservation_allocation_kind public_artifact_allocation_kind NOT NULL
    DEFAULT 'pathless_adoption'
    CHECK (reservation_allocation_kind='pathless_adoption'),
  reservation_allocation_id uuid NOT NULL CHECK (reservation_allocation_id=id),
  source_snapshot jsonb NOT NULL CHECK (jsonb_typeof(source_snapshot)='object'),
  source_fingerprint text NOT NULL CHECK (source_fingerprint ~ '^[a-f0-9]{64}$'),
  phase pathless_publication_adoption_phase NOT NULL DEFAULT 'planned',
  created_at timestamptz NOT NULL DEFAULT now(),
  applied_at timestamptz,
  superseded_at timestamptz,
  CHECK (public_id<>candidate_artifact_id),
  FOREIGN KEY (
    candidate_artifact_id,candidate_object_key,reservation_allocation_kind,
    reservation_allocation_id
  ) REFERENCES public_artifact_id_reservations(
    artifact_id,body_object_key,allocation_kind,allocation_id
  ) ON DELETE RESTRICT,
  CHECK (
    (adoption_kind IN ('legacy_page','directory_hub')
      AND source_revision_id IS NOT NULL
      AND candidate_object_key=
        'documents/public/'||candidate_artifact_id::text||'.md')
    OR (adoption_kind='legacy_asset'
      AND source_revision_id IS NULL
      AND candidate_object_key=
        'artifacts/public/'||candidate_artifact_id::text)
  ),
  CHECK (
    (phase='planned' AND applied_at IS NULL AND superseded_at IS NULL)
    OR (phase='applied' AND applied_at IS NOT NULL AND superseded_at IS NULL)
    OR (phase='superseded' AND applied_at IS NULL AND superseded_at IS NOT NULL)
  ),
  UNIQUE (
    id,adoption_kind,public_id,candidate_artifact_id,candidate_object_key,
    source_document_id,source_revision_id
  ),
  UNIQUE (
    id,adoption_kind,public_id,candidate_artifact_id,candidate_object_key,
    source_document_id
  )
);
CREATE UNIQUE INDEX pathless_publication_adoptions_current_source_idx
  ON pathless_publication_adoptions(adoption_kind,source_document_id)
  WHERE phase='planned';

ALTER TABLE public_page_artifacts
  ADD CONSTRAINT public_page_artifacts_source_adoption_fk
  FOREIGN KEY (
    source_adoption_id,source_adoption_kind,public_id,artifact_id,
    body_object_key,source_document_id,source_revision_id
  ) REFERENCES pathless_publication_adoptions(
    id,adoption_kind,public_id,candidate_artifact_id,candidate_object_key,
    source_document_id,source_revision_id
  ) ON DELETE RESTRICT;
ALTER TABLE public_asset_artifacts
  ADD CONSTRAINT public_asset_artifacts_source_adoption_fk
  FOREIGN KEY (
    source_adoption_id,source_adoption_kind,public_id,artifact_id,
    body_object_key,source_document_id
  ) REFERENCES pathless_publication_adoptions(
    id,adoption_kind,public_id,candidate_artifact_id,candidate_object_key,
    source_document_id
  ) ON DELETE RESTRICT;

-- Existing legal pre-028 collisions are durable cutover blockers, not install
-- failures and never occasions to mutate a permanent identity or alias.
CREATE TABLE public_namespace_conflicts (
  conflict_key text PRIMARY KEY,
  namespace_uuid uuid NOT NULL,
  conflict_kind text NOT NULL CHECK (conflict_kind IN (
    'public_id_private_id','public_id_artifact_id','public_id_alias_token',
    'planned_public_id_private_id','planned_public_id_artifact_id',
    'planned_public_id_alias_token','alias_token_private_id',
    'alias_token_artifact_id','alias_token_public_mapping',
    'artifact_id_private_id','planned_public_id_public_mapping'
  )),
  public_id uuid,
  alias_path text,
  conflicting_identity_kind text NOT NULL,
  conflict_lifecycle text NOT NULL CHECK (
    conflict_lifecycle IN ('permanent','planned')
  ),
  detected_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz CHECK (resolved_at IS NULL OR resolved_at>=detected_at)
);
CREATE INDEX public_namespace_conflicts_uuid_idx
  ON public_namespace_conflicts(namespace_uuid,conflict_kind);

-- Public IDs, private identities, public artifact IDs and UUID-shaped legacy
-- route tokens share the race-safe boundary above. A pathless publication
-- intent's candidate public ID is deliberately absent: it is not authoritative
-- until confirmation rechecks and inserts a permanent public resource.

CREATE FUNCTION canonical_legacy_alias_uuid(p_alias_path text)
RETURNS uuid
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SET search_path=pg_catalog
AS $$
DECLARE
  matched text[];
BEGIN
  matched := regexp_match(
    p_alias_path,
    '^/p/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})([.]md)?$'
  );
  IF matched IS NOT NULL THEN RETURN matched[1]::uuid; END IF;
  matched := regexp_match(
    p_alias_path,
    '^/a/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'
  );
  IF matched IS NOT NULL THEN RETURN matched[1]::uuid; END IF;
  RETURN NULL;
END;
$$;

CREATE FUNCTION canonical_legacy_alias_kind(p_alias_path text)
RETURNS public_route_kind
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path=pg_catalog,public
AS $$
  SELECT CASE
    WHEN p_alias_path ~ '^/p/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.]md$'
      THEN 'markdown'::public_route_kind
    WHEN p_alias_path ~ '^/p/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN 'page'::public_route_kind
    WHEN p_alias_path ~ '^/a/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN 'asset'::public_route_kind
    ELSE NULL
  END;
$$;

CREATE INDEX public_route_aliases_canonical_uuid_idx
  ON public_route_aliases(canonical_legacy_alias_uuid(alias_path))
  WHERE canonical_legacy_alias_uuid(alias_path) IS NOT NULL;
CREATE INDEX corpus_directory_plans_public_assignment_idx
  ON corpus_directory_migration_plans(public_id,run_id,directory_id)
  WHERE public_id IS NOT NULL;
CREATE INDEX corpus_directory_plans_document_assignment_idx
  ON corpus_directory_migration_plans(directory_id,run_id,public_id)
  WHERE public_id IS NOT NULL;

CREATE FUNCTION public_uuid_has_private_identity(p_uuid uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM hypermedia_documents WHERE id=p_uuid
    UNION ALL SELECT 1 FROM hypermedia_document_revisions WHERE id=p_uuid
    UNION ALL SELECT 1 FROM knowledge_directories WHERE id=p_uuid
    UNION ALL SELECT 1 FROM legacy_public_directory_prefixes WHERE directory_id=p_uuid
    UNION ALL SELECT 1 FROM public_resources WHERE original_document_id=p_uuid
    UNION ALL
    SELECT 1
    FROM corpus_directory_migration_plans plan
    JOIN corpus_migration_runs run ON run.id=plan.run_id
    WHERE run.phase IN ('applying','ready') AND (
      plan.directory_id=p_uuid OR plan.private_revision_id=p_uuid
      OR plan.public_revision_id=p_uuid
    )
    UNION ALL
    SELECT 1
    FROM corpus_page_migration_plans plan
    JOIN corpus_migration_runs run ON run.id=plan.run_id
    WHERE run.phase IN ('applying','ready') AND plan.rewrite_revision_id=p_uuid
    UNION ALL
    SELECT 1
    FROM corpus_migration_automation_plans plan
    JOIN corpus_migration_runs run ON run.id=plan.run_id
    WHERE run.phase IN ('applying','ready') AND (
      plan.instructions_document_id=p_uuid OR plan.state_document_id=p_uuid
    )
    UNION ALL
    SELECT 1
    FROM operational_document_replacements replacement
    WHERE replacement.phase='planned' AND (
      replacement.replacement_document_id=p_uuid
      OR replacement.replacement_revision_id=p_uuid
      OR replacement.state_replacement_document_id=p_uuid
      OR replacement.state_replacement_revision_id=p_uuid
      OR replacement.agents_occupant_preservation_revision_id=p_uuid
    )
  );
$$;

CREATE FUNCTION public_uuid_has_artifact_identity(p_uuid uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public_artifact_id_reservations WHERE artifact_id=p_uuid
  );
$$;

CREATE FUNCTION public_uuid_has_reserved_public_identity(p_uuid uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public_resources WHERE public_id=p_uuid
    UNION ALL
    SELECT 1
    FROM corpus_directory_migration_plans plan
    JOIN corpus_migration_runs run ON run.id=plan.run_id
    WHERE run.phase IN ('applying','ready') AND plan.public_id=p_uuid
  );
$$;

CREATE FUNCTION public_uuid_has_legacy_alias_token(p_uuid uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public_route_aliases alias
    WHERE canonical_legacy_alias_uuid(alias.alias_path)=p_uuid
  );
$$;

CREATE FUNCTION assert_private_uuid_available(p_uuid uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
BEGIN
  PERFORM lock_public_uuid_namespace(p_uuid);
  IF public_uuid_has_reserved_public_identity(p_uuid)
     OR public_uuid_has_legacy_alias_token(p_uuid)
     OR public_uuid_has_artifact_identity(p_uuid) THEN
    RAISE EXCEPTION 'private UUID conflicts with the permanent public namespace'
      USING ERRCODE='23505';
  END IF;
END;
$$;

CREATE FUNCTION assert_public_uuid_available(
  p_uuid uuid,
  p_original_document_id uuid,
  p_resource_kind publication_target
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
DECLARE
  namespace_uuid uuid;
BEGIN
  FOR namespace_uuid IN
    SELECT DISTINCT value
    FROM unnest(ARRAY[p_uuid,p_original_document_id]) AS values(value)
    WHERE value IS NOT NULL
    ORDER BY value
  LOOP
    PERFORM lock_public_uuid_namespace(namespace_uuid);
  END LOOP;
  IF public_uuid_has_private_identity(p_uuid)
     OR public_uuid_has_artifact_identity(p_uuid)
     OR EXISTS (
       SELECT 1 FROM public_namespace_conflicts conflict
       WHERE conflict.namespace_uuid=p_uuid
         AND conflict.conflict_lifecycle='permanent'
         AND conflict.resolved_at IS NULL
     ) THEN
    RAISE EXCEPTION 'public UUID conflicts with a private or artifact identity'
      USING ERRCODE='23505';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public_resources resource
    WHERE resource.public_id=p_uuid AND (
      resource.original_document_id IS DISTINCT FROM p_original_document_id
      OR resource.resource_kind IS DISTINCT FROM p_resource_kind
    )
  ) OR EXISTS (
    SELECT 1
    FROM corpus_directory_migration_plans plan
    JOIN corpus_migration_runs run ON run.id=plan.run_id
    WHERE run.phase IN ('applying','ready') AND plan.public_id=p_uuid
      AND (plan.directory_id IS DISTINCT FROM p_original_document_id
        OR p_resource_kind<>'page')
  ) THEN
    RAISE EXCEPTION 'public UUID is permanently assigned to another resource'
      USING ERRCODE='23505';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public_resources resource
    WHERE resource.original_document_id=p_original_document_id
      AND resource.public_id<>p_uuid
  ) OR EXISTS (
    SELECT 1
    FROM corpus_directory_migration_plans plan
    JOIN corpus_migration_runs run ON run.id=plan.run_id
    WHERE run.phase IN ('applying','ready')
      AND plan.directory_id=p_original_document_id
      AND plan.public_id IS NOT NULL AND plan.public_id<>p_uuid
  ) THEN
    RAISE EXCEPTION 'private document is assigned another permanent public UUID'
      USING ERRCODE='23505';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public_route_aliases alias
    WHERE canonical_legacy_alias_uuid(alias.alias_path)=p_uuid
      AND (
        alias.public_id<>p_uuid
        OR canonical_legacy_alias_kind(alias.alias_path)<>alias.route_kind
        OR (p_resource_kind='page' AND alias.route_kind NOT IN ('page','markdown'))
        OR (p_resource_kind='asset' AND alias.route_kind<>'asset')
      )
  ) THEN
    RAISE EXCEPTION 'public UUID is shadowed by a legacy route alias'
      USING ERRCODE='23505';
  END IF;
END;
$$;

CREATE FUNCTION guard_private_uuid_columns()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
DECLARE
  candidate uuid;
BEGIN
  FOR candidate IN
    SELECT DISTINCT (to_jsonb(NEW)->>column_name)::uuid
    FROM unnest(TG_ARGV) AS columns(column_name)
    WHERE to_jsonb(NEW)->>column_name IS NOT NULL
    ORDER BY 1
  LOOP
    PERFORM lock_public_uuid_namespace(candidate);
    IF TG_OP='INSERT' AND TG_TABLE_NAME='hypermedia_documents'
       AND EXISTS (
         SELECT 1 FROM hypermedia_documents document
         WHERE document.id=candidate
           AND document.authority=(to_jsonb(NEW)->>'authority')::hypermedia_document_authority
           AND document.representation=
             coalesce(
               (to_jsonb(NEW)->>'representation')::hypermedia_document_representation,
               'markdown'::hypermedia_document_representation
             )
       ) THEN
      CONTINUE;
    END IF;
    IF TG_OP='INSERT' AND TG_TABLE_NAME='hypermedia_document_revisions'
       AND EXISTS (
         SELECT 1 FROM hypermedia_document_revisions revision
         WHERE revision.id=candidate
           AND revision.document_id=(to_jsonb(NEW)->>'document_id')::uuid
           AND revision.revision_number=
             (to_jsonb(NEW)->>'revision_number')::integer
           AND revision.body_object_key=to_jsonb(NEW)->>'body_object_key'
           AND revision.body_size_bytes=
             (to_jsonb(NEW)->>'body_size_bytes')::integer
           AND revision.body_content_hash=to_jsonb(NEW)->>'body_content_hash'
       ) THEN
      CONTINUE;
    END IF;
    PERFORM assert_private_uuid_available(candidate);
  END LOOP;
  RETURN NEW;
END;
$$;

CREATE FUNCTION guard_corpus_directory_plan_namespace()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
DECLARE
  candidate uuid;
BEGIN
  FOR candidate IN
    SELECT DISTINCT value
    FROM (VALUES
      (NEW.directory_id),(NEW.private_revision_id),(NEW.public_revision_id),
      (NEW.public_id)
    ) AS candidates(value)
    WHERE value IS NOT NULL
    ORDER BY value
  LOOP
    PERFORM lock_public_uuid_namespace(candidate);
  END LOOP;
  IF NEW.public_id IS NOT NULL AND (
    NEW.public_id=NEW.directory_id
    OR NEW.public_id=NEW.private_revision_id
    OR NEW.public_id=NEW.public_revision_id
  ) THEN
    RAISE EXCEPTION 'planned public UUID collides with a planned private identity'
      USING ERRCODE='23505';
  END IF;
  PERFORM assert_private_uuid_available(NEW.directory_id);
  IF NEW.private_revision_id IS NOT NULL THEN
    PERFORM assert_private_uuid_available(NEW.private_revision_id);
  END IF;
  IF NEW.public_revision_id IS NOT NULL THEN
    PERFORM assert_private_uuid_available(NEW.public_revision_id);
  END IF;
  IF NEW.public_id IS NOT NULL THEN
    PERFORM assert_public_uuid_available(NEW.public_id,NEW.directory_id,'page');
    IF EXISTS (
      SELECT 1
      FROM corpus_directory_migration_plans plan
      JOIN corpus_migration_runs run ON run.id=plan.run_id
      WHERE run.phase IN ('applying','ready') AND plan.public_id=NEW.public_id
        AND (plan.run_id,plan.directory_id)<>(NEW.run_id,NEW.directory_id)
    ) THEN
      RAISE EXCEPTION 'planned public UUID is reserved by another directory'
        USING ERRCODE='23505';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION guard_public_resource_identity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
DECLARE
  namespace_uuid uuid;
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'permanent public resources cannot be deleted'
      USING ERRCODE='23514';
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.document_id IS NULL THEN
      RAISE EXCEPTION 'new public resources require a private document identity'
        USING ERRCODE='23514';
    END IF;
    IF NEW.original_document_id IS NULL THEN
      NEW.original_document_id := NEW.document_id;
    ELSIF NEW.original_document_id IS DISTINCT FROM NEW.document_id THEN
      RAISE EXCEPTION 'public resource original identity mismatch'
        USING ERRCODE='23514';
    END IF;
    FOR namespace_uuid IN
      SELECT DISTINCT value
      FROM unnest(ARRAY[NEW.public_id,NEW.original_document_id]) AS values(value)
      ORDER BY value
    LOOP
      PERFORM lock_public_uuid_namespace(namespace_uuid);
    END LOOP;
    IF EXISTS (
      SELECT 1 FROM public_resources resource
      WHERE resource.public_id=NEW.public_id
        AND resource.document_id=NEW.document_id
        AND resource.original_document_id=NEW.original_document_id
        AND resource.resource_kind=NEW.resource_kind
    ) THEN
      RETURN NEW;
    END IF;
    PERFORM assert_public_uuid_available(
      NEW.public_id,NEW.original_document_id,NEW.resource_kind
    );
    RETURN NEW;
  END IF;
  IF NEW.public_id IS DISTINCT FROM OLD.public_id
     OR NEW.resource_kind IS DISTINCT FROM OLD.resource_kind
     OR NEW.original_document_id IS DISTINCT FROM OLD.original_document_id
     OR (OLD.document_id IS NULL AND NEW.document_id IS NOT NULL)
     OR (NEW.document_id IS NOT NULL
       AND NEW.document_id IS DISTINCT FROM OLD.document_id) THEN
    RAISE EXCEPTION 'permanent public resource identity is immutable'
      USING ERRCODE='23514';
  END IF;
  IF OLD.document_id IS NOT NULL AND NEW.document_id IS NULL THEN
    DELETE FROM page_publications WHERE public_id=OLD.public_id;
    DELETE FROM asset_publications WHERE public_id=OLD.public_id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION guard_legacy_alias_namespace()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
DECLARE
  token uuid;
  expected_kind public_route_kind;
  resource_kind publication_target;
BEGIN
  IF TG_OP IN ('UPDATE','DELETE') THEN
    RAISE EXCEPTION 'permanent public route aliases are append-only'
      USING ERRCODE='23514';
  END IF;
  token := canonical_legacy_alias_uuid(NEW.alias_path);
  IF token IS NULL THEN RETURN NEW; END IF;
  expected_kind := canonical_legacy_alias_kind(NEW.alias_path);
  PERFORM lock_public_uuid_namespace(token);
  IF EXISTS (
    SELECT 1 FROM public_route_aliases alias
    WHERE alias.alias_path=NEW.alias_path
      AND alias.route_kind=NEW.route_kind
      AND alias.public_id=NEW.public_id
  ) THEN
    RETURN NEW;
  END IF;
  IF public_uuid_has_private_identity(token)
     OR public_uuid_has_artifact_identity(token) THEN
    RAISE EXCEPTION 'legacy alias token conflicts with a private or artifact UUID'
      USING ERRCODE='23505';
  END IF;
  IF NEW.public_id<>token OR NEW.route_kind<>expected_kind THEN
    RAISE EXCEPTION 'UUID-shaped legacy alias must match its canonical public identity'
      USING ERRCODE='23505';
  END IF;
  SELECT resource.resource_kind INTO resource_kind
  FROM public_resources resource WHERE resource.public_id=token;
  IF resource_kind IS NULL
     OR (resource_kind='page' AND expected_kind NOT IN ('page','markdown'))
     OR (resource_kind='asset' AND expected_kind<>'asset') THEN
    RAISE EXCEPTION 'UUID-shaped legacy alias kind does not match its public resource'
      USING ERRCODE='23505';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION guard_artifact_reservation_namespace()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'public artifact reservations are permanent'
      USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' THEN
    IF NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'public artifact reservations are immutable'
        USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  PERFORM lock_public_uuid_namespace(NEW.artifact_id);
  IF EXISTS (
    SELECT 1 FROM public_artifact_id_reservations reservation
    WHERE reservation.artifact_id=NEW.artifact_id
      AND reservation.body_object_key=NEW.body_object_key
      AND reservation.allocation_kind=NEW.allocation_kind
      AND reservation.allocation_id=NEW.allocation_id
  ) THEN
    RETURN NEW;
  END IF;
  IF public_uuid_has_reserved_public_identity(NEW.artifact_id)
     OR public_uuid_has_legacy_alias_token(NEW.artifact_id)
     OR public_uuid_has_private_identity(NEW.artifact_id) THEN
    RAISE EXCEPTION 'public artifact UUID conflicts with the public namespace'
      USING ERRCODE='23505';
  END IF;
  IF NOT (
    (NEW.allocation_kind='legacy_page'
      AND NEW.allocation_id=NEW.artifact_id
      AND NEW.body_object_key=
        'documents/public/'||NEW.artifact_id::text||'.md')
    OR (NEW.allocation_kind IN ('pathless_intent','pathless_adoption') AND (
      NEW.body_object_key='documents/public/'||NEW.artifact_id::text||'.md'
      OR NEW.body_object_key='artifacts/public/'||NEW.artifact_id::text
    ))
  ) THEN
    RAISE EXCEPTION 'public artifact reservation shape is invalid'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION reserve_public_artifact_identity(
  p_artifact_id uuid,
  p_body_object_key text,
  p_allocation_kind public_artifact_allocation_kind,
  p_allocation_id uuid
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
BEGIN
  IF p_artifact_id IS NULL OR p_body_object_key IS NULL
     OR p_allocation_kind IS NULL OR p_allocation_id IS NULL THEN
    RAISE EXCEPTION 'complete artifact allocation is required' USING ERRCODE='22023';
  END IF;
  PERFORM lock_public_uuid_namespace(p_artifact_id);
  INSERT INTO public_artifact_id_reservations(
    artifact_id,body_object_key,allocation_kind,allocation_id
  ) VALUES (
    p_artifact_id,p_body_object_key,p_allocation_kind,p_allocation_id
  ) ON CONFLICT (artifact_id) DO NOTHING;
  IF NOT EXISTS (
    SELECT 1 FROM public_artifact_id_reservations reservation
    WHERE reservation.artifact_id=p_artifact_id
      AND reservation.body_object_key=p_body_object_key
      AND reservation.allocation_kind=p_allocation_kind
      AND reservation.allocation_id=p_allocation_id
  ) THEN
    RAISE EXCEPTION 'public artifact UUID is permanently reserved'
      USING ERRCODE='23505';
  END IF;
END;
$$;

CREATE FUNCTION reserve_legacy_page_artifact_identity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
    IF NEW.artifact_id IS DISTINCT FROM OLD.artifact_id
       OR NEW.body_object_key IS DISTINCT FROM OLD.body_object_key THEN
      RAISE EXCEPTION 'legacy public artifact identity is immutable'
        USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  PERFORM reserve_public_artifact_identity(
    NEW.artifact_id,NEW.body_object_key,'legacy_page',NEW.artifact_id
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER public_resources_028_guard_identity
BEFORE INSERT OR UPDATE OR DELETE ON public_resources
FOR EACH ROW EXECUTE FUNCTION guard_public_resource_identity();
CREATE TRIGGER public_route_aliases_028_guard_namespace
BEFORE INSERT OR UPDATE OR DELETE ON public_route_aliases
FOR EACH ROW EXECUTE FUNCTION guard_legacy_alias_namespace();
CREATE TRIGGER public_artifact_reservations_028_guard_namespace
BEFORE INSERT OR UPDATE OR DELETE ON public_artifact_id_reservations
FOR EACH ROW EXECUTE FUNCTION guard_artifact_reservation_namespace();
CREATE TRIGGER published_page_artifacts_028_reserve_identity
BEFORE INSERT OR UPDATE OF artifact_id,body_object_key ON published_page_artifacts
FOR EACH ROW EXECUTE FUNCTION reserve_legacy_page_artifact_identity();

CREATE TRIGGER hypermedia_documents_028_guard_public_uuid
BEFORE INSERT OR UPDATE OF id ON hypermedia_documents
FOR EACH ROW EXECUTE FUNCTION guard_private_uuid_columns('id');
CREATE TRIGGER hypermedia_revisions_028_guard_public_uuid
BEFORE INSERT OR UPDATE OF id ON hypermedia_document_revisions
FOR EACH ROW EXECUTE FUNCTION guard_private_uuid_columns('id');
CREATE TRIGGER knowledge_directories_028_guard_public_uuid
BEFORE INSERT OR UPDATE OF id ON knowledge_directories
FOR EACH ROW EXECUTE FUNCTION guard_private_uuid_columns('id');
CREATE TRIGGER legacy_public_prefixes_028_guard_public_uuid
BEFORE INSERT OR UPDATE OF directory_id ON legacy_public_directory_prefixes
FOR EACH ROW EXECUTE FUNCTION guard_private_uuid_columns('directory_id');
CREATE TRIGGER corpus_directory_plans_028_guard_namespace
BEFORE INSERT OR UPDATE OF directory_id,private_revision_id,public_revision_id,public_id
ON corpus_directory_migration_plans
FOR EACH ROW EXECUTE FUNCTION guard_corpus_directory_plan_namespace();
CREATE TRIGGER corpus_page_plans_028_guard_public_uuid
BEFORE INSERT OR UPDATE OF rewrite_revision_id ON corpus_page_migration_plans
FOR EACH ROW EXECUTE FUNCTION guard_private_uuid_columns('rewrite_revision_id');
CREATE TRIGGER corpus_automation_plans_028_guard_public_uuid
BEFORE INSERT OR UPDATE OF instructions_document_id,state_document_id
ON corpus_migration_automation_plans
FOR EACH ROW EXECUTE FUNCTION guard_private_uuid_columns(
  'instructions_document_id','state_document_id'
);
CREATE TRIGGER operational_replacements_028_guard_public_uuid
BEFORE INSERT OR UPDATE OF replacement_document_id,replacement_revision_id,
  state_replacement_document_id,state_replacement_revision_id,
  agents_occupant_preservation_revision_id
ON operational_document_replacements
FOR EACH ROW EXECUTE FUNCTION guard_private_uuid_columns(
  'replacement_document_id','replacement_revision_id',
  'state_replacement_document_id','state_replacement_revision_id',
  'agents_occupant_preservation_revision_id'
);

-- Installation records every legacy collision deterministically rather than
-- invalidating old routes or rerolling an identity that may already be public.
CREATE VIEW live_public_namespace_conflicts
WITH (security_barrier=true,security_invoker=false)
AS
WITH private_identity(kind,id) AS (
  SELECT 'document',id FROM hypermedia_documents
  UNION ALL SELECT 'revision',id FROM hypermedia_document_revisions
  UNION ALL SELECT 'directory',id FROM knowledge_directories
  UNION ALL SELECT 'synthetic_directory',directory_id
    FROM legacy_public_directory_prefixes
  UNION ALL SELECT 'historical_document',original_document_id
    FROM public_resources WHERE original_document_id IS NOT NULL
  UNION ALL
  SELECT 'planned_directory_document',plan.directory_id
  FROM corpus_directory_migration_plans plan
  JOIN corpus_migration_runs run ON run.id=plan.run_id
  WHERE run.phase IN ('applying','ready')
  UNION ALL
  SELECT 'planned_private_revision',plan.private_revision_id
  FROM corpus_directory_migration_plans plan
  JOIN corpus_migration_runs run ON run.id=plan.run_id
  WHERE run.phase IN ('applying','ready') AND plan.private_revision_id IS NOT NULL
  UNION ALL
  SELECT 'planned_public_safe_revision',plan.public_revision_id
  FROM corpus_directory_migration_plans plan
  JOIN corpus_migration_runs run ON run.id=plan.run_id
  WHERE run.phase IN ('applying','ready') AND plan.public_revision_id IS NOT NULL
  UNION ALL
  SELECT 'planned_page_revision',plan.rewrite_revision_id
  FROM corpus_page_migration_plans plan
  JOIN corpus_migration_runs run ON run.id=plan.run_id
  WHERE run.phase IN ('applying','ready') AND plan.rewrite_revision_id IS NOT NULL
  UNION ALL
  SELECT 'planned_automation_document',plan.instructions_document_id
  FROM corpus_migration_automation_plans plan
  JOIN corpus_migration_runs run ON run.id=plan.run_id
  WHERE run.phase IN ('applying','ready')
  UNION ALL
  SELECT 'planned_automation_state',plan.state_document_id
  FROM corpus_migration_automation_plans plan
  JOIN corpus_migration_runs run ON run.id=plan.run_id
  WHERE run.phase IN ('applying','ready') AND plan.state_document_id IS NOT NULL
  UNION ALL
  SELECT 'planned_operational_document',replacement.replacement_document_id
  FROM operational_document_replacements replacement WHERE replacement.phase='planned'
  UNION ALL
  SELECT 'planned_operational_revision',replacement.replacement_revision_id
  FROM operational_document_replacements replacement WHERE replacement.phase='planned'
  UNION ALL
  SELECT 'planned_state_document',replacement.state_replacement_document_id
  FROM operational_document_replacements replacement
  WHERE replacement.phase='planned' AND replacement.state_replacement_document_id IS NOT NULL
  UNION ALL
  SELECT 'planned_state_revision',replacement.state_replacement_revision_id
  FROM operational_document_replacements replacement
  WHERE replacement.phase='planned' AND replacement.state_replacement_revision_id IS NOT NULL
  UNION ALL
  SELECT 'planned_preservation_revision',
    replacement.agents_occupant_preservation_revision_id
  FROM operational_document_replacements replacement
  WHERE replacement.phase='planned'
    AND replacement.agents_occupant_preservation_revision_id IS NOT NULL
), public_candidate(kind,public_id,document_id,resource_kind) AS (
  SELECT 'resource',public_id,original_document_id,resource_kind
  FROM public_resources
  UNION ALL
  SELECT 'planned_directory_resource',plan.public_id,plan.directory_id,
    'page'::publication_target
  FROM corpus_directory_migration_plans plan
  JOIN corpus_migration_runs run ON run.id=plan.run_id
  WHERE run.phase IN ('applying','ready') AND plan.public_id IS NOT NULL
), alias_token AS (
  SELECT alias.alias_path,alias.route_kind,alias.public_id,
    canonical_legacy_alias_uuid(alias.alias_path) AS token,
    canonical_legacy_alias_kind(alias.alias_path) AS expected_route_kind
  FROM public_route_aliases alias
  WHERE canonical_legacy_alias_uuid(alias.alias_path) IS NOT NULL
), detected AS (
  SELECT DISTINCT
    'public:'||candidate.kind||':'||candidate.public_id::text||
      ':private:'||private.kind AS conflict_key,
    candidate.public_id AS namespace_uuid,
    CASE WHEN candidate.kind='resource'
      THEN 'public_id_private_id' ELSE 'planned_public_id_private_id' END
      AS conflict_kind,
    candidate.public_id,NULL::text AS alias_path,private.kind AS identity_kind
  FROM public_candidate candidate
  JOIN private_identity private ON private.id=candidate.public_id
  UNION
  SELECT DISTINCT 'public:'||candidate.kind||':'||candidate.public_id::text||
    ':artifact',
    candidate.public_id,
    CASE WHEN candidate.kind='resource'
      THEN 'public_id_artifact_id' ELSE 'planned_public_id_artifact_id' END,
    candidate.public_id,NULL::text,'public_artifact'
  FROM public_candidate candidate
  JOIN public_artifact_id_reservations artifact
    ON artifact.artifact_id=candidate.public_id
  UNION
  SELECT DISTINCT 'public:'||candidate.kind||':'||candidate.public_id::text||
    ':alias:'||alias.alias_path,
    candidate.public_id,
    CASE WHEN candidate.kind='resource'
      THEN 'public_id_alias_token' ELSE 'planned_public_id_alias_token' END,
    candidate.public_id,alias.alias_path,'legacy_alias_token'
  FROM public_candidate candidate
  JOIN alias_token alias ON alias.token=candidate.public_id
  WHERE alias.public_id<>candidate.public_id
     OR alias.route_kind<>alias.expected_route_kind
     OR (candidate.resource_kind='page' AND alias.route_kind NOT IN ('page','markdown'))
     OR (candidate.resource_kind='asset' AND alias.route_kind<>'asset')
  UNION
  SELECT DISTINCT 'alias:'||alias.alias_path||':private:'||private.kind,
    alias.token,'alias_token_private_id',alias.public_id,alias.alias_path,private.kind
  FROM alias_token alias JOIN private_identity private ON private.id=alias.token
  UNION
  SELECT DISTINCT 'alias:'||alias.alias_path||':artifact',
    alias.token,'alias_token_artifact_id',alias.public_id,alias.alias_path,
    'public_artifact'
  FROM alias_token alias
  JOIN public_artifact_id_reservations artifact ON artifact.artifact_id=alias.token
  UNION
  SELECT DISTINCT 'artifact:'||artifact.artifact_id::text||':private:'||private.kind,
    artifact.artifact_id,'artifact_id_private_id',NULL::uuid,NULL::text,private.kind
  FROM public_artifact_id_reservations artifact
  JOIN private_identity private ON private.id=artifact.artifact_id
  UNION
  SELECT DISTINCT
    'planned-public-mapping:'||plan.run_id::text||':'||plan.directory_id::text,
    plan.public_id,'planned_public_id_public_mapping',plan.public_id,NULL::text,
    'planned_public_mapping'
  FROM corpus_directory_migration_plans plan
  JOIN corpus_migration_runs run ON run.id=plan.run_id
  JOIN public_resources resource
    ON resource.original_document_id=plan.directory_id
  WHERE run.phase IN ('applying','ready') AND plan.public_id IS NOT NULL
    AND resource.public_id<>plan.public_id
  UNION
  SELECT DISTINCT
    'planned-public-id-mapping:'||plan.run_id::text||':'||plan.directory_id::text,
    plan.public_id,'planned_public_id_public_mapping',plan.public_id,NULL::text,
    'public_resource_mapping'
  FROM corpus_directory_migration_plans plan
  JOIN corpus_migration_runs run ON run.id=plan.run_id
  JOIN public_resources resource ON resource.public_id=plan.public_id
  WHERE run.phase IN ('applying','ready') AND plan.public_id IS NOT NULL
    AND (
      resource.original_document_id IS DISTINCT FROM plan.directory_id
      OR resource.resource_kind<>'page'
    )
  UNION
  SELECT DISTINCT 'alias:'||alias.alias_path||':mapping',alias.token,
    'alias_token_public_mapping',alias.public_id,alias.alias_path,'public_resource'
  FROM alias_token alias
  LEFT JOIN public_resources resource ON resource.public_id=alias.token
  WHERE resource.public_id IS NULL
     OR alias.public_id<>alias.token
     OR alias.route_kind<>alias.expected_route_kind
     OR (resource.resource_kind='page' AND alias.route_kind NOT IN ('page','markdown'))
     OR (resource.resource_kind='asset' AND alias.route_kind<>'asset')
)
SELECT conflict_key,namespace_uuid,conflict_kind,public_id,alias_path,
  identity_kind AS conflicting_identity_kind,
  CASE
    WHEN left(conflict_kind,8)='planned_' OR left(identity_kind,8)='planned_'
      THEN 'planned'
    ELSE 'permanent'
  END AS conflict_lifecycle
FROM detected;

INSERT INTO public_namespace_conflicts(
  conflict_key,namespace_uuid,conflict_kind,public_id,alias_path,
  conflicting_identity_kind,conflict_lifecycle
)
SELECT conflict_key,namespace_uuid,conflict_kind,public_id,alias_path,
  conflicting_identity_kind,conflict_lifecycle
FROM live_public_namespace_conflicts
ON CONFLICT (conflict_key) DO NOTHING;

CREATE VIEW blocking_public_namespace_conflicts
WITH (security_barrier=true,security_invoker=false)
AS
SELECT conflict.conflict_key,conflict.namespace_uuid,conflict.conflict_kind,
  conflict.public_id,conflict.alias_path,conflict.conflicting_identity_kind,
  conflict.conflict_lifecycle,conflict.detected_at
FROM public_namespace_conflicts conflict
WHERE conflict.resolved_at IS NULL AND (
  conflict.conflict_lifecycle='permanent'
  OR EXISTS (
    SELECT 1 FROM live_public_namespace_conflicts live
    WHERE live.conflict_key=conflict.conflict_key
  )
);

CREATE FUNCTION reconcile_planned_public_namespace_conflicts()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
DECLARE
  reconciled integer;
BEGIN
  UPDATE public_namespace_conflicts conflict
  SET resolved_at=now()
  WHERE conflict.conflict_lifecycle='planned'
    AND conflict.resolved_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM live_public_namespace_conflicts live
      WHERE live.conflict_key=conflict.conflict_key
    );
  GET DIAGNOSTICS reconciled=ROW_COUNT;
  RETURN reconciled;
END;
$$;

CREATE FUNCTION reconcile_superseded_public_namespace_conflicts()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
BEGIN
  IF NEW.phase='superseded' AND OLD.phase IS DISTINCT FROM NEW.phase THEN
    PERFORM reconcile_planned_public_namespace_conflicts();
  END IF;
  RETURN NULL;
END;
$$;

CREATE FUNCTION reconcile_finished_operational_public_namespace_conflicts()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
BEGIN
  IF NEW.phase IN ('applied','superseded')
     AND OLD.phase IS DISTINCT FROM NEW.phase THEN
    PERFORM reconcile_planned_public_namespace_conflicts();
  END IF;
  RETURN NULL;
END;
$$;

CREATE FUNCTION guard_corpus_migration_phase_progression()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=pg_catalog
AS $$
BEGIN
  IF NEW.phase IS NOT DISTINCT FROM OLD.phase THEN RETURN NEW; END IF;
  IF (OLD.phase='applying' AND NEW.phase IN ('ready','superseded'))
     OR (OLD.phase='ready' AND NEW.phase='superseded') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'corpus migration phase is terminal or cannot move backward'
    USING ERRCODE='23514';
END;
$$;

CREATE FUNCTION guard_operational_replacement_phase_progression()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=pg_catalog
AS $$
BEGIN
  IF NEW.phase IS NOT DISTINCT FROM OLD.phase THEN RETURN NEW; END IF;
  IF OLD.phase='planned' AND NEW.phase IN ('applied','superseded') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'operational replacement phase is terminal or cannot move backward'
    USING ERRCODE='23514';
END;
$$;

CREATE TRIGGER corpus_runs_028_reconcile_namespace_conflicts
AFTER UPDATE OF phase ON corpus_migration_runs
FOR EACH ROW EXECUTE FUNCTION reconcile_superseded_public_namespace_conflicts();
CREATE TRIGGER corpus_runs_028_guard_phase_progression
BEFORE UPDATE OF phase ON corpus_migration_runs
FOR EACH ROW EXECUTE FUNCTION guard_corpus_migration_phase_progression();
CREATE TRIGGER operational_replacements_028_guard_phase_progression
BEFORE UPDATE OF phase ON operational_document_replacements
FOR EACH ROW EXECUTE FUNCTION guard_operational_replacement_phase_progression();
CREATE TRIGGER operational_replacements_028_reconcile_namespace_conflicts
AFTER UPDATE OF phase ON operational_document_replacements
FOR EACH ROW
EXECUTE FUNCTION reconcile_finished_operational_public_namespace_conflicts();

-- Keep the rollback publication boundary usable while making it participate in
-- the same stable-world protocol as corpus preparation and later v2 writes.
-- This is deliberately the first database lock for both page and asset intents.
CREATE OR REPLACE FUNCTION confirm_publication_intent(
  p_intent_id uuid,
  p_owner_user_id text,
  p_session_id text,
  p_credential_id text,
  p_expected_counter integer,
  p_new_counter integer
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
DECLARE
  intent record;
  intent_challenge text;
BEGIN
  PERFORM pg_advisory_xact_lock_shared(
    hashtextextended('filesystem-hypermedia-corpus-transition',0)
  );

  IF p_owner_user_id IS NULL OR p_session_id IS NULL
     OR p_credential_id IS NULL OR length(trim(p_credential_id))<1
     OR p_expected_counter IS NULL OR p_new_counter IS NULL THEN
    RAISE EXCEPTION 'verified publication principal required' USING ERRCODE='42501';
  END IF;

  SELECT
    id,action,target_kind,target_id,version_id,public_path,
    owner_user_id,session_id,expires_at
  INTO intent
  FROM publication_intents
  WHERE id=p_intent_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'publication intent not found' USING ERRCODE='P0002';
  END IF;
  IF intent.expires_at<=now() THEN
    RAISE EXCEPTION 'publication intent expired' USING ERRCODE='22023';
  END IF;
  IF intent.owner_user_id IS DISTINCT FROM p_owner_user_id
     OR intent.session_id IS DISTINCT FROM p_session_id THEN
    RAISE EXCEPTION 'publication intent principal mismatch' USING ERRCODE='42501';
  END IF;
  SELECT challenge INTO intent_challenge
  FROM confirmation_challenges
  WHERE intent_kind='publication' AND intent_id=intent.id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'publication challenge not issued' USING ERRCODE='42501';
  END IF;

  PERFORM consume_confirmation_challenge(
    'publication',intent.id,intent_challenge,intent.owner_user_id,
    p_credential_id,p_expected_counter,p_new_counter
  );

  IF intent.target_kind='page' THEN
    PERFORM lock_operational_document(intent.target_id);
    IF intent.action='publish' THEN
      IF NOT EXISTS (
        SELECT 1
        FROM knowledge_page_versions version
        JOIN knowledge_pages page ON page.id=version.page_id
        WHERE version.id=intent.version_id
          AND version.page_id=intent.target_id
          AND version.path=intent.public_path
      ) THEN
        RAISE EXCEPTION 'page version or public path mismatch' USING ERRCODE='23503';
      END IF;
      UPDATE knowledge_pages
      SET published_version_id=intent.version_id,
          public_path=intent.public_path,
          updated_at=now()
      WHERE id=intent.target_id AND archived_at IS NULL;
    ELSE
      UPDATE knowledge_pages
      SET published_version_id=NULL,public_path=NULL,updated_at=now()
      WHERE id=intent.target_id;
    END IF;
  ELSE
    IF intent.action='publish' THEN
      UPDATE assets
      SET public_path=intent.public_path
      WHERE id=intent.target_id
        AND deleted_at IS NULL
        AND current_path=intent.public_path;
    ELSE
      UPDATE assets
      SET public_path=NULL
      WHERE id=intent.target_id;
    END IF;
  END IF;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'publication target not found' USING ERRCODE='P0002';
  END IF;
  DELETE FROM publication_intents WHERE id=intent.id;
END;
$$;

-- An active v2 pin is independently public even when the rollback columns are
-- NULL. Ordinary private lifecycle operations must unpublish it explicitly
-- before archiving or deleting the private identity.
CREATE FUNCTION protect_active_pathless_page_publication()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
BEGIN
  IF (TG_OP='DELETE' OR NEW.archived_at IS NOT NULL) AND EXISTS (
    SELECT 1
    FROM public_resources resource
    JOIN page_publications publication ON publication.public_id=resource.public_id
    WHERE resource.original_document_id=OLD.id
  ) THEN
    RAISE EXCEPTION 'an actively published v2 page cannot be archived or deleted'
      USING ERRCODE='23514';
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE FUNCTION protect_active_pathless_asset_publication()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
BEGIN
  IF (TG_OP='DELETE' OR NEW.deleted_at IS NOT NULL) AND EXISTS (
    SELECT 1
    FROM public_resources resource
    JOIN asset_publications publication ON publication.public_id=resource.public_id
    WHERE resource.original_document_id=OLD.id
  ) THEN
    RAISE EXCEPTION 'an actively published v2 asset cannot be archived or deleted'
      USING ERRCODE='23514';
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE FUNCTION validate_active_pathless_publication_pin()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
DECLARE
  target_document_id uuid;
BEGIN
  IF TG_OP='UPDATE' THEN
    RAISE EXCEPTION 'active pathless publication pins are immutable; unpublish first'
      USING ERRCODE='23514';
  END IF;
  IF TG_TABLE_NAME='page_publications' THEN
    SELECT document_id INTO target_document_id
    FROM public_resources WHERE public_id=NEW.public_id;
    PERFORM 1
    FROM knowledge_pages page
    WHERE page.id=target_document_id AND page.archived_at IS NULL
    FOR SHARE OF page;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'a page pin requires an active mapped private page'
        USING ERRCODE='23514';
    END IF;
    PERFORM 1
    FROM public_resources resource
    WHERE resource.public_id=NEW.public_id
      AND resource.document_id=target_document_id
      AND resource.resource_kind='page'
    FOR SHARE OF resource;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'a page pin requires an active mapped private page'
        USING ERRCODE='23514';
    END IF;
    IF EXISTS (
      SELECT 1 FROM public_page_artifacts artifact
      WHERE artifact.public_id=NEW.public_id
        AND artifact.artifact_id=NEW.artifact_id
        AND artifact.origin='directory_hub_promotion'
    ) THEN
      PERFORM 1
      FROM public_page_artifacts artifact
      JOIN directory_hub_migrations mapping
        ON mapping.document_id=artifact.source_document_id
       AND mapping.public_id=artifact.public_id
       AND mapping.public_revision_id=artifact.source_revision_id
      WHERE artifact.public_id=NEW.public_id
        AND artifact.artifact_id=NEW.artifact_id
        AND artifact.origin='directory_hub_promotion'
      FOR SHARE OF mapping;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'a promoted hub pin requires its exact live mapping proof'
          USING ERRCODE='23514';
      END IF;
    END IF;
  ELSIF TG_TABLE_NAME='asset_publications' THEN
    SELECT document_id INTO target_document_id
    FROM public_resources WHERE public_id=NEW.public_id;
    PERFORM 1
    FROM assets asset
    WHERE asset.id=target_document_id AND asset.deleted_at IS NULL
    FOR SHARE OF asset;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'an asset pin requires an active mapped private asset'
        USING ERRCODE='23514';
    END IF;
    PERFORM 1
    FROM public_resources resource
    WHERE resource.public_id=NEW.public_id
      AND resource.document_id=target_document_id
      AND resource.resource_kind='asset'
    FOR SHARE OF resource;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'an asset pin requires an active mapped private asset'
        USING ERRCODE='23514';
    END IF;
  ELSE
    RAISE EXCEPTION 'pathless pin guard attached to an unsupported relation'
      USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;

-- A previous binary may still change the legacy visibility columns. Keep a
-- v2 page pin only when its immutable artifact still proves the exact legacy
-- published revision. Path-only changes and private-current edits are harmless.
CREATE FUNCTION invalidate_pathless_page_publication_on_legacy_drift()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
BEGIN
  DELETE FROM page_publications publication
  USING public_page_artifacts artifact
  WHERE publication.public_id=artifact.public_id
    AND publication.artifact_id=artifact.artifact_id
    AND artifact.source_document_id=NEW.id
    AND (
      NEW.archived_at IS NOT NULL
      OR NEW.published_version_id IS NULL
      OR NEW.public_path IS NULL
      OR artifact.source_revision_id<>NEW.published_version_id
    );
  RETURN NULL;
END;
$$;

-- Asset rows are byte-immutable. A legacy unpublish removes the v2 pin; a
-- later legacy publish does not silently recreate one.
CREATE FUNCTION invalidate_pathless_asset_publication_on_legacy_drift()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
BEGIN
  IF NEW.public_path IS NULL OR NEW.deleted_at IS NOT NULL THEN
    DELETE FROM asset_publications publication
    USING public_asset_artifacts artifact
    WHERE publication.public_id=artifact.public_id
      AND publication.artifact_id=artifact.artifact_id
      AND artifact.source_document_id=NEW.id;
  END IF;
  RETURN NULL;
END;
$$;

-- A promoted directory hub is trusted only for the exact 026 mapping proof.
-- Mapping drift unpins it while retaining the immutable projected artifact.
CREATE FUNCTION invalidate_pathless_hub_publication_on_mapping_drift()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    DELETE FROM page_publications publication
    USING public_page_artifacts artifact
    WHERE publication.public_id=artifact.public_id
      AND publication.artifact_id=artifact.artifact_id
      AND artifact.origin='directory_hub_promotion'
      AND artifact.source_document_id=OLD.document_id;
  ELSIF NEW.document_id IS DISTINCT FROM OLD.document_id
     OR NEW.public_id IS DISTINCT FROM OLD.public_id
     OR NEW.public_revision_id IS DISTINCT FROM OLD.public_revision_id THEN
    DELETE FROM page_publications publication
    USING public_page_artifacts artifact
    WHERE publication.public_id=artifact.public_id
      AND publication.artifact_id=artifact.artifact_id
      AND artifact.origin='directory_hub_promotion'
      AND artifact.source_document_id=OLD.document_id
      AND (
        artifact.source_document_id IS DISTINCT FROM NEW.document_id
        OR artifact.public_id IS DISTINCT FROM NEW.public_id
        OR artifact.source_revision_id IS DISTINCT FROM NEW.public_revision_id
      );
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER knowledge_pages_028_protect_active_publication_update
BEFORE UPDATE OF archived_at ON knowledge_pages
FOR EACH ROW EXECUTE FUNCTION protect_active_pathless_page_publication();
CREATE TRIGGER knowledge_pages_028_protect_active_publication_delete
BEFORE DELETE ON knowledge_pages
FOR EACH ROW EXECUTE FUNCTION protect_active_pathless_page_publication();
CREATE TRIGGER assets_028_protect_active_publication_update
BEFORE UPDATE OF deleted_at ON assets
FOR EACH ROW EXECUTE FUNCTION protect_active_pathless_asset_publication();
CREATE TRIGGER assets_028_protect_active_publication_delete
BEFORE DELETE ON assets
FOR EACH ROW EXECUTE FUNCTION protect_active_pathless_asset_publication();
CREATE TRIGGER page_publications_028_validate_active_mapping
BEFORE INSERT OR UPDATE ON page_publications
FOR EACH ROW EXECUTE FUNCTION validate_active_pathless_publication_pin();
CREATE TRIGGER asset_publications_028_validate_active_mapping
BEFORE INSERT OR UPDATE ON asset_publications
FOR EACH ROW EXECUTE FUNCTION validate_active_pathless_publication_pin();

CREATE TRIGGER knowledge_pages_028_invalidate_publication_on_legacy_drift
AFTER UPDATE OF published_version_id,public_path,archived_at ON knowledge_pages
FOR EACH ROW
EXECUTE FUNCTION invalidate_pathless_page_publication_on_legacy_drift();
CREATE TRIGGER assets_028_invalidate_publication_on_legacy_drift
AFTER UPDATE OF public_path,deleted_at ON assets
FOR EACH ROW
EXECUTE FUNCTION invalidate_pathless_asset_publication_on_legacy_drift();
CREATE TRIGGER directory_hubs_028_invalidate_publication_on_mapping_drift
AFTER UPDATE OF document_id,public_id,public_revision_id OR DELETE
ON directory_hub_migrations
FOR EACH ROW
EXECUTE FUNCTION invalidate_pathless_hub_publication_on_mapping_drift();

-- Preserve the production reset signature for rolling binaries, but fail
-- closed once any real v2 allocation, work item, history, pin or configuration
-- exists. Legacy reservation backfill, collision audit rows and the untouched
-- default settings row are installation metadata and do not block rollback.
ALTER FUNCTION clear_knowledge(
  uuid,text,text,uuid,text,integer,text,text,text,text,text,tsvector,text,text
) RENAME TO clear_knowledge_legacy_implementation;

REVOKE ALL ON FUNCTION clear_knowledge_legacy_implementation(
  uuid,text,text,uuid,text,integer,text,text,text,text,text,tsvector,text,text
) FROM PUBLIC,context_use_dashboard,context_use_auth,context_use_confirmation,
  context_use_mcp,context_use_public,context_use_storage,context_use_backup,
  context_use_corpus;

CREATE FUNCTION clear_knowledge(
  p_intent_id uuid,
  p_owner_user_id text,
  p_session_id text,
  p_guide_version_id uuid,
  p_guide_object_key text,
  p_guide_size_bytes integer,
  p_guide_content_hash text,
  p_root_title text,
  p_root_summary text,
  p_guide_title text,
  p_guide_summary text,
  p_guide_search_vector tsvector,
  p_guide_commit_message text,
  p_guide_actor_subject text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
DECLARE
  intent record;
BEGIN
  -- Reject unauthenticated/junk calls before exposing the exclusive transition
  -- lock to the long-lived dashboard credential. The legacy implementation
  -- repeats these checks authoritatively after the barrier.
  IF p_owner_user_id IS NULL OR p_session_id IS NULL THEN
    RAISE EXCEPTION 'knowledge reset principal required' USING ERRCODE='42501';
  END IF;
  IF p_guide_version_id IS NULL
     OR p_guide_object_key IS DISTINCT FROM
       'documents/private/'||p_guide_version_id::text||'.md'
     OR p_guide_size_bytes NOT BETWEEN 0 AND 4000000
     OR p_guide_content_hash !~ '^[a-f0-9]{64}$'
     OR p_guide_search_vector IS NULL THEN
    RAISE EXCEPTION 'knowledge reset guide object metadata is invalid'
      USING ERRCODE='22023';
  END IF;
  IF p_guide_actor_subject IS NULL
     OR (
       p_guide_actor_subject<>'context-use-bootstrap'
       AND p_guide_actor_subject !~ '^context-use-template/[a-z0-9]+(-[a-z0-9]+)*$'
     ) THEN
    RAISE EXCEPTION 'knowledge reset guide must be authored by a template'
      USING ERRCODE='22023';
  END IF;

  SELECT owner_user_id,session_id,expires_at,confirmed_at,reset_requested,
    download_completed_at,reset_completed_at
  INTO intent
  FROM knowledge_export_intents
  WHERE id=p_intent_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'knowledge reset intent not found' USING ERRCODE='P0002';
  END IF;
  IF NOT intent.reset_requested THEN
    RAISE EXCEPTION 'knowledge export was not authorized to clear knowledge'
      USING ERRCODE='42501';
  END IF;
  IF intent.owner_user_id IS DISTINCT FROM p_owner_user_id
     OR intent.session_id IS DISTINCT FROM p_session_id THEN
    RAISE EXCEPTION 'knowledge reset principal mismatch' USING ERRCODE='42501';
  END IF;
  IF intent.confirmed_at IS NULL THEN
    RAISE EXCEPTION 'knowledge reset passkey confirmation required'
      USING ERRCODE='42501';
  END IF;
  IF intent.download_completed_at IS NULL THEN
    RAISE EXCEPTION 'knowledge reset requires the portable snapshot download to finish'
      USING ERRCODE='55000';
  END IF;
  IF intent.reset_completed_at IS NOT NULL THEN
    RAISE EXCEPTION 'knowledge reset intent already used' USING ERRCODE='23505';
  END IF;
  IF intent.expires_at<=now() THEN
    RAISE EXCEPTION 'knowledge reset intent expired' USING ERRCODE='22023';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('filesystem-hypermedia-corpus-transition',0)
  );

  IF EXISTS (
    SELECT 1 FROM public_artifact_id_reservations
    WHERE allocation_kind<>'legacy_page'
  ) OR EXISTS (
    SELECT 1 FROM pathless_publication_intents
  ) OR EXISTS (
    SELECT 1 FROM pathless_publication_artifact_staging
  ) OR EXISTS (
    SELECT 1 FROM pathless_publication_adoptions
  ) OR EXISTS (
    SELECT 1 FROM public_page_artifacts
  ) OR EXISTS (
    SELECT 1 FROM public_asset_artifacts
  ) OR EXISTS (
    SELECT 1 FROM page_publications
  ) OR EXISTS (
    SELECT 1 FROM asset_publications
  ) OR EXISTS (
    SELECT 1 FROM pathless_publication_settings WHERE updated_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'knowledge reset requires the pathless export/reset boundary'
      USING ERRCODE='55000';
  END IF;

  RETURN clear_knowledge_legacy_implementation(
    p_intent_id,p_owner_user_id,p_session_id,p_guide_version_id,
    p_guide_object_key,p_guide_size_bytes,p_guide_content_hash,p_root_title,
    p_root_summary,p_guide_title,p_guide_summary,p_guide_search_vector,
    p_guide_commit_message,p_guide_actor_subject
  );
END;
$$;

-- The corpus audit takes table-level SHARE locks so its inventory cannot miss
-- a concurrent legacy route/resource allocation. PostgreSQL requires a
-- table-wide write privilege to take those lock modes, but the general
-- boundary owner must retain only the checked document_id detachment grant.
-- Isolate that capability in a non-login owner behind two fixed, argument-free
-- lock helpers; no application or corpus login can execute them directly.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname='context_use_publication_lock_owner'
  ) THEN
    CREATE ROLE context_use_publication_lock_owner
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  ELSE
    ALTER ROLE context_use_publication_lock_owner
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
  ALTER ROLE context_use_publication_lock_owner
    SET search_path=pg_catalog,public;
END;
$$;

GRANT USAGE ON SCHEMA public TO context_use_publication_lock_owner;
GRANT UPDATE ON public_resources,public_route_aliases
  TO context_use_publication_lock_owner;

CREATE FUNCTION lock_public_routing_audit_tables()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
BEGIN
  LOCK TABLE public_resources,public_route_aliases IN SHARE MODE;
END;
$$;

CREATE FUNCTION lock_public_routing_apply_tables()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
BEGIN
  LOCK TABLE public_resources,public_route_aliases IN SHARE ROW EXCLUSIVE MODE;
END;
$$;

REVOKE ALL ON FUNCTION lock_public_routing_audit_tables() FROM PUBLIC;
REVOKE ALL ON FUNCTION lock_public_routing_apply_tables() FROM PUBLIC;
GRANT CREATE ON SCHEMA public TO context_use_publication_lock_owner;
ALTER FUNCTION lock_public_routing_audit_tables()
  OWNER TO context_use_publication_lock_owner;
ALTER FUNCTION lock_public_routing_apply_tables()
  OWNER TO context_use_publication_lock_owner;
REVOKE CREATE ON SCHEMA public FROM context_use_publication_lock_owner;
GRANT EXECUTE ON FUNCTION lock_public_routing_audit_tables(),
  lock_public_routing_apply_tables() TO context_use_boundary_owner;

CREATE OR REPLACE FUNCTION lock_corpus_migration_audit_tables()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
BEGIN
  LOCK TABLE knowledge_directories,legacy_public_directory_prefixes,
    knowledge_pages,knowledge_page_versions,
    assets,source_records,hypermedia_document_revisions,document_links,
    knowledge_asset_links,automation_registry,knowledge_settings,
    public_knowledge_settings IN SHARE MODE;
  PERFORM lock_public_routing_audit_tables();
  LOCK TABLE public_projection_state,published_page_artifacts IN SHARE MODE;
END;
$$;

CREATE OR REPLACE FUNCTION lock_corpus_migration_hub_apply_tables()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
BEGIN
  LOCK TABLE knowledge_directories,legacy_public_directory_prefixes,
    knowledge_pages,knowledge_page_versions,
    assets,source_records,hypermedia_document_revisions,document_links,
    knowledge_asset_links,automation_registry,knowledge_settings,
    public_knowledge_settings IN SHARE ROW EXCLUSIVE MODE;
  PERFORM lock_public_routing_apply_tables();
  LOCK TABLE public_projection_state,published_page_artifacts
    IN SHARE ROW EXCLUSIVE MODE;
END;
$$;

REVOKE ALL ON FUNCTION lock_public_uuid_namespace(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION canonical_legacy_alias_uuid(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION canonical_legacy_alias_kind(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public_uuid_has_private_identity(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public_uuid_has_artifact_identity(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public_uuid_has_reserved_public_identity(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public_uuid_has_legacy_alias_token(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION assert_private_uuid_available(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION assert_public_uuid_available(uuid,uuid,publication_target)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION guard_private_uuid_columns() FROM PUBLIC;
REVOKE ALL ON FUNCTION guard_corpus_directory_plan_namespace() FROM PUBLIC;
REVOKE ALL ON FUNCTION guard_public_resource_identity() FROM PUBLIC;
REVOKE ALL ON FUNCTION guard_legacy_alias_namespace() FROM PUBLIC;
REVOKE ALL ON FUNCTION guard_artifact_reservation_namespace() FROM PUBLIC;
REVOKE ALL ON FUNCTION reserve_public_artifact_identity(
  uuid,text,public_artifact_allocation_kind,uuid
) FROM PUBLIC;
REVOKE ALL ON FUNCTION reserve_legacy_page_artifact_identity() FROM PUBLIC;
REVOKE ALL ON FUNCTION reconcile_planned_public_namespace_conflicts() FROM PUBLIC;
REVOKE ALL ON FUNCTION reconcile_superseded_public_namespace_conflicts() FROM PUBLIC;
REVOKE ALL ON FUNCTION reconcile_finished_operational_public_namespace_conflicts()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION guard_corpus_migration_phase_progression() FROM PUBLIC;
REVOKE ALL ON FUNCTION guard_operational_replacement_phase_progression() FROM PUBLIC;
REVOKE ALL ON FUNCTION protect_active_pathless_page_publication() FROM PUBLIC;
REVOKE ALL ON FUNCTION protect_active_pathless_asset_publication() FROM PUBLIC;
REVOKE ALL ON FUNCTION validate_active_pathless_publication_pin() FROM PUBLIC;
REVOKE ALL ON FUNCTION invalidate_pathless_page_publication_on_legacy_drift()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION invalidate_pathless_asset_publication_on_legacy_drift()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION invalidate_pathless_hub_publication_on_mapping_drift()
  FROM PUBLIC;

-- Existing legacy public-resource writers still insert through checked definer
-- boundaries. They never require direct mutation of a permanent resource or
-- alias, and removing these broad 026 grants closes that escape hatch.
REVOKE UPDATE ON public_resources,public_route_aliases
  FROM context_use_boundary_owner;
GRANT UPDATE (document_id) ON public_resources TO context_use_boundary_owner;

GRANT SELECT (
  artifact_id,body_object_key,allocation_kind,allocation_id,created_at
) ON public_artifact_id_reservations TO context_use_boundary_owner;
GRANT INSERT (
  artifact_id,body_object_key,allocation_kind,allocation_id,created_at
) ON public_artifact_id_reservations TO context_use_boundary_owner;
GRANT SELECT (
  public_id,artifact_id
) ON page_publications,asset_publications TO context_use_boundary_owner;
GRANT DELETE ON page_publications,asset_publications TO context_use_boundary_owner;
GRANT SELECT (
  artifact_id,public_id,source_document_id,source_revision_id,origin
) ON public_page_artifacts TO context_use_boundary_owner;
GRANT SELECT (
  artifact_id,public_id,source_document_id,origin
) ON public_asset_artifacts TO context_use_boundary_owner;
GRANT SELECT (
  conflict_key,namespace_uuid,conflict_kind,public_id,alias_path,
  conflicting_identity_kind,conflict_lifecycle,detected_at,resolved_at
) ON public_namespace_conflicts TO context_use_boundary_owner;
GRANT UPDATE (resolved_at) ON public_namespace_conflicts
  TO context_use_boundary_owner;

-- The projection owner can evaluate the two audited conflict views, but only
-- from the columns used by their definitions.
GRANT SELECT (id) ON hypermedia_documents,hypermedia_document_revisions,
  knowledge_directories TO context_use_projection_owner;
GRANT SELECT (directory_id) ON legacy_public_directory_prefixes
  TO context_use_projection_owner;
GRANT SELECT (public_id,original_document_id,resource_kind)
  ON public_resources TO context_use_projection_owner;
GRANT SELECT (alias_path,route_kind,public_id) ON public_route_aliases
  TO context_use_projection_owner;
GRANT SELECT (artifact_id) ON public_artifact_id_reservations
  TO context_use_projection_owner;
GRANT SELECT (id,phase) ON corpus_migration_runs TO context_use_projection_owner;
GRANT SELECT (
  run_id,directory_id,private_revision_id,public_revision_id,public_id
) ON corpus_directory_migration_plans TO context_use_projection_owner;
GRANT SELECT (run_id,rewrite_revision_id) ON corpus_page_migration_plans
  TO context_use_projection_owner;
GRANT SELECT (run_id,instructions_document_id,state_document_id)
  ON corpus_migration_automation_plans TO context_use_projection_owner;
GRANT SELECT (
  phase,replacement_document_id,replacement_revision_id,
  state_replacement_document_id,state_replacement_revision_id,
  agents_occupant_preservation_revision_id
) ON operational_document_replacements TO context_use_projection_owner;
GRANT SELECT (
  conflict_key,namespace_uuid,conflict_kind,public_id,alias_path,
  conflicting_identity_kind,conflict_lifecycle,detected_at,resolved_at
) ON public_namespace_conflicts TO context_use_projection_owner;

GRANT USAGE,CREATE ON SCHEMA public TO context_use_boundary_owner;
ALTER FUNCTION lock_public_uuid_namespace(uuid) OWNER TO context_use_boundary_owner;
ALTER FUNCTION canonical_legacy_alias_uuid(text) OWNER TO context_use_boundary_owner;
ALTER FUNCTION canonical_legacy_alias_kind(text) OWNER TO context_use_boundary_owner;
ALTER FUNCTION public_uuid_has_private_identity(uuid)
  OWNER TO context_use_boundary_owner;
ALTER FUNCTION public_uuid_has_artifact_identity(uuid)
  OWNER TO context_use_boundary_owner;
ALTER FUNCTION public_uuid_has_reserved_public_identity(uuid)
  OWNER TO context_use_boundary_owner;
ALTER FUNCTION public_uuid_has_legacy_alias_token(uuid)
  OWNER TO context_use_boundary_owner;
ALTER FUNCTION assert_private_uuid_available(uuid)
  OWNER TO context_use_boundary_owner;
ALTER FUNCTION assert_public_uuid_available(uuid,uuid,publication_target)
  OWNER TO context_use_boundary_owner;
ALTER FUNCTION guard_private_uuid_columns() OWNER TO context_use_boundary_owner;
ALTER FUNCTION guard_corpus_directory_plan_namespace()
  OWNER TO context_use_boundary_owner;
ALTER FUNCTION guard_public_resource_identity() OWNER TO context_use_boundary_owner;
ALTER FUNCTION guard_legacy_alias_namespace() OWNER TO context_use_boundary_owner;
ALTER FUNCTION guard_artifact_reservation_namespace()
  OWNER TO context_use_boundary_owner;
ALTER FUNCTION reserve_public_artifact_identity(
  uuid,text,public_artifact_allocation_kind,uuid
) OWNER TO context_use_boundary_owner;
ALTER FUNCTION reserve_legacy_page_artifact_identity()
  OWNER TO context_use_boundary_owner;
ALTER FUNCTION reconcile_planned_public_namespace_conflicts()
  OWNER TO context_use_boundary_owner;
ALTER FUNCTION reconcile_superseded_public_namespace_conflicts()
  OWNER TO context_use_boundary_owner;
ALTER FUNCTION reconcile_finished_operational_public_namespace_conflicts()
  OWNER TO context_use_boundary_owner;
ALTER FUNCTION guard_corpus_migration_phase_progression()
  OWNER TO context_use_boundary_owner;
ALTER FUNCTION guard_operational_replacement_phase_progression()
  OWNER TO context_use_boundary_owner;
ALTER FUNCTION protect_active_pathless_page_publication()
  OWNER TO context_use_boundary_owner;
ALTER FUNCTION protect_active_pathless_asset_publication()
  OWNER TO context_use_boundary_owner;
ALTER FUNCTION validate_active_pathless_publication_pin()
  OWNER TO context_use_boundary_owner;
ALTER FUNCTION invalidate_pathless_page_publication_on_legacy_drift()
  OWNER TO context_use_boundary_owner;
ALTER FUNCTION invalidate_pathless_asset_publication_on_legacy_drift()
  OWNER TO context_use_boundary_owner;
ALTER FUNCTION invalidate_pathless_hub_publication_on_mapping_drift()
  OWNER TO context_use_boundary_owner;
ALTER FUNCTION confirm_publication_intent(uuid,text,text,text,integer,integer)
  OWNER TO context_use_boundary_owner;
REVOKE CREATE ON SCHEMA public FROM context_use_boundary_owner;

GRANT EXECUTE ON FUNCTION canonical_legacy_alias_uuid(text),
  canonical_legacy_alias_kind(text) TO context_use_projection_owner;
GRANT CREATE ON SCHEMA public TO context_use_projection_owner;
ALTER VIEW live_public_namespace_conflicts OWNER TO context_use_projection_owner;
ALTER VIEW blocking_public_namespace_conflicts OWNER TO context_use_projection_owner;
REVOKE CREATE ON SCHEMA public FROM context_use_projection_owner;
GRANT SELECT ON live_public_namespace_conflicts
  TO context_use_boundary_owner;

-- Reset's compatibility wrapper needs only the existence predicates above;
-- the destructive implementation remains executable solely by its owner.
GRANT SELECT (allocation_kind) ON public_artifact_id_reservations
  TO context_use_reset_owner;
GRANT SELECT (id) ON pathless_publication_intents,
  pathless_publication_adoptions TO context_use_reset_owner;
GRANT SELECT (intent_id) ON pathless_publication_artifact_staging
  TO context_use_reset_owner;
GRANT SELECT (artifact_id) ON public_page_artifacts,public_asset_artifacts
  TO context_use_reset_owner;
GRANT SELECT (public_id) ON page_publications,asset_publications
  TO context_use_reset_owner;
GRANT SELECT (updated_at) ON pathless_publication_settings
  TO context_use_reset_owner;
GRANT CREATE ON SCHEMA public TO context_use_reset_owner;
ALTER FUNCTION clear_knowledge(
  uuid,text,text,uuid,text,integer,text,text,text,text,text,tsvector,text,text
) OWNER TO context_use_reset_owner;
REVOKE CREATE ON SCHEMA public FROM context_use_reset_owner;
REVOKE ALL ON FUNCTION clear_knowledge(
  uuid,text,text,uuid,text,integer,text,text,text,text,text,tsvector,text,text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION clear_knowledge(
  uuid,text,text,uuid,text,integer,text,text,text,text,text,tsvector,text,text
) TO context_use_dashboard;

-- Historical publication evidence is part of backup even while inactive.
GRANT SELECT ON public_artifact_id_reservations,pathless_publication_intents,
  pathless_publication_artifact_staging,public_page_artifacts,
  public_asset_artifacts,page_publications,asset_publications,
  pathless_publication_settings,pathless_publication_adoptions,
  public_namespace_conflicts,live_public_namespace_conflicts,
  blocking_public_namespace_conflicts TO context_use_backup;
GRANT SELECT (original_document_id) ON public_resources TO context_use_backup;

-- Allocation is an internal primitive for later checked intent/adoption
-- boundaries, never a capability of a long-lived application login.
REVOKE ALL ON FUNCTION reserve_public_artifact_identity(
  uuid,text,public_artifact_allocation_kind,uuid
) FROM context_use_dashboard,context_use_mcp,context_use_public,
  context_use_storage,context_use_confirmation,context_use_corpus,
  context_use_backup,context_use_auth;
