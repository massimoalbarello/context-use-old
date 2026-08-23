-- Establish the global namespaces and monotonic visibility clock required by
-- the checked pathless publication API. The API boundaries are added below;
-- these registries first close rolling-writer races around the 028 substrate.

-- This is the first stateful lock taken by every supported legacy/v2 publication and
-- corpus writer. Hold it exclusively through all audits, backfills and trigger
-- installation so the snapshots below describe one stable visibility world.
SELECT pg_advisory_xact_lock(
  hashtextextended('filesystem-hypermedia-corpus-transition',0)
);

-- The durable conflict ledger is the checked read boundary. Planned conflicts
-- are reconciled synchronously when their only mutable authorities finish or
-- are deleted; evaluating the full live-conflict audit graph on every public
-- read gives PostgreSQL a very high-cost plan and can trigger excessive JIT
-- compilation even when no planned conflict exists.
ALTER FUNCTION reconcile_planned_public_namespace_conflicts() SET jit=off;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public_namespace_conflicts
    WHERE conflict_lifecycle='planned' AND resolved_at IS NULL
  ) THEN
    PERFORM reconcile_planned_public_namespace_conflicts();
  END IF;
END;
$$;

CREATE OR REPLACE VIEW blocking_public_namespace_conflicts
WITH (security_barrier=true,security_invoker=false)
AS
SELECT conflict.conflict_key,conflict.namespace_uuid,conflict.conflict_kind,
  conflict.public_id,conflict.alias_path,conflict.conflicting_identity_kind,
  conflict.conflict_lifecycle,conflict.detected_at
FROM public_namespace_conflicts conflict
WHERE conflict.resolved_at IS NULL;

CREATE FUNCTION reconcile_deleted_public_namespace_conflicts()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public_namespace_conflicts
    WHERE conflict_lifecycle='planned' AND resolved_at IS NULL
  ) THEN
    PERFORM reconcile_planned_public_namespace_conflicts();
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER corpus_runs_029_reconcile_conflict_delete
AFTER DELETE ON corpus_migration_runs
FOR EACH STATEMENT
EXECUTE FUNCTION reconcile_deleted_public_namespace_conflicts();
CREATE TRIGGER corpus_directory_plans_029_reconcile_conflict_delete
AFTER DELETE ON corpus_directory_migration_plans
FOR EACH STATEMENT
EXECUTE FUNCTION reconcile_deleted_public_namespace_conflicts();
CREATE TRIGGER corpus_page_plans_029_reconcile_conflict_delete
AFTER DELETE ON corpus_page_migration_plans
FOR EACH STATEMENT
EXECUTE FUNCTION reconcile_deleted_public_namespace_conflicts();
CREATE TRIGGER corpus_automation_plans_029_reconcile_conflict_delete
AFTER DELETE ON corpus_migration_automation_plans
FOR EACH STATEMENT
EXECUTE FUNCTION reconcile_deleted_public_namespace_conflicts();
CREATE TRIGGER operational_replacements_029_reconcile_conflict_delete
AFTER DELETE ON operational_document_replacements
FOR EACH STATEMENT
EXECUTE FUNCTION reconcile_deleted_public_namespace_conflicts();

REVOKE ALL ON FUNCTION reconcile_deleted_public_namespace_conflicts()
  FROM PUBLIC;
GRANT USAGE,CREATE ON SCHEMA public TO context_use_boundary_owner;
ALTER FUNCTION reconcile_deleted_public_namespace_conflicts()
  OWNER TO context_use_boundary_owner;
REVOKE CREATE ON SCHEMA public FROM context_use_boundary_owner;

CREATE TYPE publication_intent_store AS ENUM ('legacy','pathless');

-- Both artifact relations previously enforced representation-token uniqueness
-- independently. Freeze both writers before auditing and promoting that token
-- to one permanent cross-kind namespace.
LOCK TABLE public_page_artifacts,public_asset_artifacts
  IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public_page_artifacts page
    JOIN public_asset_artifacts asset
      ON asset.representation_token=page.representation_token
  ) THEN
    RAISE EXCEPTION
      'page and asset artifacts contain an ambiguous representation token'
      USING ERRCODE='23505';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public_page_artifacts page
    JOIN public_asset_artifacts asset ON asset.artifact_id=page.artifact_id
  ) THEN
    RAISE EXCEPTION 'page and asset artifacts reuse a permanent artifact UUID'
      USING ERRCODE='23505';
  END IF;
END;
$$;

CREATE TABLE public_representation_token_reservations (
  representation_token text PRIMARY KEY CHECK (
    representation_token ~ '^[a-f0-9]{64}$'
  ),
  artifact_id uuid NOT NULL,
  resource_kind publication_target NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (artifact_id),
  UNIQUE (representation_token,artifact_id,resource_kind)
);

INSERT INTO public_representation_token_reservations(
  representation_token,artifact_id,resource_kind,created_at
)
SELECT representation_token,artifact_id,'page'::publication_target,created_at
FROM public_page_artifacts
UNION ALL
SELECT representation_token,artifact_id,'asset'::publication_target,created_at
FROM public_asset_artifacts;

ALTER TABLE public_page_artifacts
  ADD CONSTRAINT public_page_artifacts_representation_reservation_fk
  FOREIGN KEY (representation_token,artifact_id,resource_kind)
  REFERENCES public_representation_token_reservations(
    representation_token,artifact_id,resource_kind
  ) ON DELETE RESTRICT;
ALTER TABLE public_asset_artifacts
  ADD CONSTRAINT public_asset_artifacts_representation_reservation_fk
  FOREIGN KEY (representation_token,artifact_id,resource_kind)
  REFERENCES public_representation_token_reservations(
    representation_token,artifact_id,resource_kind
  ) ON DELETE RESTRICT;

CREATE FUNCTION reserve_public_representation_token(
  p_representation_token text,
  p_artifact_id uuid,
  p_resource_kind publication_target
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
DECLARE
  reserved record;
BEGIN
  IF p_representation_token IS NULL
     OR p_representation_token !~ '^[a-f0-9]{64}$'
     OR p_artifact_id IS NULL OR p_resource_kind IS NULL THEN
    RAISE EXCEPTION 'complete public representation identity is required'
      USING ERRCODE='22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'public-representation-token:'||p_representation_token,0
  ));
  SELECT artifact_id,resource_kind INTO reserved
  FROM public_representation_token_reservations
  WHERE representation_token=p_representation_token;
  IF FOUND THEN
    IF reserved.artifact_id IS DISTINCT FROM p_artifact_id
       OR reserved.resource_kind IS DISTINCT FROM p_resource_kind THEN
      RAISE EXCEPTION 'public representation token is permanently reserved'
        USING ERRCODE='23505';
    END IF;
    RETURN;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public_representation_token_reservations
    WHERE artifact_id=p_artifact_id
  ) THEN
    RAISE EXCEPTION 'public artifact already has a representation token'
      USING ERRCODE='23505';
  END IF;
  INSERT INTO public_representation_token_reservations(
    representation_token,artifact_id,resource_kind
  ) VALUES (p_representation_token,p_artifact_id,p_resource_kind);
END;
$$;

CREATE FUNCTION guard_public_representation_token_reservation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
BEGIN
  IF TG_OP='DELETE' OR NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'public representation reservations are immutable'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION guard_public_artifact_history()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
BEGIN
  IF TG_OP IN ('UPDATE','DELETE') THEN
    RAISE EXCEPTION 'public artifact history is immutable'
      USING ERRCODE='23514';
  END IF;
  PERFORM reserve_public_representation_token(
    NEW.representation_token,NEW.artifact_id,NEW.resource_kind
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER public_representation_tokens_029_keep_immutable
BEFORE UPDATE OR DELETE ON public_representation_token_reservations
FOR EACH ROW EXECUTE FUNCTION guard_public_representation_token_reservation();
CREATE TRIGGER public_page_artifacts_029_keep_history
BEFORE INSERT OR UPDATE OR DELETE ON public_page_artifacts
FOR EACH ROW EXECUTE FUNCTION guard_public_artifact_history();
CREATE TRIGGER public_asset_artifacts_029_keep_history
BEFORE INSERT OR UPDATE OR DELETE ON public_asset_artifacts
FOR EACH ROW EXECUTE FUNCTION guard_public_artifact_history();

-- Publication challenges reuse intent_kind='publication'. Make the UUID
-- discriminator permanent before a second intent family can be dispatched.
LOCK TABLE publication_intents,pathless_publication_intents
  IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM publication_intents legacy
    JOIN pathless_publication_intents pathless ON pathless.id=legacy.id
  ) THEN
    RAISE EXCEPTION 'legacy and pathless publication intent UUIDs are ambiguous'
      USING ERRCODE='23505';
  END IF;
END;
$$;

CREATE TABLE publication_intent_id_reservations (
  intent_id uuid PRIMARY KEY,
  intent_store publication_intent_store NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (intent_id,intent_store)
);

INSERT INTO publication_intent_id_reservations(intent_id,intent_store,created_at)
SELECT id,'legacy'::publication_intent_store,created_at FROM publication_intents
UNION ALL
SELECT id,'pathless'::publication_intent_store,created_at
FROM pathless_publication_intents;

CREATE FUNCTION reserve_publication_intent_id(
  p_intent_id uuid,
  p_intent_store publication_intent_store
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
DECLARE
  reserved_store publication_intent_store;
  live_same_store boolean;
BEGIN
  IF p_intent_id IS NULL OR p_intent_store IS NULL THEN
    RAISE EXCEPTION 'publication intent identity is required'
      USING ERRCODE='22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'publication-intent-uuid:'||p_intent_id::text,0
  ));
  SELECT intent_store INTO reserved_store
  FROM publication_intent_id_reservations WHERE intent_id=p_intent_id;
  IF FOUND THEN
    IF reserved_store IS DISTINCT FROM p_intent_store THEN
      RAISE EXCEPTION 'publication intent UUID belongs to another intent family'
        USING ERRCODE='23505';
    END IF;
    SELECT CASE p_intent_store
      WHEN 'legacy' THEN EXISTS (
        SELECT 1 FROM publication_intents WHERE id=p_intent_id
      )
      WHEN 'pathless' THEN EXISTS (
        SELECT 1 FROM pathless_publication_intents WHERE id=p_intent_id
      )
    END INTO live_same_store;
    IF NOT live_same_store THEN
      RAISE EXCEPTION 'publication intent UUID cannot be reused'
        USING ERRCODE='23505';
    END IF;
    RETURN;
  END IF;
  INSERT INTO publication_intent_id_reservations(intent_id,intent_store)
  VALUES (p_intent_id,p_intent_store);
END;
$$;

CREATE FUNCTION reserve_publication_intent_id_from_row()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
BEGIN
  PERFORM reserve_publication_intent_id(
    NEW.id,
    CASE TG_TABLE_NAME
      WHEN 'publication_intents' THEN 'legacy'::publication_intent_store
      WHEN 'pathless_publication_intents' THEN 'pathless'::publication_intent_store
      ELSE NULL
    END
  );
  RETURN NEW;
END;
$$;

CREATE FUNCTION guard_publication_intent_id_reservation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
BEGIN
  IF TG_OP='DELETE' OR NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'publication intent UUID reservations are immutable'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER publication_intent_ids_029_keep_immutable
BEFORE UPDATE OR DELETE ON publication_intent_id_reservations
FOR EACH ROW EXECUTE FUNCTION guard_publication_intent_id_reservation();
-- Sort after the legacy operational-document guards so both the legacy writer
-- and checked pathless writer acquire target/document state before this UUID
-- advisory namespace.
CREATE TRIGGER publication_intents_zz029_reserve_uuid
BEFORE INSERT ON publication_intents
FOR EACH ROW EXECUTE FUNCTION reserve_publication_intent_id_from_row();
CREATE TRIGGER pathless_publication_intents_029_reserve_uuid
BEFORE INSERT ON pathless_publication_intents
FOR EACH ROW EXECUTE FUNCTION reserve_publication_intent_id_from_row();

-- A semantic snapshot alone admits ABA (most visibly an asset being unpublished
-- and republished at the same legacy path). Keep a separate, monotonically
-- increasing clock so every intent can compare both value and history.
LOCK TABLE public_resources,knowledge_pages,assets,
  page_publications,asset_publications IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE public_visibility_generations (
  public_id uuid PRIMARY KEY REFERENCES public_resources(public_id)
    ON DELETE RESTRICT,
  generation bigint NOT NULL CHECK (generation>0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public_visibility_generations(public_id,generation,updated_at)
SELECT public_id,1,created_at FROM public_resources;

CREATE FUNCTION initialize_public_visibility_generation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
BEGIN
  INSERT INTO public_visibility_generations(public_id,generation)
  VALUES (NEW.public_id,1)
  ON CONFLICT (public_id) DO NOTHING;
  RETURN NULL;
END;
$$;

CREATE FUNCTION bump_public_visibility_generation(p_public_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
BEGIN
  IF p_public_id IS NULL THEN RETURN; END IF;
  UPDATE public_visibility_generations
  SET generation=generation+1,updated_at=now()
  WHERE public_id=p_public_id AND generation<9223372036854775807;
  IF NOT FOUND THEN
    IF EXISTS (
      SELECT 1 FROM public_visibility_generations WHERE public_id=p_public_id
    ) THEN
      RAISE EXCEPTION 'public visibility generation exhausted'
        USING ERRCODE='22003';
    END IF;
    RAISE EXCEPTION 'public visibility generation is missing'
      USING ERRCODE='23503';
  END IF;
END;
$$;

CREATE FUNCTION bump_legacy_page_public_visibility()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
DECLARE
  mapped_public_id uuid;
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.published_version_id IS NULL AND NEW.public_path IS NULL THEN
      RETURN NULL;
    END IF;
  ELSIF NEW.published_version_id IS NOT DISTINCT FROM OLD.published_version_id
        AND NEW.public_path IS NOT DISTINCT FROM OLD.public_path
        AND NEW.archived_at IS NOT DISTINCT FROM OLD.archived_at THEN
    RETURN NULL;
  END IF;
  SELECT public_id INTO mapped_public_id
  FROM public_resources
  WHERE original_document_id=NEW.id AND resource_kind='page'
  FOR SHARE;
  IF mapped_public_id IS NOT NULL THEN
    PERFORM bump_public_visibility_generation(mapped_public_id);
  END IF;
  RETURN NULL;
END;
$$;

CREATE FUNCTION bump_legacy_asset_public_visibility()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
DECLARE
  mapped_public_id uuid;
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.public_path IS NULL THEN RETURN NULL; END IF;
  ELSIF NEW.public_path IS NOT DISTINCT FROM OLD.public_path
        AND NEW.deleted_at IS NOT DISTINCT FROM OLD.deleted_at THEN
    RETURN NULL;
  END IF;
  SELECT public_id INTO mapped_public_id
  FROM public_resources
  WHERE original_document_id=NEW.id AND resource_kind='asset'
  FOR SHARE;
  IF mapped_public_id IS NOT NULL THEN
    PERFORM bump_public_visibility_generation(mapped_public_id);
  END IF;
  RETURN NULL;
END;
$$;

CREATE FUNCTION bump_pathless_pin_public_visibility()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
BEGIN
  PERFORM bump_public_visibility_generation(
    CASE WHEN TG_OP='DELETE' THEN OLD.public_id ELSE NEW.public_id END
  );
  RETURN NULL;
END;
$$;

CREATE TRIGGER public_resources_029_initialize_visibility_generation
AFTER INSERT ON public_resources
FOR EACH ROW EXECUTE FUNCTION initialize_public_visibility_generation();
-- Same-event triggers run alphabetically. These names deliberately sort after
-- `*_register_public_routes`, which creates a fresh resource on legacy publish.
CREATE TRIGGER knowledge_pages_zz029_bump_public_visibility
AFTER INSERT OR UPDATE OF published_version_id,public_path,archived_at
ON knowledge_pages
FOR EACH ROW EXECUTE FUNCTION bump_legacy_page_public_visibility();
CREATE TRIGGER assets_zz029_bump_public_visibility
AFTER INSERT OR UPDATE OF public_path,deleted_at ON assets
FOR EACH ROW EXECUTE FUNCTION bump_legacy_asset_public_visibility();
CREATE TRIGGER page_publications_029_bump_public_visibility
AFTER INSERT OR UPDATE OR DELETE ON page_publications
FOR EACH ROW EXECUTE FUNCTION bump_pathless_pin_public_visibility();
CREATE TRIGGER asset_publications_029_bump_public_visibility
AFTER INSERT OR UPDATE OR DELETE ON asset_publications
FOR EACH ROW EXECUTE FUNCTION bump_pathless_pin_public_visibility();

CREATE FUNCTION pathless_publication_visibility_state_hash(
  p_target_kind publication_target,
  p_target_document_id uuid,
  p_public_id uuid
) RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
  SELECT encode(digest(convert_to(jsonb_build_object(
    'target_kind',p_target_kind,
    'target_document_id',p_target_document_id,
    'public_id',p_public_id,
    'resource',(
      SELECT jsonb_build_object(
        'public_id',resource.public_id,
        'document_id',resource.document_id,
        'original_document_id',resource.original_document_id,
        'resource_kind',resource.resource_kind
      )
      FROM public_resources resource
      WHERE resource.public_id=p_public_id
    ),
    'legacy_page',CASE WHEN p_target_kind='page' THEN (
      SELECT jsonb_build_object(
        'published_revision_id',page.published_version_id,
        'public_path',page.public_path,
        'archived',page.archived_at IS NOT NULL
      ) FROM knowledge_pages page WHERE page.id=p_target_document_id
    ) END,
    'legacy_asset',CASE WHEN p_target_kind='asset' THEN (
      SELECT jsonb_build_object(
        'public_path',asset.public_path,
        'deleted',asset.deleted_at IS NOT NULL
      ) FROM assets asset WHERE asset.id=p_target_document_id
    ) END,
    'pathless_artifact',CASE
      WHEN p_target_kind='page' THEN (
        SELECT publication.artifact_id
        FROM page_publications publication
        WHERE publication.public_id=p_public_id
      )
      WHEN p_target_kind='asset' THEN (
        SELECT publication.artifact_id
        FROM asset_publications publication
        WHERE publication.public_id=p_public_id
      )
    END
  )::text,'UTF8'),'sha256'),'hex');
$$;

ALTER TABLE pathless_publication_intents
  ADD COLUMN expected_visibility_generation bigint,
  ADD COLUMN expected_visibility_state_hash text;

UPDATE pathless_publication_intents intent
SET expected_visibility_generation=coalesce((
      SELECT generation.generation
      FROM public_resources resource
      JOIN public_visibility_generations generation
        ON generation.public_id=resource.public_id
      WHERE resource.original_document_id=intent.target_document_id
        AND resource.resource_kind=intent.target_kind
    ),0),
    expected_visibility_state_hash=pathless_publication_visibility_state_hash(
      intent.target_kind,
      intent.target_document_id,
      (
        SELECT coalesce(
          (
            SELECT resource.public_id
            FROM public_resources resource
            WHERE resource.original_document_id=intent.target_document_id
              AND resource.resource_kind=intent.target_kind
          ),
          intent.candidate_public_id
        )
      )
    );

ALTER TABLE pathless_publication_intents
  ALTER COLUMN expected_visibility_generation SET NOT NULL,
  ALTER COLUMN expected_visibility_state_hash SET NOT NULL,
  ADD CONSTRAINT pathless_publication_intents_visibility_generation_check
    CHECK (expected_visibility_generation>=0),
  ADD CONSTRAINT pathless_publication_intents_visibility_hash_check
    CHECK (expected_visibility_state_hash ~ '^[a-f0-9]{64}$');

-- First publication deliberately does not allocate a public resource until
-- confirmation. A second permanent clock therefore follows the private target
-- identity itself, catching current-pointer, lifecycle and asset-metadata ABA
-- even while expected_visibility_generation is still zero. It intentionally
-- has no FK: deletion and later UUID reuse advance the same durable identity.
CREATE TABLE publication_target_generations (
  target_kind publication_target NOT NULL,
  target_document_id uuid NOT NULL,
  generation bigint NOT NULL CHECK (generation>0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (target_kind,target_document_id)
);

INSERT INTO publication_target_generations(
  target_kind,target_document_id,generation,updated_at
)
SELECT 'page'::publication_target,id,1,created_at FROM knowledge_pages
UNION ALL
SELECT 'asset'::publication_target,id,1,created_at FROM assets;

CREATE FUNCTION bump_publication_target_generation(
  p_target_kind publication_target,
  p_target_document_id uuid
) RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
DECLARE
  next_generation bigint;
BEGIN
  IF p_target_kind IS NULL OR p_target_document_id IS NULL THEN
    RAISE EXCEPTION 'publication target identity is required'
      USING ERRCODE='22023';
  END IF;
  SELECT generation INTO next_generation
  FROM publication_target_generations
  WHERE target_kind=p_target_kind AND target_document_id=p_target_document_id
  FOR UPDATE;
  IF FOUND THEN
    IF next_generation=9223372036854775807 THEN
      RAISE EXCEPTION 'publication target generation exhausted'
        USING ERRCODE='22003';
    END IF;
    next_generation := next_generation+1;
    UPDATE publication_target_generations
    SET generation=next_generation,updated_at=now()
    WHERE target_kind=p_target_kind AND target_document_id=p_target_document_id;
  ELSE
    next_generation := 1;
    INSERT INTO publication_target_generations(
      target_kind,target_document_id,generation
    ) VALUES (p_target_kind,p_target_document_id,next_generation);
  END IF;
  RETURN next_generation;
END;
$$;

CREATE FUNCTION bump_page_publication_target_generation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    PERFORM bump_publication_target_generation('page',NEW.id);
  ELSIF TG_OP='DELETE' THEN
    PERFORM bump_publication_target_generation('page',OLD.id);
  ELSIF NEW.current_path IS DISTINCT FROM OLD.current_path
        OR NEW.current_version_id IS DISTINCT FROM OLD.current_version_id
        OR NEW.archived_at IS DISTINCT FROM OLD.archived_at THEN
    PERFORM bump_publication_target_generation('page',NEW.id);
  END IF;
  RETURN NULL;
END;
$$;

CREATE FUNCTION bump_asset_publication_target_generation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    PERFORM bump_publication_target_generation('asset',NEW.id);
  ELSIF TG_OP='DELETE' THEN
    PERFORM bump_publication_target_generation('asset',OLD.id);
  ELSIF NEW.current_path IS DISTINCT FROM OLD.current_path
        OR NEW.filename IS DISTINCT FROM OLD.filename
        OR NEW.content_type IS DISTINCT FROM OLD.content_type
        OR NEW.size_bytes IS DISTINCT FROM OLD.size_bytes
        OR NEW.content_hash IS DISTINCT FROM OLD.content_hash
        OR NEW.s3_object_key IS DISTINCT FROM OLD.s3_object_key
        OR NEW.width IS DISTINCT FROM OLD.width
        OR NEW.height IS DISTINCT FROM OLD.height
        OR NEW.duration_seconds IS DISTINCT FROM OLD.duration_seconds
        OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
    PERFORM bump_publication_target_generation('asset',NEW.id);
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER knowledge_pages_zz029_bump_publication_target
AFTER INSERT OR UPDATE OF current_path,current_version_id,archived_at OR DELETE
ON knowledge_pages
FOR EACH ROW EXECUTE FUNCTION bump_page_publication_target_generation();
CREATE TRIGGER assets_zz029_bump_publication_target
AFTER INSERT OR UPDATE OF current_path,filename,content_type,size_bytes,
  content_hash,s3_object_key,width,height,duration_seconds,deleted_at OR DELETE
ON assets
FOR EACH ROW EXECUTE FUNCTION bump_asset_publication_target_generation();

-- The target clock is also the durable post-029 private-identity tombstone.
-- A hard delete must not make that UUID available to the public/artifact/alias
-- namespaces, while recreating the same private identity remains supported and
-- advances the same monotonic generation.
CREATE OR REPLACE FUNCTION public_uuid_has_private_identity(p_uuid uuid)
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
    UNION ALL SELECT 1 FROM publication_target_generations
      WHERE target_document_id=p_uuid
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

ALTER TABLE pathless_publication_intents
  ADD COLUMN expected_target_generation bigint;
UPDATE pathless_publication_intents intent
SET expected_target_generation=coalesce((
  SELECT target.generation
  FROM publication_target_generations target
  WHERE target.target_kind=intent.target_kind
    AND target.target_document_id=intent.target_document_id
),0);
ALTER TABLE pathless_publication_intents
  ALTER COLUMN expected_target_generation SET NOT NULL,
  ADD CONSTRAINT pathless_publication_intents_target_generation_check
    CHECK (expected_target_generation>=0);

-- None of the registries is an application DML surface. Trigger helpers run as
-- the existing non-login boundary owner, while backup can retain the permanent
-- namespace and visibility evidence.
REVOKE ALL ON FUNCTION reserve_public_representation_token(
  text,uuid,publication_target
) FROM PUBLIC;
REVOKE ALL ON FUNCTION guard_public_representation_token_reservation()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION guard_public_artifact_history() FROM PUBLIC;
REVOKE ALL ON FUNCTION reserve_publication_intent_id(
  uuid,publication_intent_store
) FROM PUBLIC;
REVOKE ALL ON FUNCTION reserve_publication_intent_id_from_row() FROM PUBLIC;
REVOKE ALL ON FUNCTION guard_publication_intent_id_reservation() FROM PUBLIC;
REVOKE ALL ON FUNCTION initialize_public_visibility_generation() FROM PUBLIC;
REVOKE ALL ON FUNCTION bump_public_visibility_generation(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION bump_legacy_page_public_visibility() FROM PUBLIC;
REVOKE ALL ON FUNCTION bump_legacy_asset_public_visibility() FROM PUBLIC;
REVOKE ALL ON FUNCTION bump_pathless_pin_public_visibility() FROM PUBLIC;
REVOKE ALL ON FUNCTION pathless_publication_visibility_state_hash(
  publication_target,uuid,uuid
) FROM PUBLIC;
REVOKE ALL ON FUNCTION bump_publication_target_generation(
  publication_target,uuid
) FROM PUBLIC;
REVOKE ALL ON FUNCTION bump_page_publication_target_generation() FROM PUBLIC;
REVOKE ALL ON FUNCTION bump_asset_publication_target_generation() FROM PUBLIC;

GRANT SELECT,INSERT ON public_representation_token_reservations,
  publication_intent_id_reservations TO context_use_boundary_owner;
GRANT SELECT,INSERT,UPDATE ON public_visibility_generations
  TO context_use_boundary_owner;
GRANT SELECT,INSERT,UPDATE ON publication_target_generations
  TO context_use_boundary_owner;
GRANT USAGE,CREATE ON SCHEMA public TO context_use_boundary_owner;
ALTER FUNCTION reserve_public_representation_token(
  text,uuid,publication_target
) OWNER TO context_use_boundary_owner;
ALTER FUNCTION guard_public_representation_token_reservation()
  OWNER TO context_use_boundary_owner;
ALTER FUNCTION guard_public_artifact_history()
  OWNER TO context_use_boundary_owner;
ALTER FUNCTION reserve_publication_intent_id(
  uuid,publication_intent_store
) OWNER TO context_use_boundary_owner;
ALTER FUNCTION reserve_publication_intent_id_from_row()
  OWNER TO context_use_boundary_owner;
ALTER FUNCTION guard_publication_intent_id_reservation()
  OWNER TO context_use_boundary_owner;
ALTER FUNCTION initialize_public_visibility_generation()
  OWNER TO context_use_boundary_owner;
ALTER FUNCTION bump_public_visibility_generation(uuid)
  OWNER TO context_use_boundary_owner;
ALTER FUNCTION bump_legacy_page_public_visibility()
  OWNER TO context_use_boundary_owner;
ALTER FUNCTION bump_legacy_asset_public_visibility()
  OWNER TO context_use_boundary_owner;
ALTER FUNCTION bump_pathless_pin_public_visibility()
  OWNER TO context_use_boundary_owner;
ALTER FUNCTION pathless_publication_visibility_state_hash(
  publication_target,uuid,uuid
) OWNER TO context_use_boundary_owner;
ALTER FUNCTION bump_publication_target_generation(publication_target,uuid)
  OWNER TO context_use_boundary_owner;
ALTER FUNCTION bump_page_publication_target_generation()
  OWNER TO context_use_boundary_owner;
ALTER FUNCTION bump_asset_publication_target_generation()
  OWNER TO context_use_boundary_owner;
REVOKE CREATE ON SCHEMA public FROM context_use_boundary_owner;

GRANT SELECT ON public_representation_token_reservations,
  publication_intent_id_reservations,public_visibility_generations,
  publication_target_generations
  TO context_use_backup;

-- Bind every publish intent to the exact private source tuple. Visibility
-- clocks protect publication decisions; this fingerprint independently
-- protects the bytes, metadata and generic-link receipt being projected.
CREATE FUNCTION pathless_publication_source_fingerprint(
  p_target_kind publication_target,
  p_target_document_id uuid,
  p_expected_revision_id uuid
) RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path=pg_catalog,public
SET TimeZone='UTC'
AS $$
DECLARE
  source_snapshot jsonb;
BEGIN
  IF p_target_kind='page' THEN
    SELECT jsonb_build_object(
      'target_kind','page',
      'document_id',page.id,
      'document_authority',document.authority,
      'document_representation',document.representation,
      'current_revision_id',page.current_version_id,
      'archived_at',page.archived_at,
      'revision_id',revision.id,
      'revision_number',revision.revision_number,
      'source_body_object_key',revision.body_object_key,
      'source_body_size_bytes',revision.body_size_bytes,
      'source_body_content_hash',revision.body_content_hash,
      'path',version.path,
      'title',version.title,
      'summary',version.summary,
      'last_edited_at',version.created_at,
      'link_contract',contract.link_contract,
      'contract_provenance',contract.provenance,
      'contract_body_content_hash',contract.body_content_hash,
      'target_document_ids',contract.target_document_ids
    ) INTO source_snapshot
    FROM knowledge_pages page
    JOIN hypermedia_documents document ON document.id=page.id
    JOIN hypermedia_document_revisions revision
      ON revision.id=p_expected_revision_id AND revision.document_id=page.id
    JOIN knowledge_page_versions version
      ON version.id=revision.id AND version.page_id=page.id
    JOIN knowledge_revision_contracts contract
      ON contract.revision_id=revision.id AND contract.document_id=page.id
    WHERE page.id=p_target_document_id;
  ELSIF p_target_kind='asset' THEN
    IF p_expected_revision_id IS NOT NULL THEN RETURN NULL; END IF;
    SELECT jsonb_build_object(
      'target_kind','asset',
      'document_id',asset.id,
      'current_path',asset.current_path,
      'filename',asset.filename,
      'content_type',asset.content_type,
      'size_bytes',asset.size_bytes,
      'content_hash',asset.content_hash,
      'source_body_object_key',asset.s3_object_key,
      'width',asset.width,
      'height',asset.height,
      'duration_seconds',asset.duration_seconds,
      'created_at',asset.created_at,
      'deleted_at',asset.deleted_at
    ) INTO source_snapshot
    FROM assets asset WHERE asset.id=p_target_document_id;
  END IF;
  IF source_snapshot IS NULL THEN RETURN NULL; END IF;
  RETURN encode(digest(convert_to(source_snapshot::text,'UTF8'),'sha256'),'hex');
END;
$$;

ALTER TABLE pathless_publication_intents
  ADD COLUMN expected_source_fingerprint text;
UPDATE pathless_publication_intents intent
SET expected_source_fingerprint=pathless_publication_source_fingerprint(
  intent.target_kind,intent.target_document_id,intent.expected_revision_id
)
WHERE intent.action='publish';
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pathless_publication_intents
    WHERE action='publish' AND expected_source_fingerprint IS NULL
  ) THEN
    RAISE EXCEPTION 'existing pathless publish intent has no exact source tuple'
      USING ERRCODE='23514';
  END IF;
END;
$$;
ALTER TABLE pathless_publication_intents
  ADD CONSTRAINT pathless_publication_intents_source_fingerprint_check CHECK (
    (action='publish' AND expected_source_fingerprint IS NOT NULL
      AND expected_source_fingerprint ~ '^[a-f0-9]{64}$')
    OR (action='unpublish' AND expected_source_fingerprint IS NULL)
  );

CREATE FUNCTION canonical_public_uuid_set(p_values uuid[])
RETURNS uuid[]
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SET search_path=pg_catalog
AS $$
DECLARE
  canonical uuid[];
BEGIN
  IF p_values IS NULL OR cardinality(p_values)>100000
     OR array_position(p_values,NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'public UUID receipt is invalid' USING ERRCODE='22023';
  END IF;
  SELECT coalesce(array_agg(value ORDER BY value),'{}'::uuid[])
  INTO canonical
  FROM (SELECT DISTINCT unnest(p_values) AS value) values;
  RETURN canonical;
END;
$$;

CREATE FUNCTION pathless_publication_projection_plan(
  p_target_document_id uuid,
  p_expected_revision_id uuid,
  p_candidate_public_id uuid
) RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
  WITH contract_targets AS (
    SELECT DISTINCT target_document_id
    FROM knowledge_revision_contracts contract,
      unnest(contract.target_document_ids) target_document_id
    WHERE contract.revision_id=p_expected_revision_id
      AND contract.document_id=p_target_document_id
  ), described AS (
    SELECT target.target_document_id,resource.public_id AS mapped_public_id,
      resource.resource_kind AS mapped_resource_kind,
      CASE
        WHEN target.target_document_id=p_target_document_id THEN 'self'
        WHEN EXISTS (
          SELECT 1 FROM blocking_public_namespace_conflicts conflict
          WHERE conflict.namespace_uuid=target.target_document_id
             OR conflict.namespace_uuid=resource.public_id
        ) THEN 'namespace_conflict'
        WHEN resource.public_id IS NOT NULL
         AND resource.document_id=target.target_document_id
         AND (
           (resource.resource_kind='page' AND EXISTS (
             SELECT 1 FROM page_publications publication
             WHERE publication.public_id=resource.public_id
           ))
           OR (resource.resource_kind='asset' AND EXISTS (
             SELECT 1 FROM asset_publications publication
             WHERE publication.public_id=resource.public_id
           ))
         ) THEN 'active_public'
        WHEN resource.public_id IS NOT NULL THEN 'inactive_public'
        WHEN EXISTS (
          SELECT 1 FROM knowledge_pages page
          WHERE page.id=target.target_document_id
          UNION ALL
          SELECT 1 FROM assets asset WHERE asset.id=target.target_document_id
        ) THEN 'private'
        ELSE 'dangling'
      END AS outcome
    FROM contract_targets target
    LEFT JOIN LATERAL (
      SELECT public_id,document_id,resource_kind
      FROM public_resources
      WHERE original_document_id=target.target_document_id
      LIMIT 1
    ) resource ON true
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'target_document_id',target_document_id,
    'outcome',outcome,
    'public_id',CASE
      WHEN outcome='self' THEN p_candidate_public_id
      WHEN outcome='active_public' THEN mapped_public_id
      ELSE NULL
    END,
    'public_target_kind',CASE
      WHEN outcome='self' THEN 'page'
      WHEN outcome='active_public' THEN mapped_resource_kind::text
      ELSE NULL
    END
  ) ORDER BY target_document_id),'[]'::jsonb)
  FROM described;
$$;

CREATE FUNCTION pathless_publication_projected_target_ids(
  p_target_document_id uuid,
  p_expected_revision_id uuid,
  p_candidate_public_id uuid
) RETURNS uuid[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
  SELECT canonical_public_uuid_set(coalesce(array_agg(
    (entry->>'public_id')::uuid
  ),'{}'::uuid[]))
  FROM jsonb_array_elements(pathless_publication_projection_plan(
    p_target_document_id,p_expected_revision_id,p_candidate_public_id
  )) entry
  WHERE entry->>'public_id' IS NOT NULL;
$$;

CREATE FUNCTION pathless_publication_projection_has_namespace_conflict(
  p_target_document_id uuid,
  p_expected_revision_id uuid,
  p_candidate_public_id uuid
) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(pathless_publication_projection_plan(
      p_target_document_id,p_expected_revision_id,p_candidate_public_id
    )) entry
    WHERE entry->>'outcome'='namespace_conflict'
  );
$$;

CREATE FUNCTION pathless_publication_projection_receipt_hash(
  p_target_document_id uuid,
  p_expected_revision_id uuid,
  p_candidate_public_id uuid,
  p_source_fingerprint text
) RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
  SELECT encode(digest(convert_to(jsonb_build_object(
    'source_fingerprint',p_source_fingerprint,
    'target_document_id',p_target_document_id,
    'expected_revision_id',p_expected_revision_id,
    'candidate_public_id',p_candidate_public_id,
    'projection_plan',pathless_publication_projection_plan(
      p_target_document_id,p_expected_revision_id,p_candidate_public_id
    )
  )::text,'UTF8'),'sha256'),'hex')
$$;

-- Representation tokens become permanent when storage attests the exact
-- staged object, even if the owner later cancels. Existing dormant staging is
-- upgraded without changing any already-materialized artifact token.
ALTER TABLE pathless_publication_artifact_staging
  ADD COLUMN representation_token text;
UPDATE pathless_publication_artifact_staging staging
SET representation_token=coalesce(
  (
    SELECT artifact.representation_token
    FROM public_page_artifacts artifact
    WHERE artifact.source_intent_id=staging.intent_id
    UNION ALL
    SELECT artifact.representation_token
    FROM public_asset_artifacts artifact
    WHERE artifact.source_intent_id=staging.intent_id
    LIMIT 1
  ),
  encode(gen_random_bytes(32),'hex')
);
SELECT reserve_public_representation_token(
  staging.representation_token,staging.artifact_id,staging.target_kind
)
FROM pathless_publication_artifact_staging staging;
ALTER TABLE pathless_publication_artifact_staging
  ALTER COLUMN representation_token SET NOT NULL,
  ADD CONSTRAINT pathless_publication_staging_representation_token_check
    CHECK (representation_token ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT pathless_publication_staging_representation_token_unique
    UNIQUE (representation_token),
  ADD CONSTRAINT pathless_publication_staging_representation_reservation_fk
    FOREIGN KEY (representation_token,artifact_id,target_kind)
    REFERENCES public_representation_token_reservations(
      representation_token,artifact_id,resource_kind
    ) ON DELETE RESTRICT;

CREATE FUNCTION guard_pathless_publication_intent_history()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'pathless publication intent history is permanent'
      USING ERRCODE='23514';
  END IF;
  IF (to_jsonb(NEW)-'confirmed_at'-'cancelled_at')
       IS DISTINCT FROM (to_jsonb(OLD)-'confirmed_at'-'cancelled_at')
     OR (OLD.confirmed_at IS NOT NULL
       AND NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at)
     OR (OLD.cancelled_at IS NOT NULL
       AND NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at)
     OR (OLD.confirmed_at IS NULL AND NEW.confirmed_at IS NOT NULL
       AND OLD.cancelled_at IS NULL AND NEW.cancelled_at IS NOT NULL) THEN
    RAISE EXCEPTION 'pathless publication intent evidence is immutable'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION guard_pathless_publication_staging_history()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
BEGIN
  IF TG_OP IN ('UPDATE','DELETE') THEN
    RAISE EXCEPTION 'pathless publication staging is immutable'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER pathless_publication_intents_zz029_keep_history
BEFORE UPDATE OR DELETE ON pathless_publication_intents
FOR EACH ROW EXECUTE FUNCTION guard_pathless_publication_intent_history();
CREATE TRIGGER pathless_publication_staging_029_keep_history
BEFORE UPDATE OR DELETE ON pathless_publication_artifact_staging
FOR EACH ROW EXECUTE FUNCTION guard_pathless_publication_staging_history();

CREATE FUNCTION pathless_public_metadata_is_safe(p_value text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path=pg_catalog
RETURN p_value IS NOT NULL
  AND p_value=trim(p_value)
  AND p_value !~ '[[:cntrl:]]'
  AND p_value !~* '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
  AND p_value !~* '(context-use:|/app/|/api/|[[][[])';

CREATE FUNCTION pathless_public_duration_is_safe(p_value numeric)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path=pg_catalog
RETURN CASE
  WHEN p_value IS NULL THEN true
  ELSE length(p_value::text)<=1024
    AND p_value::text ~ '^(0|[1-9][0-9]*)([.][0-9]+)?$'
END;

CREATE FUNCTION assert_pathless_public_metadata_safe(
  p_target_kind publication_target,
  p_title text,
  p_summary text,
  p_filename text
) RETURNS void
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SET search_path=pg_catalog,public
AS $$
BEGIN
  IF p_target_kind='page' THEN
    IF NOT pathless_public_metadata_is_safe(p_title)
       OR NOT pathless_public_metadata_is_safe(p_summary)
       OR p_filename IS NOT NULL THEN
      RAISE EXCEPTION 'page public metadata contains a private reference marker'
        USING ERRCODE='22023';
    END IF;
  ELSIF p_target_kind='asset' THEN
    IF p_title IS NOT NULL OR p_summary IS NOT NULL
       OR NOT pathless_public_metadata_is_safe(p_filename)
       OR p_filename IN ('.','..')
       OR position('/' IN p_filename)>0
       OR position(chr(92) IN p_filename)>0 THEN
      RAISE EXCEPTION 'asset public metadata contains a private reference marker'
        USING ERRCODE='22023';
    END IF;
  ELSE
    RAISE EXCEPTION 'publication target kind is invalid' USING ERRCODE='22023';
  END IF;
END;
$$;

CREATE FUNCTION pathless_publication_target_is_operational(p_document_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM knowledge_settings
    WHERE singleton AND global_guide_document_id=p_document_id
    UNION ALL
    SELECT 1 FROM automation_registry
    WHERE instructions_document_id=p_document_id OR state_document_id=p_document_id
    UNION ALL
    SELECT 1
    FROM corpus_migration_automation_plans plan
    JOIN corpus_migration_runs run ON run.id=plan.run_id
    WHERE run.phase IN ('applying','ready') AND (
      plan.instructions_document_id=p_document_id
      OR plan.state_document_id=p_document_id
    )
    UNION ALL
    SELECT 1 FROM operational_document_replacements replacement
    WHERE replacement.phase='planned' AND (
      replacement.replacement_document_id=p_document_id
      OR replacement.state_replacement_document_id=p_document_id
      OR replacement.state_source_document_id=p_document_id
      OR replacement.source_document_id=p_document_id
    )
    UNION ALL
    SELECT 1 FROM directory_hub_migrations WHERE document_id=p_document_id
  );
$$;

CREATE FUNCTION lock_pathless_publication_context(
  p_target_kind publication_target,
  p_target_document_id uuid,
  p_expected_revision_id uuid
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
DECLARE
  document_ids uuid[];
  document_id uuid;
BEGIN
  IF p_target_kind IS NULL OR p_target_document_id IS NULL THEN
    RAISE EXCEPTION 'publication target is required' USING ERRCODE='22023';
  END IF;
  SELECT coalesce(array_agg(id ORDER BY id),'{}'::uuid[])
  INTO document_ids
  FROM (
    SELECT p_target_document_id AS id
    UNION
    SELECT unnest(contract.target_document_ids)
    FROM knowledge_revision_contracts contract
    WHERE p_target_kind='page'
      AND contract.revision_id=p_expected_revision_id
      AND contract.document_id=p_target_document_id
  ) identities;

  -- Canonical advisory acquisition prevents two cross-linking page
  -- publications from taking their source rows in opposite orders.
  FOREACH document_id IN ARRAY document_ids LOOP
    PERFORM lock_operational_document(document_id);
  END LOOP;

  IF p_target_kind='page' THEN
    PERFORM 1 FROM knowledge_pages
    WHERE id=p_target_document_id FOR UPDATE;
  ELSE
    PERFORM 1 FROM assets WHERE id=p_target_document_id FOR UPDATE;
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'publication target not found' USING ERRCODE='P0002';
  END IF;

  PERFORM page.id
  FROM knowledge_pages page
  WHERE page.id=ANY(document_ids) AND page.id<>p_target_document_id
  ORDER BY page.id
  FOR SHARE;
  PERFORM asset.id
  FROM assets asset
  WHERE asset.id=ANY(document_ids) AND asset.id<>p_target_document_id
  ORDER BY asset.id
  FOR SHARE;

  -- Match legacy trigger order after the target row: resource, visibility
  -- generation and pin before the private-target generation.
  PERFORM resource.public_id
  FROM public_resources resource
  WHERE resource.original_document_id=ANY(document_ids)
  ORDER BY resource.original_document_id,resource.public_id
  FOR UPDATE;
  PERFORM generation.public_id
  FROM public_visibility_generations generation
  JOIN public_resources resource ON resource.public_id=generation.public_id
  WHERE resource.original_document_id=ANY(document_ids)
  ORDER BY generation.public_id
  FOR UPDATE OF generation;
  PERFORM publication.public_id
  FROM page_publications publication
  JOIN public_resources resource ON resource.public_id=publication.public_id
  WHERE resource.original_document_id=ANY(document_ids)
  ORDER BY publication.public_id
  FOR SHARE OF publication;
  PERFORM publication.public_id
  FROM asset_publications publication
  JOIN public_resources resource ON resource.public_id=publication.public_id
  WHERE resource.original_document_id=ANY(document_ids)
  ORDER BY publication.public_id
  FOR SHARE OF publication;
  PERFORM generation.target_document_id
  FROM publication_target_generations generation
  WHERE generation.target_document_id=ANY(document_ids)
  ORDER BY generation.target_kind,generation.target_document_id
  FOR UPDATE;
END;
$$;

CREATE FUNCTION pathless_publication_representation_token(p_frozen_tuple jsonb)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SET search_path=pg_catalog,public
AS $$
BEGIN
  IF p_frozen_tuple IS NULL OR jsonb_typeof(p_frozen_tuple)<>'object' THEN
    RAISE EXCEPTION 'complete frozen public representation is required'
      USING ERRCODE='22023';
  END IF;
  RETURN encode(digest(convert_to(p_frozen_tuple::text,'UTF8'),'sha256'),'hex');
END;
$$;

-- Confirmation never trusts that a row predating this checked API was staged
-- by the storage boundary. Rebuild the complete frozen tuple from the locked
-- intent/current source and require every immutable receipt field, including
-- the DB-derived representation token, to match exactly.
CREATE FUNCTION assert_pathless_publication_staging_exact(p_intent_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
SET jit=off
SET TimeZone='UTC'
AS $$
DECLARE
  intent pathless_publication_intents%ROWTYPE;
  staging pathless_publication_artifact_staging%ROWTYPE;
  source_title text;
  source_summary text;
  source_last_edited_at timestamptz;
  source_filename text;
  source_content_type text;
  source_body_size_bytes bigint;
  source_body_content_hash text;
  source_width integer;
  source_height integer;
  source_duration_seconds numeric;
  expected_token text;
BEGIN
  SELECT * INTO intent
  FROM pathless_publication_intents stored WHERE stored.id=p_intent_id;
  SELECT * INTO staging
  FROM pathless_publication_artifact_staging stored
  WHERE stored.intent_id=p_intent_id;
  IF intent.id IS NULL OR intent.action<>'publish' OR staging.intent_id IS NULL THEN
    RAISE EXCEPTION 'pathless publication artifact is not staged'
      USING ERRCODE='55000';
  END IF;

  IF intent.target_kind='page' THEN
    SELECT version.title,version.summary,version.created_at,
      revision.body_size_bytes::bigint,revision.body_content_hash
    INTO source_title,source_summary,source_last_edited_at,
      source_body_size_bytes,source_body_content_hash
    FROM hypermedia_document_revisions revision
    JOIN knowledge_page_versions version
      ON version.id=revision.id AND version.page_id=revision.document_id
    WHERE revision.id=intent.expected_revision_id
      AND revision.document_id=intent.target_document_id;
  ELSE
    SELECT asset.filename,asset.content_type,asset.size_bytes,
      asset.content_hash,asset.width,asset.height,asset.duration_seconds
    INTO source_filename,source_content_type,source_body_size_bytes,
      source_body_content_hash,source_width,source_height,
      source_duration_seconds
    FROM assets asset WHERE asset.id=intent.target_document_id;
  END IF;

  expected_token := pathless_publication_representation_token(
    jsonb_build_object(
      'target_kind',intent.target_kind,
      'candidate_public_id',intent.candidate_public_id,
      'artifact_id',intent.candidate_artifact_id,
      'source_fingerprint',intent.expected_source_fingerprint,
      'body_object_key',intent.candidate_object_key,
      'body_size_bytes',staging.body_size_bytes,
      'body_content_hash',staging.body_content_hash,
      'public_title',source_title,
      'public_summary',source_summary,
      'public_last_edited_at',source_last_edited_at,
      'public_filename',source_filename,
      'public_content_type',source_content_type,
      'public_width',source_width,
      'public_height',source_height,
      'public_duration_seconds',source_duration_seconds,
      'projected_target_public_ids',intent.projected_target_public_ids,
      'observed_public_uuid_tokens',intent.projected_target_public_ids,
      'projection_receipt_hash',intent.projection_receipt_hash
    )
  );

  IF staging.target_kind IS DISTINCT FROM intent.target_kind
     OR staging.candidate_public_id IS DISTINCT FROM intent.candidate_public_id
     OR staging.artifact_id IS DISTINCT FROM intent.candidate_artifact_id
     OR staging.body_object_key IS DISTINCT FROM intent.candidate_object_key
     OR staging.projected_target_public_ids IS DISTINCT FROM
       intent.projected_target_public_ids
     OR staging.observed_public_uuid_tokens IS DISTINCT FROM
       intent.projected_target_public_ids
     OR staging.projection_receipt_hash IS DISTINCT FROM
       intent.projection_receipt_hash
     OR staging.allocation_kind<>'pathless_intent'
     OR staging.allocation_id IS DISTINCT FROM intent.id
     OR staging.representation_token IS DISTINCT FROM expected_token
     OR NOT EXISTS (
       SELECT 1 FROM public_representation_token_reservations reservation
       WHERE reservation.representation_token=staging.representation_token
         AND reservation.artifact_id=staging.artifact_id
         AND reservation.resource_kind=staging.target_kind
     ) THEN
    RAISE EXCEPTION 'pathless publication staging evidence is not exact'
      USING ERRCODE='23514';
  END IF;

  IF intent.target_kind='page' THEN
    IF staging.body_size_bytes>4000000
       OR staging.public_title IS DISTINCT FROM source_title
       OR staging.public_summary IS DISTINCT FROM source_summary
       OR staging.public_last_edited_at IS DISTINCT FROM source_last_edited_at
       OR staging.public_filename IS NOT NULL
       OR staging.public_content_type IS NOT NULL
       OR staging.public_width IS NOT NULL
       OR staging.public_height IS NOT NULL
       OR staging.public_duration_seconds IS NOT NULL THEN
      RAISE EXCEPTION 'pathless page staging evidence is not exact'
        USING ERRCODE='23514';
    END IF;
  ELSE
    IF staging.body_size_bytes IS DISTINCT FROM source_body_size_bytes
       OR staging.body_content_hash IS DISTINCT FROM source_body_content_hash
       OR staging.public_title IS NOT NULL OR staging.public_summary IS NOT NULL
       OR staging.public_last_edited_at IS NOT NULL
       OR staging.public_filename IS DISTINCT FROM source_filename
       OR staging.public_content_type IS DISTINCT FROM source_content_type
       OR staging.public_width IS DISTINCT FROM source_width
       OR staging.public_height IS DISTINCT FROM source_height
       OR staging.public_duration_seconds::text IS DISTINCT FROM
         source_duration_seconds::text THEN
      RAISE EXCEPTION 'pathless asset staging evidence is not exact'
        USING ERRCODE='23514';
    END IF;
  END IF;
END;
$$;

CREATE FUNCTION assert_pathless_publication_intent_current(
  p_intent_id uuid,
  p_require_staging boolean DEFAULT false
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
SET jit=off
AS $$
DECLARE
  intent pathless_publication_intents%ROWTYPE;
  mapped_public_id uuid;
  mapped_document_id uuid;
  current_visibility_generation bigint;
  current_target_generation bigint;
  current_source_fingerprint text;
  current_projected_ids uuid[];
  current_projection_receipt text;
  current_public_title text;
  current_public_summary text;
  current_public_filename text;
  current_public_content_type text;
  current_asset_size_bytes bigint;
  current_public_duration_seconds numeric;
BEGIN
  SELECT * INTO intent
  FROM pathless_publication_intents
  WHERE id=p_intent_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'pathless publication intent not found' USING ERRCODE='P0002';
  END IF;
  IF intent.confirmed_at IS NOT NULL OR intent.cancelled_at IS NOT NULL
     OR intent.expires_at<=now() THEN
    RAISE EXCEPTION 'pathless publication intent is inactive'
      USING ERRCODE='22023';
  END IF;

  SELECT generation INTO current_target_generation
  FROM publication_target_generations
  WHERE target_kind=intent.target_kind
    AND target_document_id=intent.target_document_id;
  IF current_target_generation IS DISTINCT FROM intent.expected_target_generation THEN
    RAISE EXCEPTION 'pathless publication target changed after intent creation'
      USING ERRCODE='40001';
  END IF;

  SELECT public_id,document_id INTO mapped_public_id,mapped_document_id
  FROM public_resources
  WHERE original_document_id=intent.target_document_id
    AND resource_kind=intent.target_kind;
  IF mapped_public_id IS NOT NULL
     AND mapped_document_id IS DISTINCT FROM intent.target_document_id THEN
    RAISE EXCEPTION 'pathless publication resource mapping is detached'
      USING ERRCODE='23514';
  END IF;
  IF mapped_public_id IS NOT NULL THEN
    SELECT generation INTO current_visibility_generation
    FROM public_visibility_generations WHERE public_id=mapped_public_id;
  ELSE
    current_visibility_generation := 0;
  END IF;
  IF current_visibility_generation IS DISTINCT FROM intent.expected_visibility_generation
     OR (intent.expected_visibility_generation=0 AND mapped_public_id IS NOT NULL)
     OR (intent.action='publish' AND mapped_public_id IS NOT NULL
       AND mapped_public_id IS DISTINCT FROM intent.candidate_public_id) THEN
    RAISE EXCEPTION 'pathless publication visibility changed after intent creation'
      USING ERRCODE='40001';
  END IF;
  IF pathless_publication_visibility_state_hash(
       intent.target_kind,intent.target_document_id,
       coalesce(mapped_public_id,intent.candidate_public_id)
     ) IS DISTINCT FROM intent.expected_visibility_state_hash THEN
    RAISE EXCEPTION 'pathless publication state changed after intent creation'
      USING ERRCODE='40001';
  END IF;

  IF intent.target_kind='page' THEN
    IF NOT EXISTS (
      SELECT 1
      FROM knowledge_pages page
      JOIN hypermedia_documents document ON document.id=page.id
      WHERE page.id=intent.target_document_id
        AND page.archived_at IS NULL
        AND document.authority='knowledge'
        AND document.representation='markdown'
        AND (intent.action='unpublish'
          OR page.current_version_id=intent.expected_revision_id)
    ) THEN
      RAISE EXCEPTION 'pathless publication page is no longer current and active'
        USING ERRCODE='40001';
    END IF;
    IF intent.action='publish' THEN
      IF pathless_publication_target_is_operational(intent.target_document_id) THEN
        RAISE EXCEPTION 'operational control documents cannot be published'
          USING ERRCODE='23514';
      END IF;
      SELECT title,summary INTO current_public_title,current_public_summary
      FROM knowledge_page_versions
      WHERE id=intent.expected_revision_id
        AND page_id=intent.target_document_id;
      PERFORM assert_pathless_public_metadata_safe(
        'page',current_public_title,current_public_summary,NULL
      );
      current_source_fingerprint := pathless_publication_source_fingerprint(
        'page',intent.target_document_id,intent.expected_revision_id
      );
      current_projected_ids := pathless_publication_projected_target_ids(
        intent.target_document_id,intent.expected_revision_id,
        intent.candidate_public_id
      );
      current_projection_receipt := pathless_publication_projection_receipt_hash(
        intent.target_document_id,intent.expected_revision_id,
        intent.candidate_public_id,current_source_fingerprint
      );
      IF current_source_fingerprint IS DISTINCT FROM intent.expected_source_fingerprint
         OR current_projected_ids IS DISTINCT FROM intent.projected_target_public_ids
         OR current_projection_receipt IS DISTINCT FROM intent.projection_receipt_hash
         OR pathless_publication_projection_has_namespace_conflict(
           intent.target_document_id,intent.expected_revision_id,
           intent.candidate_public_id
         ) THEN
        RAISE EXCEPTION 'pathless publication source projection changed'
          USING ERRCODE='40001';
      END IF;
    END IF;
  ELSE
    IF NOT EXISTS (
      SELECT 1 FROM assets
      WHERE id=intent.target_document_id AND deleted_at IS NULL
    ) THEN
      RAISE EXCEPTION 'pathless publication asset is no longer active'
        USING ERRCODE='40001';
    END IF;
    IF intent.action='publish' THEN
      SELECT filename,content_type,size_bytes,duration_seconds
      INTO current_public_filename,current_public_content_type,
        current_asset_size_bytes,current_public_duration_seconds
      FROM assets WHERE id=intent.target_document_id;
      PERFORM assert_pathless_public_metadata_safe(
        'asset',NULL,NULL,current_public_filename
      );
      IF NOT pathless_public_metadata_is_safe(current_public_content_type)
         OR length(current_public_content_type)>255
         OR current_asset_size_bytes>5000000000
         OR NOT pathless_public_duration_is_safe(
           current_public_duration_seconds
         ) THEN
        RAISE EXCEPTION 'asset public metadata is not safely representable'
          USING ERRCODE='22023';
      END IF;
      current_source_fingerprint := pathless_publication_source_fingerprint(
        'asset',intent.target_document_id,NULL
      );
      IF current_source_fingerprint IS DISTINCT FROM intent.expected_source_fingerprint THEN
        RAISE EXCEPTION 'pathless publication asset source changed'
          USING ERRCODE='40001';
      END IF;
    END IF;
  END IF;

  IF intent.action='publish' AND EXISTS (
    SELECT 1 FROM blocking_public_namespace_conflicts conflict
    WHERE conflict.namespace_uuid=intent.target_document_id
       OR conflict.namespace_uuid=intent.expected_revision_id
       OR conflict.namespace_uuid=coalesce(
         mapped_public_id,intent.candidate_public_id
       )
       OR conflict.namespace_uuid=ANY(intent.projected_target_public_ids)
  ) THEN
    RAISE EXCEPTION 'pathless publication has an unresolved namespace conflict'
      USING ERRCODE='23505';
  END IF;

  IF p_require_staging AND intent.action='publish' THEN
    PERFORM assert_pathless_publication_staging_exact(intent.id);
  END IF;
END;
$$;

CREATE FUNCTION begin_pathless_publication_intent(
  p_intent_id uuid,
  p_action publication_action,
  p_target_kind publication_target,
  p_target_document_id uuid,
  p_expected_revision_id uuid,
  p_owner_user_id text,
  p_session_id text
) RETURNS TABLE (
  id uuid,
  action publication_action,
  target_kind publication_target,
  target_document_id uuid,
  expected_revision_id uuid,
  candidate_public_id uuid,
  expires_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
SET jit=off
AS $$
DECLARE
  stored pathless_publication_intents%ROWTYPE;
  mapped_public_id uuid;
  mapped_document_id uuid;
  allocated_public_id uuid;
  allocated_artifact_id uuid;
  allocated_object_key text;
  source_fingerprint text;
  projected_ids uuid[] := '{}'::uuid[];
  projection_receipt text;
  visibility_generation bigint := 0;
  visibility_hash text;
  target_generation bigint;
  page_title text;
  page_summary text;
  asset_filename text;
  asset_content_type text;
  asset_size_bytes bigint;
  asset_duration_seconds numeric;
  attempt integer;
BEGIN
  IF p_intent_id IS NULL OR p_action IS NULL OR p_target_kind IS NULL
     OR p_target_document_id IS NULL
     OR p_owner_user_id IS DISTINCT FROM 'context-use-owner'
     OR p_session_id IS NULL OR length(p_session_id) NOT BETWEEN 1 AND 512
     OR (p_action='publish' AND p_target_kind='page'
       AND p_expected_revision_id IS NULL)
     OR (p_target_kind='asset' AND p_expected_revision_id IS NOT NULL)
     OR (p_action='unpublish' AND p_expected_revision_id IS NOT NULL) THEN
    RAISE EXCEPTION 'valid pathless publication intent input is required'
      USING ERRCODE='22023';
  END IF;

  PERFORM pg_advisory_xact_lock_shared(
    hashtextextended('filesystem-hypermedia-corpus-transition',0)
  );
  -- A lost-response retry returns the immutable original plan even if its
  -- source has since changed. Only a genuinely new UUID enters target locks
  -- and allocation; confirmation still rejects an expired/stale plan.
  SELECT * INTO stored
  FROM pathless_publication_intents intent
  WHERE intent.id=p_intent_id
  FOR UPDATE;
  IF FOUND THEN
    IF stored.action IS DISTINCT FROM p_action
       OR stored.target_kind IS DISTINCT FROM p_target_kind
       OR stored.target_document_id IS DISTINCT FROM p_target_document_id
       OR stored.expected_revision_id IS DISTINCT FROM p_expected_revision_id
       OR stored.owner_user_id IS DISTINCT FROM p_owner_user_id
       OR stored.session_id IS DISTINCT FROM p_session_id THEN
      RAISE EXCEPTION 'pathless publication intent retry does not match'
        USING ERRCODE='23505';
    END IF;
    RETURN QUERY SELECT stored.id,stored.action,stored.target_kind,
      stored.target_document_id,stored.expected_revision_id,
      stored.candidate_public_id,stored.expires_at;
    RETURN;
  END IF;

  PERFORM lock_pathless_publication_context(
    p_target_kind,p_target_document_id,p_expected_revision_id
  );
  -- Serialize the cross-family UUID only after target locks, matching the
  -- rolling legacy trigger order. Recheck after the wait so concurrent exact
  -- retries share one allocation instead of leaving an orphan reservation.
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'publication-intent-uuid:'||p_intent_id::text,0
  ));
  SELECT * INTO stored
  FROM pathless_publication_intents intent
  WHERE intent.id=p_intent_id
  FOR UPDATE;
  IF FOUND THEN
    IF stored.action IS DISTINCT FROM p_action
       OR stored.target_kind IS DISTINCT FROM p_target_kind
       OR stored.target_document_id IS DISTINCT FROM p_target_document_id
       OR stored.expected_revision_id IS DISTINCT FROM p_expected_revision_id
       OR stored.owner_user_id IS DISTINCT FROM p_owner_user_id
       OR stored.session_id IS DISTINCT FROM p_session_id THEN
      RAISE EXCEPTION 'pathless publication intent retry does not match'
        USING ERRCODE='23505';
    END IF;
    RETURN QUERY SELECT stored.id,stored.action,stored.target_kind,
      stored.target_document_id,stored.expected_revision_id,
      stored.candidate_public_id,stored.expires_at;
    RETURN;
  END IF;
  IF EXISTS (
    SELECT 1 FROM publication_intent_id_reservations
    WHERE intent_id=p_intent_id
  ) THEN
    RAISE EXCEPTION 'publication intent UUID cannot be reused'
      USING ERRCODE='23505';
  END IF;

  SELECT generation INTO target_generation
  FROM publication_target_generations generation
  WHERE generation.target_kind=p_target_kind
    AND generation.target_document_id=p_target_document_id;
  IF target_generation IS NULL THEN
    RAISE EXCEPTION 'publication target generation is missing'
      USING ERRCODE='23503';
  END IF;
  SELECT resource.public_id,resource.document_id
  INTO mapped_public_id,mapped_document_id
  FROM public_resources resource
  WHERE resource.original_document_id=p_target_document_id
    AND resource.resource_kind=p_target_kind;
  IF mapped_public_id IS NOT NULL
     AND mapped_document_id IS DISTINCT FROM p_target_document_id THEN
    RAISE EXCEPTION 'pathless publication resource mapping is detached'
      USING ERRCODE='23514';
  END IF;
  IF mapped_public_id IS NOT NULL THEN
    SELECT generation.generation INTO visibility_generation
    FROM public_visibility_generations generation
    WHERE generation.public_id=mapped_public_id;
    IF visibility_generation IS NULL THEN
      RAISE EXCEPTION 'public visibility generation is missing'
        USING ERRCODE='23503';
    END IF;
  END IF;

  IF p_target_kind='page' THEN
    IF p_action='publish' THEN
      SELECT version.title,version.summary
      INTO page_title,page_summary
      FROM knowledge_pages page
      JOIN hypermedia_documents document
        ON document.id=page.id
       AND document.authority='knowledge'
       AND document.representation='markdown'
      JOIN hypermedia_document_revisions revision
        ON revision.id=page.current_version_id AND revision.document_id=page.id
      JOIN knowledge_page_versions version
        ON version.id=revision.id AND version.page_id=page.id
      JOIN knowledge_revision_contracts contract
        ON contract.revision_id=revision.id AND contract.document_id=page.id
       AND contract.link_contract='generic_document_v1'
      WHERE page.id=p_target_document_id
        AND page.current_version_id=p_expected_revision_id
        AND page.archived_at IS NULL;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'page publication requires its active current generic revision'
          USING ERRCODE='23514';
      END IF;
      IF pathless_publication_target_is_operational(p_target_document_id) THEN
        RAISE EXCEPTION 'operational control documents cannot be published'
          USING ERRCODE='23514';
      END IF;
      PERFORM assert_pathless_public_metadata_safe(
        'page',page_title,page_summary,NULL
      );
    ELSIF NOT EXISTS (
      SELECT 1 FROM knowledge_pages page
      WHERE page.id=p_target_document_id AND page.archived_at IS NULL
    ) THEN
      RAISE EXCEPTION 'page unpublication target is not active'
        USING ERRCODE='23514';
    END IF;
  ELSE
    SELECT asset.filename,asset.content_type,asset.size_bytes,
      asset.duration_seconds
    INTO asset_filename,asset_content_type,asset_size_bytes,
      asset_duration_seconds
    FROM assets asset
    WHERE asset.id=p_target_document_id AND asset.deleted_at IS NULL;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'asset publication target is not active'
        USING ERRCODE='23514';
    END IF;
    IF p_action='publish' THEN
      PERFORM assert_pathless_public_metadata_safe(
        'asset',NULL,NULL,asset_filename
      );
      IF NOT pathless_public_metadata_is_safe(asset_content_type)
         OR length(asset_content_type)>255
         OR asset_size_bytes>5000000000
         OR NOT pathless_public_duration_is_safe(asset_duration_seconds) THEN
        RAISE EXCEPTION 'asset public metadata is not safely representable'
          USING ERRCODE='22023';
      END IF;
    END IF;
  END IF;

  IF p_action='unpublish' THEN
    IF mapped_public_id IS NULL OR NOT (
      (p_target_kind='page' AND (
        EXISTS (
          SELECT 1 FROM page_publications publication
          WHERE publication.public_id=mapped_public_id
        ) OR EXISTS (
          SELECT 1 FROM knowledge_pages page
          WHERE page.id=p_target_document_id
            AND page.published_version_id IS NOT NULL
            AND page.public_path IS NOT NULL
        )
      )) OR
      (p_target_kind='asset' AND (
        EXISTS (
          SELECT 1 FROM asset_publications publication
          WHERE publication.public_id=mapped_public_id
        ) OR EXISTS (
          SELECT 1 FROM assets asset
          WHERE asset.id=p_target_document_id AND asset.public_path IS NOT NULL
        )
      ))
    ) THEN
      RAISE EXCEPTION 'publication target is already private'
        USING ERRCODE='23514';
    END IF;
    allocated_public_id := NULL;
    visibility_hash := pathless_publication_visibility_state_hash(
      p_target_kind,p_target_document_id,mapped_public_id
    );
  ELSE
    allocated_public_id := mapped_public_id;
    IF allocated_public_id IS NULL THEN
      FOR attempt IN 1..32 LOOP
        allocated_public_id := gen_random_uuid();
        CONTINUE WHEN allocated_public_id IN (
          p_intent_id,p_target_document_id,p_expected_revision_id
        );
        BEGIN
          PERFORM assert_public_uuid_available(
            allocated_public_id,p_target_document_id,p_target_kind
          );
          EXIT;
        EXCEPTION WHEN unique_violation THEN
          allocated_public_id := NULL;
        END;
      END LOOP;
      IF allocated_public_id IS NULL THEN
        RAISE EXCEPTION 'could not allocate a public resource UUID'
          USING ERRCODE='54000';
      END IF;
    END IF;

    FOR attempt IN 1..32 LOOP
      allocated_artifact_id := gen_random_uuid();
      CONTINUE WHEN allocated_artifact_id IN (
        p_intent_id,p_target_document_id,p_expected_revision_id,
        allocated_public_id
      );
      allocated_object_key := CASE p_target_kind
        WHEN 'page' THEN
          'documents/public/'||allocated_artifact_id::text||'.md'
        WHEN 'asset' THEN
          'artifacts/public/'||allocated_artifact_id::text
      END;
      BEGIN
        PERFORM reserve_public_artifact_identity(
          allocated_artifact_id,allocated_object_key,
          'pathless_intent',p_intent_id
        );
        EXIT;
      EXCEPTION WHEN unique_violation THEN
        allocated_artifact_id := NULL;
      END;
    END LOOP;
    IF allocated_artifact_id IS NULL THEN
      RAISE EXCEPTION 'could not allocate a public artifact UUID'
        USING ERRCODE='54000';
    END IF;

    source_fingerprint := pathless_publication_source_fingerprint(
      p_target_kind,p_target_document_id,p_expected_revision_id
    );
    IF source_fingerprint IS NULL THEN
      RAISE EXCEPTION 'publication source fingerprint is unavailable'
        USING ERRCODE='23514';
    END IF;
    IF p_target_kind='page' THEN
      projected_ids := pathless_publication_projected_target_ids(
        p_target_document_id,p_expected_revision_id,allocated_public_id
      );
      projection_receipt := pathless_publication_projection_receipt_hash(
        p_target_document_id,p_expected_revision_id,allocated_public_id,
        source_fingerprint
      );
    END IF;
    IF EXISTS (
      SELECT 1 FROM blocking_public_namespace_conflicts conflict
      WHERE conflict.namespace_uuid=p_target_document_id
         OR conflict.namespace_uuid=p_expected_revision_id
         OR conflict.namespace_uuid=allocated_public_id
         OR conflict.namespace_uuid=ANY(projected_ids)
    ) OR (p_target_kind='page'
      AND pathless_publication_projection_has_namespace_conflict(
        p_target_document_id,p_expected_revision_id,allocated_public_id
      )) THEN
      RAISE EXCEPTION 'publication has an unresolved namespace conflict'
        USING ERRCODE='23505';
    END IF;
    visibility_hash := pathless_publication_visibility_state_hash(
      p_target_kind,p_target_document_id,allocated_public_id
    );
  END IF;

  INSERT INTO pathless_publication_intents(
    id,action,target_kind,target_document_id,expected_revision_id,
    candidate_public_id,candidate_artifact_id,candidate_object_key,
    artifact_allocation_kind,artifact_allocation_id,
    projected_target_public_ids,projection_receipt_hash,
    owner_user_id,session_id,expires_at,expected_visibility_generation,
    expected_visibility_state_hash,expected_target_generation,
    expected_source_fingerprint
  ) VALUES (
    p_intent_id,p_action,p_target_kind,p_target_document_id,
    p_expected_revision_id,allocated_public_id,allocated_artifact_id,
    allocated_object_key,
    CASE WHEN p_action='publish'
      THEN 'pathless_intent'::public_artifact_allocation_kind END,
    CASE WHEN p_action='publish' THEN p_intent_id END,
    projected_ids,projection_receipt,p_owner_user_id,p_session_id,
    now()+interval '5 minutes',visibility_generation,visibility_hash,
    target_generation,source_fingerprint
  );

  SELECT * INTO stored
  FROM pathless_publication_intents intent WHERE intent.id=p_intent_id;
  RETURN QUERY SELECT stored.id,stored.action,stored.target_kind,
    stored.target_document_id,stored.expected_revision_id,
    stored.candidate_public_id,stored.expires_at;
END;
$$;

CREATE FUNCTION cancel_pathless_publication_intent(
  p_intent_id uuid,
  p_owner_user_id text,
  p_session_id text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
DECLARE
  intent pathless_publication_intents%ROWTYPE;
BEGIN
  IF p_intent_id IS NULL OR p_owner_user_id IS NULL OR p_session_id IS NULL THEN
    RAISE EXCEPTION 'publication cancellation principal is required'
      USING ERRCODE='42501';
  END IF;
  PERFORM pg_advisory_xact_lock_shared(
    hashtextextended('filesystem-hypermedia-corpus-transition',0)
  );
  SELECT * INTO intent
  FROM pathless_publication_intents WHERE id=p_intent_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'pathless publication intent not found' USING ERRCODE='P0002';
  END IF;
  IF intent.owner_user_id IS DISTINCT FROM p_owner_user_id
     OR intent.session_id IS DISTINCT FROM p_session_id THEN
    RAISE EXCEPTION 'pathless publication intent principal mismatch'
      USING ERRCODE='42501';
  END IF;
  IF intent.confirmed_at IS NOT NULL THEN
    RAISE EXCEPTION 'confirmed publication intent cannot be cancelled'
      USING ERRCODE='23514';
  END IF;
  IF intent.cancelled_at IS NULL THEN
    DELETE FROM confirmation_challenges
    WHERE intent_kind='publication' AND intent_id=intent.id;
    UPDATE pathless_publication_intents
    SET cancelled_at=now() WHERE id=intent.id;
  END IF;
END;
$$;

-- Storage receives the private source and reserved destination only after the
-- complete intent is rechecked. No dashboard/public boundary can translate an
-- intent or representation token into either object key.
CREATE FUNCTION get_pathless_publication_write_target(p_intent_id uuid)
RETURNS TABLE (
  intent_id uuid,
  target_kind publication_target,
  candidate_public_id uuid,
  artifact_id uuid,
  source_body_object_key text,
  source_body_size_bytes bigint,
  source_body_content_hash text,
  body_object_key text,
  max_body_size_bytes bigint,
  public_title text,
  public_summary text,
  public_last_edited_at text,
  public_filename text,
  public_content_type text,
  public_width integer,
  public_height integer,
  public_duration_seconds text,
  projected_target_public_ids uuid[],
  projection_receipt_hash text,
  target_projection jsonb
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
SET jit=off
AS $$
DECLARE
  preliminary record;
  intent record;
BEGIN
  IF p_intent_id IS NULL THEN
    RAISE EXCEPTION 'publication intent is required' USING ERRCODE='22023';
  END IF;
  PERFORM pg_advisory_xact_lock_shared(
    hashtextextended('filesystem-hypermedia-corpus-transition',0)
  );
  SELECT stored.target_kind,stored.target_document_id,stored.expected_revision_id,
    stored.action
  INTO preliminary
  FROM pathless_publication_intents stored WHERE stored.id=p_intent_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'pathless publication intent not found' USING ERRCODE='P0002';
  END IF;
  IF preliminary.action<>'publish' THEN
    RAISE EXCEPTION 'unpublication has no storage write target'
      USING ERRCODE='22023';
  END IF;
  PERFORM lock_pathless_publication_context(
    preliminary.target_kind,preliminary.target_document_id,
    preliminary.expected_revision_id
  );
  PERFORM assert_pathless_publication_intent_current(p_intent_id,false);
  SELECT stored.id,stored.action,stored.target_kind,
    stored.target_document_id,stored.expected_revision_id,
    stored.candidate_public_id,stored.candidate_artifact_id,
    stored.candidate_object_key,stored.projected_target_public_ids,
    stored.projection_receipt_hash
  INTO intent
  FROM pathless_publication_intents stored WHERE stored.id=p_intent_id;
  IF EXISTS (
    SELECT 1 FROM confirmation_challenges challenge
    WHERE challenge.intent_kind='publication' AND challenge.intent_id=intent.id
  ) OR EXISTS (
    SELECT 1 FROM pathless_publication_artifact_staging staging
    WHERE staging.intent_id=intent.id
  ) THEN
    RAISE EXCEPTION 'publication artifact write is no longer pending'
      USING ERRCODE='55000';
  END IF;

  IF intent.target_kind='page' THEN
    RETURN QUERY
    SELECT intent.id,intent.target_kind,intent.candidate_public_id,
      intent.candidate_artifact_id,revision.body_object_key,
      revision.body_size_bytes::bigint,revision.body_content_hash,
      intent.candidate_object_key,4000000::bigint,
      version.title,version.summary,to_char(
        version.created_at AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      ),
      NULL::text,NULL::text,NULL::integer,NULL::integer,NULL::text,
      intent.projected_target_public_ids,intent.projection_receipt_hash,
      pathless_publication_projection_plan(
        intent.target_document_id,intent.expected_revision_id,
        intent.candidate_public_id
      )
    FROM hypermedia_document_revisions revision
    JOIN knowledge_page_versions version
      ON version.id=revision.id AND version.page_id=revision.document_id
    WHERE revision.id=intent.expected_revision_id
      AND revision.document_id=intent.target_document_id;
  ELSE
    RETURN QUERY
    SELECT intent.id,intent.target_kind,intent.candidate_public_id,
      intent.candidate_artifact_id,asset.s3_object_key,
      asset.size_bytes,asset.content_hash,intent.candidate_object_key,
      5000000000::bigint,NULL::text,NULL::text,NULL::text,
      asset.filename,asset.content_type,asset.width,asset.height,
      asset.duration_seconds::text,
      '{}'::uuid[],NULL::text,'[]'::jsonb
    FROM assets asset WHERE asset.id=intent.target_document_id;
  END IF;
END;
$$;

-- The storage broker attests the complete rendered/copied object receipt. All
-- metadata and projection choices are rederived under the source locks; only
-- the bytes receipt is storage-provided. The permanent representation token is
-- a database digest of that complete frozen tuple and is never caller input.
CREATE FUNCTION stage_pathless_publication_artifact(
  p_intent_id uuid,
  p_target_kind publication_target,
  p_body_size_bytes bigint,
  p_body_content_hash text,
  p_public_title text,
  p_public_summary text,
  p_public_last_edited_at timestamptz,
  p_public_filename text,
  p_public_content_type text,
  p_public_width integer,
  p_public_height integer,
  p_public_duration_seconds text,
  p_projected_target_public_ids uuid[],
  p_observed_public_uuid_tokens uuid[],
  p_projection_receipt_hash text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
SET jit=off
SET TimeZone='UTC'
AS $$
DECLARE
  preliminary record;
  intent pathless_publication_intents%ROWTYPE;
  existing pathless_publication_artifact_staging%ROWTYPE;
  source_title text;
  source_summary text;
  source_last_edited_at timestamptz;
  source_filename text;
  source_content_type text;
  source_size_bytes bigint;
  source_content_hash text;
  source_width integer;
  source_height integer;
  source_duration_seconds numeric;
  canonical_projected uuid[];
  canonical_observed uuid[];
  derived_representation_token text;
BEGIN
  IF p_intent_id IS NULL OR p_target_kind IS NULL
     OR p_body_size_bytes IS NULL OR p_body_size_bytes<0
     OR p_body_content_hash IS NULL
     OR p_body_content_hash !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'complete publication artifact receipt is required'
      USING ERRCODE='22023';
  END IF;
  canonical_projected := canonical_public_uuid_set(
    p_projected_target_public_ids
  );
  canonical_observed := canonical_public_uuid_set(
    p_observed_public_uuid_tokens
  );
  IF canonical_projected IS DISTINCT FROM p_projected_target_public_ids
     OR canonical_observed IS DISTINCT FROM p_observed_public_uuid_tokens THEN
    RAISE EXCEPTION 'public UUID receipts must be sorted and unique'
      USING ERRCODE='22023';
  END IF;

  -- Staging rows are immutable. A lost reply may therefore be answered from
  -- the exact receipt without waiting on a source that has since drifted or on
  -- confirmation that has already started. A different retry can never amend
  -- the frozen evidence.
  SELECT * INTO existing
  FROM pathless_publication_artifact_staging staging
  WHERE staging.intent_id=p_intent_id;
  IF FOUND THEN
    IF existing.target_kind IS DISTINCT FROM p_target_kind
       OR existing.body_size_bytes IS DISTINCT FROM p_body_size_bytes
       OR existing.body_content_hash IS DISTINCT FROM p_body_content_hash
       OR existing.public_title IS DISTINCT FROM p_public_title
       OR existing.public_summary IS DISTINCT FROM p_public_summary
       OR existing.public_last_edited_at IS DISTINCT FROM p_public_last_edited_at
       OR existing.public_filename IS DISTINCT FROM p_public_filename
       OR existing.public_content_type IS DISTINCT FROM p_public_content_type
       OR existing.public_width IS DISTINCT FROM p_public_width
       OR existing.public_height IS DISTINCT FROM p_public_height
       OR existing.public_duration_seconds::text IS DISTINCT FROM
         p_public_duration_seconds
       OR existing.projected_target_public_ids IS DISTINCT FROM
         p_projected_target_public_ids
       OR existing.observed_public_uuid_tokens IS DISTINCT FROM
         p_observed_public_uuid_tokens
       OR existing.projection_receipt_hash IS DISTINCT FROM
         p_projection_receipt_hash THEN
      RAISE EXCEPTION 'publication artifact staging retry does not match'
        USING ERRCODE='23505';
    END IF;
    RETURN;
  END IF;

  PERFORM pg_advisory_xact_lock_shared(
    hashtextextended('filesystem-hypermedia-corpus-transition',0)
  );
  SELECT stored.target_kind,stored.target_document_id,stored.expected_revision_id,
    stored.action
  INTO preliminary
  FROM pathless_publication_intents stored WHERE stored.id=p_intent_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'pathless publication intent not found' USING ERRCODE='P0002';
  END IF;
  IF preliminary.action<>'publish'
     OR preliminary.target_kind IS DISTINCT FROM p_target_kind THEN
    RAISE EXCEPTION 'artifact receipt does not match publication intent'
      USING ERRCODE='22023';
  END IF;
  PERFORM lock_pathless_publication_context(
    preliminary.target_kind,preliminary.target_document_id,
    preliminary.expected_revision_id
  );
  PERFORM assert_pathless_publication_intent_current(p_intent_id,false);
  SELECT * INTO intent
  FROM pathless_publication_intents stored WHERE stored.id=p_intent_id;

  IF EXISTS (
    SELECT 1 FROM confirmation_challenges challenge
    WHERE challenge.intent_kind='publication' AND challenge.intent_id=intent.id
  ) THEN
    RAISE EXCEPTION 'publication artifact cannot be staged after challenge issuance'
      USING ERRCODE='55000';
  END IF;

  IF intent.target_kind='page' THEN
    SELECT version.title,version.summary,version.created_at,
      revision.body_size_bytes::bigint,revision.body_content_hash
    INTO source_title,source_summary,source_last_edited_at,
      source_size_bytes,source_content_hash
    FROM hypermedia_document_revisions revision
    JOIN knowledge_page_versions version
      ON version.id=revision.id AND version.page_id=revision.document_id
    WHERE revision.id=intent.expected_revision_id
      AND revision.document_id=intent.target_document_id;
    PERFORM assert_pathless_public_metadata_safe(
      'page',source_title,source_summary,NULL
    );
    IF p_body_size_bytes>4000000
       OR p_public_title IS DISTINCT FROM source_title
       OR p_public_summary IS DISTINCT FROM source_summary
       OR p_public_last_edited_at IS DISTINCT FROM source_last_edited_at
       OR p_public_filename IS NOT NULL OR p_public_content_type IS NOT NULL
       OR p_public_width IS NOT NULL OR p_public_height IS NOT NULL
       OR p_public_duration_seconds IS NOT NULL
       OR p_projected_target_public_ids IS DISTINCT FROM
         intent.projected_target_public_ids
       OR p_observed_public_uuid_tokens IS DISTINCT FROM
         intent.projected_target_public_ids
       OR p_projection_receipt_hash IS DISTINCT FROM
         intent.projection_receipt_hash THEN
      RAISE EXCEPTION 'page artifact receipt does not match frozen projection'
        USING ERRCODE='22023';
    END IF;
  ELSE
    SELECT asset.filename,asset.content_type,asset.size_bytes,
      asset.content_hash,asset.width,asset.height,asset.duration_seconds
    INTO source_filename,source_content_type,source_size_bytes,
      source_content_hash,source_width,source_height,source_duration_seconds
    FROM assets asset WHERE asset.id=intent.target_document_id;
    PERFORM assert_pathless_public_metadata_safe(
      'asset',NULL,NULL,source_filename
    );
    IF p_body_size_bytes>5000000000
       OR p_body_size_bytes IS DISTINCT FROM source_size_bytes
       OR p_body_content_hash IS DISTINCT FROM source_content_hash
       OR p_public_title IS NOT NULL OR p_public_summary IS NOT NULL
       OR p_public_last_edited_at IS NOT NULL
       OR p_public_filename IS DISTINCT FROM source_filename
       OR p_public_content_type IS DISTINCT FROM source_content_type
       OR NOT pathless_public_metadata_is_safe(source_content_type)
       OR length(source_content_type)>255
       OR NOT pathless_public_duration_is_safe(source_duration_seconds)
       OR p_public_width IS DISTINCT FROM source_width
       OR p_public_height IS DISTINCT FROM source_height
       OR p_public_duration_seconds IS DISTINCT FROM
         source_duration_seconds::text
       OR cardinality(p_projected_target_public_ids)<>0
       OR cardinality(p_observed_public_uuid_tokens)<>0
       OR p_projection_receipt_hash IS NOT NULL THEN
      RAISE EXCEPTION 'asset artifact receipt does not match frozen source'
        USING ERRCODE='22023';
    END IF;
  END IF;

  derived_representation_token := pathless_publication_representation_token(
    jsonb_build_object(
      'target_kind',intent.target_kind,
      'candidate_public_id',intent.candidate_public_id,
      'artifact_id',intent.candidate_artifact_id,
      'source_fingerprint',intent.expected_source_fingerprint,
      'body_object_key',intent.candidate_object_key,
      'body_size_bytes',p_body_size_bytes,
      'body_content_hash',p_body_content_hash,
      'public_title',source_title,
      'public_summary',source_summary,
      'public_last_edited_at',source_last_edited_at,
      'public_filename',source_filename,
      'public_content_type',source_content_type,
      'public_width',source_width,
      'public_height',source_height,
      'public_duration_seconds',source_duration_seconds,
      'projected_target_public_ids',intent.projected_target_public_ids,
      'observed_public_uuid_tokens',intent.projected_target_public_ids,
      'projection_receipt_hash',intent.projection_receipt_hash
    )
  );

  SELECT * INTO existing
  FROM pathless_publication_artifact_staging staging
  WHERE staging.intent_id=intent.id;
  IF FOUND THEN
    IF existing.target_kind IS DISTINCT FROM intent.target_kind
       OR existing.candidate_public_id IS DISTINCT FROM intent.candidate_public_id
       OR existing.artifact_id IS DISTINCT FROM intent.candidate_artifact_id
       OR existing.body_object_key IS DISTINCT FROM intent.candidate_object_key
       OR existing.body_size_bytes IS DISTINCT FROM p_body_size_bytes
       OR existing.body_content_hash IS DISTINCT FROM p_body_content_hash
       OR existing.public_title IS DISTINCT FROM p_public_title
       OR existing.public_summary IS DISTINCT FROM p_public_summary
       OR existing.public_last_edited_at IS DISTINCT FROM p_public_last_edited_at
       OR existing.public_filename IS DISTINCT FROM p_public_filename
       OR existing.public_content_type IS DISTINCT FROM p_public_content_type
       OR existing.public_width IS DISTINCT FROM p_public_width
       OR existing.public_height IS DISTINCT FROM p_public_height
       OR existing.public_duration_seconds::text IS DISTINCT FROM
         p_public_duration_seconds
       OR existing.projected_target_public_ids IS DISTINCT FROM
         p_projected_target_public_ids
       OR existing.observed_public_uuid_tokens IS DISTINCT FROM
         p_observed_public_uuid_tokens
       OR existing.projection_receipt_hash IS DISTINCT FROM
         p_projection_receipt_hash
       OR existing.representation_token IS DISTINCT FROM
         derived_representation_token THEN
      RAISE EXCEPTION 'publication artifact staging retry does not match'
        USING ERRCODE='23505';
    END IF;
    RETURN;
  END IF;

  PERFORM reserve_public_representation_token(
    derived_representation_token,intent.candidate_artifact_id,intent.target_kind
  );
  INSERT INTO pathless_publication_artifact_staging(
    intent_id,target_kind,candidate_public_id,artifact_id,body_object_key,
    body_size_bytes,body_content_hash,public_title,public_summary,
    public_last_edited_at,public_filename,public_content_type,public_width,
    public_height,public_duration_seconds,projected_target_public_ids,
    observed_public_uuid_tokens,projection_receipt_hash,
    allocation_kind,allocation_id,representation_token
  ) VALUES (
    intent.id,intent.target_kind,intent.candidate_public_id,
    intent.candidate_artifact_id,intent.candidate_object_key,
    p_body_size_bytes,p_body_content_hash,p_public_title,p_public_summary,
    p_public_last_edited_at,p_public_filename,p_public_content_type,
    p_public_width,p_public_height,p_public_duration_seconds::numeric,
    p_projected_target_public_ids,p_observed_public_uuid_tokens,
    p_projection_receipt_hash,'pathless_intent',intent.id,
    derived_representation_token
  );
END;
$$;

-- Publication confirmation reuses the legacy discriminator, so challenge
-- issuance dispatches through the permanent cross-family UUID registry. Every
-- publication family takes its target lock before its intent row; pathless
-- publish challenges additionally require the complete immutable stage.
CREATE OR REPLACE FUNCTION issue_confirmation_challenge(
  p_intent_kind confirmation_intent_kind,
  p_intent_id uuid,
  p_challenge text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
SET jit=off
AS $$
DECLARE
  intent_expires_at timestamptz;
  intent_inactive boolean;
  publication_family publication_intent_store;
  legacy_exists boolean;
  pathless_exists boolean;
  preliminary record;
  pathless_intent pathless_publication_intents%ROWTYPE;
  legacy_intent record;
  deletion_intent record;
  deletion_target record;
BEGIN
  IF p_intent_kind IS NULL OR p_intent_id IS NULL OR p_challenge IS NULL
     OR p_challenge !~ '^[A-Za-z0-9_-]{43,128}$' THEN
    RAISE EXCEPTION 'valid confirmation challenge required'
      USING ERRCODE='22023';
  END IF;

  PERFORM pg_advisory_xact_lock_shared(
    hashtextextended('filesystem-hypermedia-corpus-transition',0)
  );

  IF p_intent_kind='publication' THEN
    SELECT reservation.intent_store INTO publication_family
    FROM publication_intent_id_reservations reservation
    WHERE reservation.intent_id=p_intent_id;
    SELECT EXISTS (
      SELECT 1 FROM publication_intents intent WHERE intent.id=p_intent_id
    ),EXISTS (
      SELECT 1 FROM pathless_publication_intents intent WHERE intent.id=p_intent_id
    ) INTO legacy_exists,pathless_exists;
    IF publication_family IS NULL OR legacy_exists=pathless_exists
       OR (publication_family='legacy' AND NOT legacy_exists)
       OR (publication_family='pathless' AND NOT pathless_exists) THEN
      RAISE EXCEPTION 'publication intent UUID family is missing or ambiguous'
        USING ERRCODE='23505';
    END IF;

    IF publication_family='pathless' THEN
      SELECT intent.target_kind,intent.target_document_id,
        intent.expected_revision_id,intent.action
      INTO preliminary
      FROM pathless_publication_intents intent WHERE intent.id=p_intent_id;
      PERFORM lock_pathless_publication_context(
        preliminary.target_kind,preliminary.target_document_id,
        preliminary.expected_revision_id
      );
      PERFORM assert_pathless_publication_intent_current(
        p_intent_id,preliminary.action='publish'
      );
      SELECT * INTO pathless_intent
      FROM pathless_publication_intents intent WHERE intent.id=p_intent_id;
      intent_expires_at := pathless_intent.expires_at;
      intent_inactive := pathless_intent.confirmed_at IS NOT NULL
        OR pathless_intent.cancelled_at IS NOT NULL;
    ELSE
      SELECT intent.target_kind,intent.target_id,intent.version_id
      INTO preliminary
      FROM publication_intents intent WHERE intent.id=p_intent_id;
      IF preliminary.target_kind='page' THEN
        PERFORM lock_operational_document(preliminary.target_id);
        PERFORM page.id FROM knowledge_pages page
        WHERE page.id=preliminary.target_id FOR UPDATE;
      ELSE
        PERFORM asset.id FROM assets asset
        WHERE asset.id=preliminary.target_id FOR UPDATE;
      END IF;
      SELECT intent.id,intent.action,intent.target_kind,intent.target_id,
        intent.version_id,intent.public_path,intent.owner_user_id,
        intent.session_id,intent.expires_at
      INTO legacy_intent
      FROM publication_intents intent WHERE intent.id=p_intent_id
      FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'publication intent not found' USING ERRCODE='P0002';
      END IF;
      intent_expires_at := legacy_intent.expires_at;
      intent_inactive := false;
    END IF;
  ELSIF p_intent_kind='knowledge_export' THEN
    SELECT intent.expires_at,
      intent.confirmed_at IS NOT NULL OR intent.download_started_at IS NOT NULL
    INTO intent_expires_at,intent_inactive
    FROM knowledge_export_intents intent WHERE intent.id=p_intent_id
    FOR UPDATE;
  ELSIF p_intent_kind='page_deletion' THEN
    SELECT intent.page_id,intent.expected_version_id
    INTO preliminary
    FROM page_deletion_intents intent WHERE intent.id=p_intent_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'confirmation intent not found' USING ERRCODE='P0002';
    END IF;
    PERFORM lock_operational_document(preliminary.page_id);
    SELECT page.id,page.current_version_id,page.published_version_id,
      page.archived_at
    INTO deletion_target
    FROM knowledge_pages page WHERE page.id=preliminary.page_id
    FOR UPDATE;
    SELECT intent.id,intent.page_id,intent.expected_version_id,
      intent.owner_user_id,intent.session_id,intent.expires_at
    INTO deletion_intent
    FROM page_deletion_intents intent WHERE intent.id=p_intent_id
    FOR UPDATE;
    IF NOT FOUND
       OR deletion_intent.page_id IS DISTINCT FROM preliminary.page_id
       OR deletion_intent.expected_version_id IS DISTINCT FROM
         preliminary.expected_version_id THEN
      RAISE EXCEPTION 'page deletion intent changed while locking'
        USING ERRCODE='40001';
    END IF;
    IF deletion_target.id IS NULL
       OR deletion_target.archived_at IS NULL
       OR deletion_target.published_version_id IS NOT NULL
       OR deletion_target.current_version_id IS DISTINCT FROM
         deletion_intent.expected_version_id THEN
      RAISE EXCEPTION 'page is no longer eligible for permanent deletion'
        USING ERRCODE='22023';
    END IF;
    intent_expires_at := deletion_intent.expires_at;
    intent_inactive := false;
  ELSE
    RAISE EXCEPTION 'confirmation intent kind is unsupported'
      USING ERRCODE='22023';
  END IF;

  IF intent_expires_at IS NULL THEN
    RAISE EXCEPTION 'confirmation intent not found' USING ERRCODE='P0002';
  END IF;
  IF intent_inactive OR intent_expires_at<=now() THEN
    RAISE EXCEPTION 'confirmation intent is inactive' USING ERRCODE='22023';
  END IF;
  INSERT INTO confirmation_challenges(intent_kind,intent_id,challenge)
  VALUES (p_intent_kind,p_intent_id,p_challenge);
END;
$$;

-- Confirmation dispatches through the permanent intent namespace. Pathless
-- intents retain immutable history and replay success after confirmation;
-- legacy intents keep their established delete-on-success behavior. Both
-- families acquire the target before intent/challenge/passkey state.
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
SET jit=off
AS $$
DECLARE
  publication_family publication_intent_store;
  legacy_exists boolean;
  pathless_exists boolean;
  preliminary record;
  pathless_intent pathless_publication_intents%ROWTYPE;
  legacy_intent record;
  staging pathless_publication_artifact_staging%ROWTYPE;
  locked_target_id uuid;
  locked_target_revision_id uuid;
  locked_target_path text;
  locked_target_inactive_at timestamptz;
  mapped_public_id uuid;
  mapped_document_id uuid;
  mapped_resource_kind publication_target;
  intent_challenge text;
  namespace_uuid uuid;
  source_body_size_bytes bigint;
  source_body_content_hash text;
BEGIN
  IF p_intent_id IS NULL OR p_owner_user_id IS NULL OR p_session_id IS NULL
     OR p_credential_id IS NULL OR length(trim(p_credential_id))<1
     OR p_expected_counter IS NULL OR p_new_counter IS NULL THEN
    RAISE EXCEPTION 'verified publication principal required'
      USING ERRCODE='42501';
  END IF;

  PERFORM pg_advisory_xact_lock_shared(
    hashtextextended('filesystem-hypermedia-corpus-transition',0)
  );
  SELECT reservation.intent_store INTO publication_family
  FROM publication_intent_id_reservations reservation
  WHERE reservation.intent_id=p_intent_id;
  SELECT EXISTS (
    SELECT 1 FROM publication_intents intent WHERE intent.id=p_intent_id
  ),EXISTS (
    SELECT 1 FROM pathless_publication_intents intent WHERE intent.id=p_intent_id
  ) INTO legacy_exists,pathless_exists;
  IF publication_family IS NULL OR legacy_exists=pathless_exists
     OR (publication_family='legacy' AND NOT legacy_exists)
     OR (publication_family='pathless' AND NOT pathless_exists) THEN
    RAISE EXCEPTION 'publication intent UUID family is missing or ambiguous'
      USING ERRCODE='23505';
  END IF;

  IF publication_family='pathless' THEN
    -- Immutable, principal-bound confirmation is an idempotent terminal
    -- result. This fast path deliberately precedes expiry, target and passkey
    -- checks so a lost response never reapplies a later publication state.
    SELECT intent.id,intent.action,intent.target_kind,
      intent.target_document_id,intent.expected_revision_id,
      intent.candidate_public_id,intent.owner_user_id,intent.session_id,
      intent.expires_at,intent.confirmed_at,intent.cancelled_at
    INTO preliminary
    FROM pathless_publication_intents intent WHERE intent.id=p_intent_id;
    IF preliminary.owner_user_id IS DISTINCT FROM p_owner_user_id
       OR preliminary.session_id IS DISTINCT FROM p_session_id THEN
      RAISE EXCEPTION 'publication intent principal mismatch'
        USING ERRCODE='42501';
    END IF;
    IF preliminary.confirmed_at IS NOT NULL THEN RETURN; END IF;
    IF preliminary.cancelled_at IS NOT NULL THEN
      RAISE EXCEPTION 'pathless publication intent is inactive'
        USING ERRCODE='22023';
    END IF;

    PERFORM lock_pathless_publication_context(
      preliminary.target_kind,preliminary.target_document_id,
      preliminary.expected_revision_id
    );
    SELECT * INTO pathless_intent
    FROM pathless_publication_intents intent WHERE intent.id=p_intent_id
    FOR UPDATE;
    IF pathless_intent.id IS NULL
       OR pathless_intent.action IS DISTINCT FROM preliminary.action
       OR pathless_intent.target_kind IS DISTINCT FROM preliminary.target_kind
       OR pathless_intent.target_document_id IS DISTINCT FROM
         preliminary.target_document_id
       OR pathless_intent.expected_revision_id IS DISTINCT FROM
         preliminary.expected_revision_id
       OR pathless_intent.candidate_public_id IS DISTINCT FROM
         preliminary.candidate_public_id THEN
      RAISE EXCEPTION 'publication intent changed while locking'
        USING ERRCODE='40001';
    END IF;
    IF pathless_intent.owner_user_id IS DISTINCT FROM p_owner_user_id
       OR pathless_intent.session_id IS DISTINCT FROM p_session_id THEN
      RAISE EXCEPTION 'publication intent principal mismatch'
        USING ERRCODE='42501';
    END IF;
    IF pathless_intent.confirmed_at IS NOT NULL THEN RETURN; END IF;
    IF pathless_intent.cancelled_at IS NOT NULL
       OR pathless_intent.expires_at<=now() THEN
      RAISE EXCEPTION 'pathless publication intent is inactive'
        USING ERRCODE='22023';
    END IF;

    PERFORM assert_pathless_publication_intent_current(
      pathless_intent.id,pathless_intent.action='publish'
    );
    SELECT challenge.challenge INTO intent_challenge
    FROM confirmation_challenges challenge
    WHERE challenge.intent_kind='publication'
      AND challenge.intent_id=pathless_intent.id
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'publication challenge not issued' USING ERRCODE='42501';
    END IF;
    PERFORM consume_confirmation_challenge(
      'publication',pathless_intent.id,intent_challenge,
      pathless_intent.owner_user_id,p_credential_id,
      p_expected_counter,p_new_counter
    );

    IF pathless_intent.action='publish' THEN
      -- Legacy route-registration reaches this namespace only after consuming
      -- its passkey, so pathless confirmation follows the same suffix order.
      FOR namespace_uuid IN
        SELECT DISTINCT value
        FROM unnest(array_remove(ARRAY[
          pathless_intent.target_document_id,
          pathless_intent.expected_revision_id,
          pathless_intent.candidate_public_id
        ]||pathless_intent.projected_target_public_ids,NULL)) value
        ORDER BY value
      LOOP
        PERFORM lock_public_uuid_namespace(namespace_uuid);
      END LOOP;
      IF EXISTS (
        SELECT 1 FROM blocking_public_namespace_conflicts conflict
        WHERE conflict.namespace_uuid=pathless_intent.target_document_id
           OR conflict.namespace_uuid=pathless_intent.expected_revision_id
           OR conflict.namespace_uuid=pathless_intent.candidate_public_id
           OR conflict.namespace_uuid=ANY(
             pathless_intent.projected_target_public_ids
           )
      ) THEN
        RAISE EXCEPTION 'publication has an unresolved namespace conflict'
          USING ERRCODE='23505';
      END IF;

      SELECT resource.public_id,resource.document_id,resource.resource_kind
      INTO mapped_public_id,mapped_document_id,mapped_resource_kind
      FROM public_resources resource
      WHERE resource.original_document_id=pathless_intent.target_document_id;
      IF mapped_public_id IS NULL THEN
        PERFORM assert_public_uuid_available(
          pathless_intent.candidate_public_id,
          pathless_intent.target_document_id,pathless_intent.target_kind
        );
        INSERT INTO public_resources(public_id,document_id,resource_kind)
        VALUES (
          pathless_intent.candidate_public_id,
          pathless_intent.target_document_id,pathless_intent.target_kind
        );
        mapped_public_id := pathless_intent.candidate_public_id;
      ELSIF mapped_public_id IS DISTINCT FROM
          pathless_intent.candidate_public_id
        OR mapped_document_id IS DISTINCT FROM
          pathless_intent.target_document_id
        OR mapped_resource_kind IS DISTINCT FROM pathless_intent.target_kind THEN
        RAISE EXCEPTION 'publication resource mapping changed'
          USING ERRCODE='40001';
      END IF;

      SELECT * INTO staging
      FROM pathless_publication_artifact_staging stored
      WHERE stored.intent_id=pathless_intent.id;
      IF pathless_intent.target_kind='page' THEN
        SELECT revision.body_size_bytes::bigint,revision.body_content_hash
        INTO source_body_size_bytes,source_body_content_hash
        FROM hypermedia_document_revisions revision
        WHERE revision.id=pathless_intent.expected_revision_id
          AND revision.document_id=pathless_intent.target_document_id;
        INSERT INTO public_page_artifacts(
          artifact_id,public_id,source_document_id,source_revision_id,
          source_body_size_bytes,source_body_content_hash,body_object_key,
          body_size_bytes,body_content_hash,public_title,public_summary,
          public_last_edited_at,projected_target_public_ids,
          observed_public_uuid_tokens,projection_receipt_hash,origin,
          source_intent_id,representation_token,
          reservation_allocation_kind,reservation_allocation_id
        ) VALUES (
          staging.artifact_id,mapped_public_id,
          pathless_intent.target_document_id,
          pathless_intent.expected_revision_id,source_body_size_bytes,
          source_body_content_hash,staging.body_object_key,
          staging.body_size_bytes,staging.body_content_hash,
          staging.public_title,staging.public_summary,
          staging.public_last_edited_at,staging.projected_target_public_ids,
          staging.observed_public_uuid_tokens,
          staging.projection_receipt_hash,'ordinary',pathless_intent.id,
          staging.representation_token,'pathless_intent',pathless_intent.id
        );
        DELETE FROM page_publications WHERE public_id=mapped_public_id;
        INSERT INTO page_publications(public_id,artifact_id)
        VALUES (mapped_public_id,staging.artifact_id);
      ELSE
        INSERT INTO public_asset_artifacts(
          artifact_id,public_id,source_document_id,body_object_key,
          body_size_bytes,body_content_hash,public_filename,
          public_content_type,public_width,public_height,
          public_duration_seconds,origin,source_intent_id,
          representation_token,reservation_allocation_kind,
          reservation_allocation_id
        ) VALUES (
          staging.artifact_id,mapped_public_id,
          pathless_intent.target_document_id,staging.body_object_key,
          staging.body_size_bytes,staging.body_content_hash,
          staging.public_filename,staging.public_content_type,
          staging.public_width,staging.public_height,
          staging.public_duration_seconds,'ordinary',pathless_intent.id,
          staging.representation_token,'pathless_intent',pathless_intent.id
        );
        DELETE FROM asset_publications WHERE public_id=mapped_public_id;
        INSERT INTO asset_publications(public_id,artifact_id)
        VALUES (mapped_public_id,staging.artifact_id);
      END IF;
    ELSE
      SELECT resource.public_id,resource.document_id,resource.resource_kind
      INTO mapped_public_id,mapped_document_id,mapped_resource_kind
      FROM public_resources resource
      WHERE resource.original_document_id=pathless_intent.target_document_id;
      IF mapped_public_id IS NULL
         OR mapped_document_id IS DISTINCT FROM
           pathless_intent.target_document_id
         OR mapped_resource_kind IS DISTINCT FROM pathless_intent.target_kind THEN
        RAISE EXCEPTION 'publication resource mapping changed'
          USING ERRCODE='40001';
      END IF;
      IF pathless_intent.target_kind='page' THEN
        DELETE FROM page_publications WHERE public_id=mapped_public_id;
        UPDATE knowledge_pages
        SET published_version_id=NULL,public_path=NULL,updated_at=now()
        WHERE id=pathless_intent.target_document_id
          AND (published_version_id IS NOT NULL OR public_path IS NOT NULL);
      ELSE
        DELETE FROM asset_publications WHERE public_id=mapped_public_id;
        UPDATE assets SET public_path=NULL
        WHERE id=pathless_intent.target_document_id AND public_path IS NOT NULL;
      END IF;
    END IF;

    UPDATE pathless_publication_intents
    SET confirmed_at=now() WHERE id=pathless_intent.id;
    RETURN;
  END IF;

  SELECT intent.id,intent.action,intent.target_kind,intent.target_id,
    intent.version_id,intent.public_path,intent.owner_user_id,
    intent.session_id,intent.expires_at
  INTO preliminary
  FROM publication_intents intent WHERE intent.id=p_intent_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'publication intent not found' USING ERRCODE='P0002';
  END IF;
  IF preliminary.target_kind='page' THEN
    PERFORM lock_operational_document(preliminary.target_id);
    SELECT page.id,page.current_version_id,page.current_path,page.archived_at
    INTO locked_target_id,locked_target_revision_id,locked_target_path,
      locked_target_inactive_at
    FROM knowledge_pages page WHERE page.id=preliminary.target_id
    FOR UPDATE;
  ELSE
    SELECT asset.id,NULL::uuid,asset.current_path,asset.deleted_at
    INTO locked_target_id,locked_target_revision_id,locked_target_path,
      locked_target_inactive_at
    FROM assets asset WHERE asset.id=preliminary.target_id
    FOR UPDATE;
  END IF;
  IF locked_target_id IS NULL THEN
    RAISE EXCEPTION 'publication target not found' USING ERRCODE='P0002';
  END IF;
  SELECT intent.id,intent.action,intent.target_kind,intent.target_id,
    intent.version_id,intent.public_path,intent.owner_user_id,
    intent.session_id,intent.expires_at
  INTO legacy_intent
  FROM publication_intents intent WHERE intent.id=p_intent_id
  FOR UPDATE;
  IF legacy_intent.id IS NULL
     OR legacy_intent.action IS DISTINCT FROM preliminary.action
     OR legacy_intent.target_kind IS DISTINCT FROM preliminary.target_kind
     OR legacy_intent.target_id IS DISTINCT FROM preliminary.target_id
     OR legacy_intent.version_id IS DISTINCT FROM preliminary.version_id
     OR legacy_intent.public_path IS DISTINCT FROM preliminary.public_path THEN
    RAISE EXCEPTION 'publication intent changed while locking'
      USING ERRCODE='40001';
  END IF;
  IF legacy_intent.expires_at<=now() THEN
    RAISE EXCEPTION 'publication intent expired' USING ERRCODE='22023';
  END IF;
  IF legacy_intent.owner_user_id IS DISTINCT FROM p_owner_user_id
     OR legacy_intent.session_id IS DISTINCT FROM p_session_id THEN
    RAISE EXCEPTION 'publication intent principal mismatch'
      USING ERRCODE='42501';
  END IF;
  IF legacy_intent.action='publish' THEN
    IF legacy_intent.target_kind='page' AND (
      locked_target_inactive_at IS NOT NULL
      OR NOT EXISTS (
        SELECT 1 FROM knowledge_page_versions version
        WHERE version.id=legacy_intent.version_id
          AND version.page_id=legacy_intent.target_id
          AND version.path=legacy_intent.public_path
      )
    ) THEN
      RAISE EXCEPTION 'legacy page publication source is no longer available'
        USING ERRCODE='40001';
    ELSIF legacy_intent.target_kind='asset' AND (
      locked_target_inactive_at IS NOT NULL
      OR locked_target_path IS DISTINCT FROM legacy_intent.public_path
    ) THEN
      RAISE EXCEPTION 'legacy asset publication source is no longer current'
        USING ERRCODE='40001';
    END IF;
  END IF;
  SELECT challenge.challenge INTO intent_challenge
  FROM confirmation_challenges challenge
  WHERE challenge.intent_kind='publication'
    AND challenge.intent_id=legacy_intent.id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'publication challenge not issued' USING ERRCODE='42501';
  END IF;
  PERFORM consume_confirmation_challenge(
    'publication',legacy_intent.id,intent_challenge,
    legacy_intent.owner_user_id,p_credential_id,
    p_expected_counter,p_new_counter
  );

  IF legacy_intent.target_kind='page' THEN
    IF legacy_intent.action='publish' THEN
      IF NOT EXISTS (
        SELECT 1 FROM knowledge_page_versions version
        WHERE version.id=legacy_intent.version_id
          AND version.page_id=legacy_intent.target_id
          AND version.path=legacy_intent.public_path
      ) THEN
        RAISE EXCEPTION 'page version or public path mismatch'
          USING ERRCODE='23503';
      END IF;
      UPDATE knowledge_pages
      SET published_version_id=legacy_intent.version_id,
        public_path=legacy_intent.public_path,updated_at=now()
      WHERE id=legacy_intent.target_id AND archived_at IS NULL;
    ELSE
      UPDATE knowledge_pages
      SET published_version_id=NULL,public_path=NULL,updated_at=now()
      WHERE id=legacy_intent.target_id;
    END IF;
  ELSE
    IF legacy_intent.action='publish' THEN
      UPDATE assets SET public_path=legacy_intent.public_path
      WHERE id=legacy_intent.target_id AND deleted_at IS NULL
        AND current_path=legacy_intent.public_path;
    ELSE
      UPDATE assets SET public_path=NULL WHERE id=legacy_intent.target_id;
    END IF;
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'publication target not found' USING ERRCODE='P0002';
  END IF;
  DELETE FROM publication_intents WHERE id=legacy_intent.id;
END;
$$;

-- Permanent deletion participates in the same target-first publication lock
-- order. Holding the operational advisory before the page row also makes the
-- advisory acquired by deletion triggers reentrant instead of row->advisory.
CREATE OR REPLACE FUNCTION confirm_page_deletion_intent(
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
  preliminary_page_id uuid;
  intent record;
  intent_challenge text;
  target record;
BEGIN
  IF p_intent_id IS NULL OR p_owner_user_id IS NULL OR p_session_id IS NULL
     OR p_credential_id IS NULL OR length(trim(p_credential_id))<1
     OR p_expected_counter IS NULL OR p_new_counter IS NULL THEN
    RAISE EXCEPTION 'verified page deletion principal required'
      USING ERRCODE='42501';
  END IF;

  PERFORM pg_advisory_xact_lock_shared(
    hashtextextended('filesystem-hypermedia-corpus-transition',0)
  );
  SELECT deletion.page_id INTO preliminary_page_id
  FROM page_deletion_intents deletion WHERE deletion.id=p_intent_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'page deletion intent not found' USING ERRCODE='P0002';
  END IF;
  PERFORM lock_operational_document(preliminary_page_id);
  SELECT page.id,page.current_version_id,page.published_version_id,
    page.archived_at
  INTO target
  FROM knowledge_pages page WHERE page.id=preliminary_page_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'page not found' USING ERRCODE='P0002';
  END IF;

  SELECT deletion.id,deletion.page_id,deletion.expected_version_id,
    deletion.owner_user_id,deletion.session_id,deletion.expires_at
  INTO intent
  FROM page_deletion_intents deletion WHERE deletion.id=p_intent_id
  FOR UPDATE;
  IF NOT FOUND OR intent.page_id IS DISTINCT FROM preliminary_page_id THEN
    RAISE EXCEPTION 'page deletion intent changed while locking'
      USING ERRCODE='40001';
  END IF;
  IF intent.expires_at<=now() THEN
    RAISE EXCEPTION 'page deletion intent expired' USING ERRCODE='22023';
  END IF;
  IF intent.owner_user_id IS DISTINCT FROM p_owner_user_id
     OR intent.session_id IS DISTINCT FROM p_session_id THEN
    RAISE EXCEPTION 'page deletion intent principal mismatch'
      USING ERRCODE='42501';
  END IF;
  IF target.archived_at IS NULL OR target.published_version_id IS NOT NULL
     OR target.current_version_id IS DISTINCT FROM intent.expected_version_id THEN
    RAISE EXCEPTION 'page is no longer eligible for permanent deletion'
      USING ERRCODE='22023';
  END IF;
  SELECT challenge.challenge INTO intent_challenge
  FROM confirmation_challenges challenge
  WHERE challenge.intent_kind='page_deletion' AND challenge.intent_id=intent.id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'page deletion challenge not issued' USING ERRCODE='42501';
  END IF;

  PERFORM consume_confirmation_challenge(
    'page_deletion',intent.id,intent_challenge,intent.owner_user_id,
    p_credential_id,p_expected_counter,p_new_counter
  );
  DELETE FROM publication_intents
  WHERE target_kind='page' AND target_id=target.id;
  DELETE FROM knowledge_page_versions WHERE page_id=target.id;
  DELETE FROM knowledge_pages WHERE id=target.id;
END;
$$;

-- Export challenge issuance now locks the intent before inserting its
-- challenge. Confirmation follows the same intent->challenge->passkey order,
-- preventing reissue/confirmation from forming an inverse wait cycle.
CREATE OR REPLACE FUNCTION confirm_knowledge_export_intent(
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
  IF p_intent_id IS NULL OR p_owner_user_id IS NULL OR p_session_id IS NULL
     OR p_credential_id IS NULL OR length(trim(p_credential_id))<1
     OR p_expected_counter IS NULL OR p_new_counter IS NULL THEN
    RAISE EXCEPTION 'verified export principal required' USING ERRCODE='42501';
  END IF;
  SELECT stored.id,stored.owner_user_id,stored.session_id,stored.expires_at,
    stored.confirmed_at,stored.download_started_at
  INTO intent
  FROM knowledge_export_intents stored WHERE stored.id=p_intent_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'knowledge export intent not found' USING ERRCODE='P0002';
  END IF;
  IF intent.confirmed_at IS NOT NULL OR intent.download_started_at IS NOT NULL THEN
    RAISE EXCEPTION 'knowledge export intent already used' USING ERRCODE='23505';
  END IF;
  IF intent.expires_at<=now() THEN
    RAISE EXCEPTION 'knowledge export intent expired' USING ERRCODE='22023';
  END IF;
  IF intent.owner_user_id IS DISTINCT FROM p_owner_user_id
     OR intent.session_id IS DISTINCT FROM p_session_id THEN
    RAISE EXCEPTION 'knowledge export principal mismatch' USING ERRCODE='42501';
  END IF;
  SELECT challenge.challenge INTO intent_challenge
  FROM confirmation_challenges challenge
  WHERE challenge.intent_kind='knowledge_export' AND challenge.intent_id=intent.id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'knowledge export challenge not issued' USING ERRCODE='42501';
  END IF;
  PERFORM consume_confirmation_challenge(
    'knowledge_export',intent.id,intent_challenge,intent.owner_user_id,
    p_credential_id,p_expected_counter,p_new_counter
  );
  UPDATE knowledge_export_intents
  SET confirmed_at=now(),expires_at=now()+interval '24 hours'
  WHERE id=intent.id;
END;
$$;

-- The non-login boundary owner has only the rows needed by the checked
-- procedures. Long-lived service roles receive EXECUTE on their one surface,
-- never raw access to plans, object keys, immutable staging, or registries.
GRANT SELECT,INSERT ON pathless_publication_intents
  TO context_use_boundary_owner;
GRANT UPDATE (confirmed_at,cancelled_at) ON pathless_publication_intents
  TO context_use_boundary_owner;
GRANT SELECT,INSERT ON pathless_publication_artifact_staging
  TO context_use_boundary_owner;
GRANT INSERT (
  artifact_id,public_id,source_document_id,source_revision_id,
  source_body_size_bytes,source_body_content_hash,body_object_key,
  body_size_bytes,body_content_hash,public_title,public_summary,
  public_last_edited_at,projected_target_public_ids,
  observed_public_uuid_tokens,projection_receipt_hash,origin,
  source_intent_id,representation_token,reservation_allocation_kind,
  reservation_allocation_id
) ON public_page_artifacts TO context_use_boundary_owner;
GRANT INSERT (
  artifact_id,public_id,source_document_id,body_object_key,body_size_bytes,
  body_content_hash,public_filename,public_content_type,public_width,
  public_height,public_duration_seconds,origin,source_intent_id,
  representation_token,reservation_allocation_kind,reservation_allocation_id
) ON public_asset_artifacts TO context_use_boundary_owner;
GRANT INSERT (public_id,artifact_id)
  ON page_publications,asset_publications TO context_use_boundary_owner;
GRANT SELECT (
  public_id,document_id,original_document_id,resource_kind
) ON public_resources TO context_use_boundary_owner;
GRANT SELECT (public_id,artifact_id) ON page_publications,asset_publications
  TO context_use_boundary_owner;
GRANT UPDATE (public_id) ON page_publications,asset_publications
  TO context_use_boundary_owner;
GRANT SELECT (
  id,current_path,current_version_id,published_version_id,public_path,
  archived_at,created_at,updated_at
) ON knowledge_pages TO context_use_boundary_owner;
GRANT SELECT (
  id,page_id,version_number,path,title,summary,created_at
) ON knowledge_page_versions TO context_use_boundary_owner;
GRANT SELECT (
  id,document_id,revision_number,body_size_bytes,
  body_content_hash,created_at
) ON hypermedia_document_revisions TO context_use_boundary_owner;
GRANT SELECT (
  id,current_path,public_path,filename,content_type,size_bytes,content_hash,
  width,height,duration_seconds,created_at,deleted_at
) ON assets TO context_use_boundary_owner;
GRANT SELECT ON blocking_public_namespace_conflicts
  TO context_use_boundary_owner;
GRANT UPDATE (id) ON page_deletion_intents TO context_use_boundary_owner;
GRANT UPDATE (id) ON knowledge_pages TO context_use_boundary_owner;
GRANT UPDATE (id) ON publication_intents TO context_use_boundary_owner;
GRANT UPDATE (intent_id) ON confirmation_challenges
  TO context_use_boundary_owner;
GRANT SELECT (intent_id,intent_store)
  ON publication_intent_id_reservations TO context_use_confirmation;
GRANT SELECT (
  id,action,target_kind,target_document_id,expected_revision_id,
  owner_user_id,session_id,expires_at
) ON pathless_publication_intents TO context_use_confirmation;

REVOKE ALL ON FUNCTION pathless_publication_source_fingerprint(
  publication_target,uuid,uuid
) FROM PUBLIC;
REVOKE ALL ON FUNCTION canonical_public_uuid_set(uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION pathless_publication_projection_plan(
  uuid,uuid,uuid
) FROM PUBLIC;
REVOKE ALL ON FUNCTION pathless_publication_projected_target_ids(
  uuid,uuid,uuid
) FROM PUBLIC;
REVOKE ALL ON FUNCTION pathless_publication_projection_has_namespace_conflict(
  uuid,uuid,uuid
) FROM PUBLIC;
REVOKE ALL ON FUNCTION pathless_publication_projection_receipt_hash(
  uuid,uuid,uuid,text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION guard_pathless_publication_intent_history() FROM PUBLIC;
REVOKE ALL ON FUNCTION guard_pathless_publication_staging_history() FROM PUBLIC;
REVOKE ALL ON FUNCTION pathless_public_metadata_is_safe(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION pathless_public_duration_is_safe(numeric) FROM PUBLIC;
REVOKE ALL ON FUNCTION assert_pathless_public_metadata_safe(
  publication_target,text,text,text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION pathless_publication_target_is_operational(uuid)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION lock_pathless_publication_context(
  publication_target,uuid,uuid
) FROM PUBLIC;
REVOKE ALL ON FUNCTION pathless_publication_representation_token(jsonb)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION assert_pathless_publication_staging_exact(uuid)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION assert_pathless_publication_intent_current(uuid,boolean)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION begin_pathless_publication_intent(
  uuid,publication_action,publication_target,uuid,uuid,text,text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION cancel_pathless_publication_intent(uuid,text,text)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION get_pathless_publication_write_target(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION stage_pathless_publication_artifact(
  uuid,publication_target,bigint,text,text,text,timestamptz,text,text,
  integer,integer,text,uuid[],uuid[],text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION issue_confirmation_challenge(
  confirmation_intent_kind,uuid,text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION confirm_publication_intent(
  uuid,text,text,text,integer,integer
) FROM PUBLIC;
REVOKE ALL ON FUNCTION confirm_page_deletion_intent(
  uuid,text,text,text,integer,integer
) FROM PUBLIC;
REVOKE ALL ON FUNCTION confirm_knowledge_export_intent(
  uuid,text,text,text,integer,integer
) FROM PUBLIC;

-- Isolate the key-bearing source fingerprint and storage write-target behind a
-- dedicated non-login owner. The general mutation owner receives only EXECUTE
-- on the one-way fingerprint helper, never raw asset object-key access.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname='context_use_pathless_storage_owner'
  ) THEN
    CREATE ROLE context_use_pathless_storage_owner
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
      NOREPLICATION NOBYPASSRLS;
  ELSE
    ALTER ROLE context_use_pathless_storage_owner
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
      NOREPLICATION NOBYPASSRLS;
  END IF;
  ALTER ROLE context_use_pathless_storage_owner
    SET search_path=pg_catalog,public;
END;
$$;
GRANT USAGE,CREATE ON SCHEMA public TO context_use_pathless_storage_owner;
GRANT SELECT (
  id,action,target_kind,target_document_id,expected_revision_id,
  candidate_public_id,candidate_artifact_id,candidate_object_key,
  projected_target_public_ids,projection_receipt_hash
) ON pathless_publication_intents TO context_use_pathless_storage_owner;
GRANT SELECT (intent_kind,intent_id) ON confirmation_challenges
  TO context_use_pathless_storage_owner;
GRANT SELECT (intent_id) ON pathless_publication_artifact_staging
  TO context_use_pathless_storage_owner;
GRANT SELECT (id,authority,representation) ON hypermedia_documents
  TO context_use_pathless_storage_owner;
GRANT SELECT (id,current_version_id,archived_at) ON knowledge_pages
  TO context_use_pathless_storage_owner;
GRANT SELECT (
  id,document_id,revision_number,body_object_key,body_size_bytes,
  body_content_hash,created_at
) ON hypermedia_document_revisions TO context_use_pathless_storage_owner;
GRANT SELECT (
  id,page_id,version_number,path,title,summary,created_at
) ON knowledge_page_versions TO context_use_pathless_storage_owner;
GRANT SELECT (
  revision_id,document_id,link_contract,provenance,body_content_hash,
  target_document_ids
) ON knowledge_revision_contracts TO context_use_pathless_storage_owner;
GRANT SELECT (
  id,current_path,filename,content_type,size_bytes,content_hash,s3_object_key,
  width,height,duration_seconds,created_at,deleted_at
) ON assets TO context_use_pathless_storage_owner;

GRANT USAGE,CREATE ON SCHEMA public TO context_use_boundary_owner;
ALTER FUNCTION pathless_publication_source_fingerprint(
  publication_target,uuid,uuid
) OWNER TO context_use_pathless_storage_owner;
ALTER FUNCTION canonical_public_uuid_set(uuid[])
  OWNER TO context_use_boundary_owner;
ALTER FUNCTION pathless_publication_projection_plan(uuid,uuid,uuid)
  OWNER TO context_use_boundary_owner;
ALTER FUNCTION pathless_publication_projected_target_ids(uuid,uuid,uuid)
  OWNER TO context_use_boundary_owner;
ALTER FUNCTION pathless_publication_projection_has_namespace_conflict(
  uuid,uuid,uuid
) OWNER TO context_use_boundary_owner;
ALTER FUNCTION pathless_publication_projection_receipt_hash(
  uuid,uuid,uuid,text
) OWNER TO context_use_boundary_owner;
ALTER FUNCTION guard_pathless_publication_intent_history()
  OWNER TO context_use_boundary_owner;
ALTER FUNCTION guard_pathless_publication_staging_history()
  OWNER TO context_use_boundary_owner;
ALTER FUNCTION pathless_public_metadata_is_safe(text)
  OWNER TO context_use_boundary_owner;
ALTER FUNCTION pathless_public_duration_is_safe(numeric)
  OWNER TO context_use_boundary_owner;
ALTER FUNCTION assert_pathless_public_metadata_safe(
  publication_target,text,text,text
) OWNER TO context_use_boundary_owner;
ALTER FUNCTION pathless_publication_target_is_operational(uuid)
  OWNER TO context_use_boundary_owner;
ALTER FUNCTION lock_pathless_publication_context(publication_target,uuid,uuid)
  OWNER TO context_use_boundary_owner;
ALTER FUNCTION pathless_publication_representation_token(jsonb)
  OWNER TO context_use_boundary_owner;
ALTER FUNCTION assert_pathless_publication_staging_exact(uuid)
  OWNER TO context_use_boundary_owner;
ALTER FUNCTION assert_pathless_publication_intent_current(uuid,boolean)
  OWNER TO context_use_boundary_owner;
ALTER FUNCTION begin_pathless_publication_intent(
  uuid,publication_action,publication_target,uuid,uuid,text,text
) OWNER TO context_use_boundary_owner;
ALTER FUNCTION cancel_pathless_publication_intent(uuid,text,text)
  OWNER TO context_use_boundary_owner;
ALTER FUNCTION get_pathless_publication_write_target(uuid)
  OWNER TO context_use_pathless_storage_owner;
ALTER FUNCTION stage_pathless_publication_artifact(
  uuid,publication_target,bigint,text,text,text,timestamptz,text,text,
  integer,integer,text,uuid[],uuid[],text
) OWNER TO context_use_boundary_owner;
ALTER FUNCTION issue_confirmation_challenge(
  confirmation_intent_kind,uuid,text
) OWNER TO context_use_boundary_owner;
ALTER FUNCTION confirm_publication_intent(
  uuid,text,text,text,integer,integer
) OWNER TO context_use_boundary_owner;
ALTER FUNCTION confirm_page_deletion_intent(
  uuid,text,text,text,integer,integer
) OWNER TO context_use_boundary_owner;
ALTER FUNCTION confirm_knowledge_export_intent(
  uuid,text,text,text,integer,integer
) OWNER TO context_use_boundary_owner;
REVOKE CREATE ON SCHEMA public FROM context_use_boundary_owner;
REVOKE CREATE ON SCHEMA public FROM context_use_pathless_storage_owner;

GRANT EXECUTE ON FUNCTION pathless_publication_source_fingerprint(
  publication_target,uuid,uuid
) TO context_use_boundary_owner;
GRANT EXECUTE ON FUNCTION lock_pathless_publication_context(
  publication_target,uuid,uuid
),assert_pathless_publication_intent_current(uuid,boolean),
  pathless_publication_projection_plan(uuid,uuid,uuid)
  TO context_use_pathless_storage_owner;

GRANT EXECUTE ON FUNCTION begin_pathless_publication_intent(
  uuid,publication_action,publication_target,uuid,uuid,text,text
),cancel_pathless_publication_intent(uuid,text,text)
  TO context_use_dashboard;
GRANT EXECUTE ON FUNCTION get_pathless_publication_write_target(uuid),
  stage_pathless_publication_artifact(
    uuid,publication_target,bigint,text,text,text,timestamptz,text,text,
    integer,integer,text,uuid[],uuid[],text
  ) TO context_use_storage;
GRANT EXECUTE ON FUNCTION issue_confirmation_challenge(
  confirmation_intent_kind,uuid,text
),confirm_publication_intent(uuid,text,text,text,integer,integer)
  TO context_use_confirmation;

-- Corpus adoption uses the permanent 028 plan row but adds typed CAS evidence
-- and a separate immutable storage receipt. All three adoption kinds allocate
-- a fresh v2 artifact; the legacy page artifact, asset object, or hub revision
-- is only the exact source of a checked copy/projection.
INSERT INTO publication_target_generations(
  target_kind,target_document_id,generation,updated_at
)
SELECT DISTINCT ON (target_kind,adoption.source_document_id)
  target_kind,adoption.source_document_id,1,adoption.created_at
FROM pathless_publication_adoptions adoption
CROSS JOIN LATERAL (VALUES (CASE adoption.adoption_kind
  WHEN 'legacy_asset' THEN 'asset'::publication_target
  ELSE 'page'::publication_target
END)) kind(target_kind)
ORDER BY target_kind,adoption.source_document_id,adoption.created_at
ON CONFLICT (target_kind,target_document_id) DO NOTHING;

ALTER TABLE pathless_publication_adoptions
  ADD COLUMN expected_visibility_generation bigint,
  ADD COLUMN expected_visibility_state_hash text,
  ADD COLUMN expected_target_generation bigint;
UPDATE pathless_publication_adoptions adoption
SET expected_visibility_generation=coalesce((
      SELECT generation FROM public_visibility_generations
      WHERE public_id=adoption.public_id
    ),0),
    expected_visibility_state_hash=pathless_publication_visibility_state_hash(
      CASE adoption.adoption_kind
        WHEN 'legacy_asset' THEN 'asset'::publication_target
        ELSE 'page'::publication_target
      END,
      adoption.source_document_id,adoption.public_id
    ),
    expected_target_generation=coalesce((
      SELECT generation FROM publication_target_generations
      WHERE target_kind=CASE adoption.adoption_kind
        WHEN 'legacy_asset' THEN 'asset'::publication_target
        ELSE 'page'::publication_target
      END
        AND target_document_id=adoption.source_document_id
    ),0);
ALTER TABLE pathless_publication_adoptions
  ALTER COLUMN expected_visibility_generation SET NOT NULL,
  ALTER COLUMN expected_visibility_state_hash SET NOT NULL,
  ALTER COLUMN expected_target_generation SET NOT NULL,
  ADD CONSTRAINT pathless_publication_adoptions_visibility_generation_check
    CHECK (expected_visibility_generation>=0),
  ADD CONSTRAINT pathless_publication_adoptions_visibility_hash_check
    CHECK (expected_visibility_state_hash ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT pathless_publication_adoptions_target_generation_check
    CHECK (expected_target_generation>0);

CREATE TABLE pathless_publication_adoption_staging (
  adoption_id uuid PRIMARY KEY,
  adoption_kind pathless_publication_adoption_kind NOT NULL,
  resource_kind publication_target NOT NULL,
  source_document_id uuid NOT NULL,
  source_revision_id uuid,
  public_id uuid NOT NULL,
  artifact_id uuid NOT NULL UNIQUE,
  body_object_key text NOT NULL UNIQUE,
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
  projection_receipt_hash text NOT NULL CHECK (
    projection_receipt_hash ~ '^[a-f0-9]{64}$'
  ),
  representation_token text NOT NULL UNIQUE CHECK (
    representation_token ~ '^[a-f0-9]{64}$'
  ),
  allocation_kind public_artifact_allocation_kind NOT NULL
    DEFAULT 'pathless_adoption' CHECK (allocation_kind='pathless_adoption'),
  allocation_id uuid NOT NULL CHECK (allocation_id=adoption_id),
  staged_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (adoption_kind='legacy_asset' AND resource_kind='asset'
      AND source_revision_id IS NULL
      AND body_size_bytes<=5000000000
      AND public_title IS NULL AND public_summary IS NULL
      AND public_last_edited_at IS NULL
      AND public_filename IS NOT NULL AND public_content_type IS NOT NULL
      AND (public_width IS NULL OR public_width>0)
      AND (public_height IS NULL OR public_height>0)
      AND (public_duration_seconds IS NULL OR public_duration_seconds>=0)
      AND cardinality(projected_target_public_ids)=0
      AND cardinality(observed_public_uuid_tokens)=0)
    OR (adoption_kind IN ('legacy_page','directory_hub')
      AND resource_kind='page' AND source_revision_id IS NOT NULL
      AND body_size_bytes<=4000000
      AND public_title IS NOT NULL AND public_summary IS NOT NULL
      AND public_last_edited_at IS NOT NULL
      AND public_filename IS NULL AND public_content_type IS NULL
      AND public_width IS NULL AND public_height IS NULL
      AND public_duration_seconds IS NULL)
  ),
  FOREIGN KEY (
    adoption_id,adoption_kind,public_id,artifact_id,body_object_key,
    source_document_id
  ) REFERENCES pathless_publication_adoptions(
    id,adoption_kind,public_id,candidate_artifact_id,candidate_object_key,
    source_document_id
  ) ON DELETE RESTRICT,
  FOREIGN KEY (
    adoption_id,adoption_kind,public_id,artifact_id,body_object_key,
    source_document_id,source_revision_id
  ) REFERENCES pathless_publication_adoptions(
    id,adoption_kind,public_id,candidate_artifact_id,candidate_object_key,
    source_document_id,source_revision_id
  ) ON DELETE RESTRICT,
  FOREIGN KEY (
    artifact_id,body_object_key,allocation_kind,allocation_id
  ) REFERENCES public_artifact_id_reservations(
    artifact_id,body_object_key,allocation_kind,allocation_id
  ) ON DELETE RESTRICT,
  FOREIGN KEY (
    representation_token,artifact_id,resource_kind
  ) REFERENCES public_representation_token_reservations(
    representation_token,artifact_id,resource_kind
  ) ON DELETE RESTRICT,
  UNIQUE (
    adoption_id,adoption_kind,resource_kind,source_document_id,
    source_revision_id,public_id,artifact_id,body_object_key
  )
);

CREATE FUNCTION guard_pathless_publication_adoption_history()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'pathless publication adoption history is permanent'
      USING ERRCODE='23514';
  END IF;
  IF ROW(
    NEW.id,NEW.adoption_kind,NEW.source_document_id,NEW.source_revision_id,
    NEW.public_id,NEW.candidate_artifact_id,NEW.candidate_object_key,
    NEW.reservation_allocation_kind,NEW.reservation_allocation_id,
    NEW.source_snapshot,NEW.source_fingerprint,NEW.created_at,
    NEW.expected_visibility_generation,NEW.expected_visibility_state_hash,
    NEW.expected_target_generation
  ) IS DISTINCT FROM ROW(
    OLD.id,OLD.adoption_kind,OLD.source_document_id,OLD.source_revision_id,
    OLD.public_id,OLD.candidate_artifact_id,OLD.candidate_object_key,
    OLD.reservation_allocation_kind,OLD.reservation_allocation_id,
    OLD.source_snapshot,OLD.source_fingerprint,OLD.created_at,
    OLD.expected_visibility_generation,OLD.expected_visibility_state_hash,
    OLD.expected_target_generation
  ) THEN
    RAISE EXCEPTION 'pathless publication adoption evidence is immutable'
      USING ERRCODE='23514';
  END IF;
  IF NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;
  IF OLD.phase='planned' AND NEW.phase='applied'
     AND OLD.applied_at IS NULL AND NEW.applied_at IS NOT NULL
     AND OLD.superseded_at IS NULL AND NEW.superseded_at IS NULL THEN
    RETURN NEW;
  END IF;
  IF OLD.phase='planned' AND NEW.phase='superseded'
     AND OLD.applied_at IS NULL AND NEW.applied_at IS NULL
     AND OLD.superseded_at IS NULL AND NEW.superseded_at IS NOT NULL THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'pathless publication adoption phase transition is invalid'
    USING ERRCODE='23514';
END;
$$;

CREATE FUNCTION guard_pathless_publication_adoption_staging_history()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
BEGIN
  IF TG_OP IN ('UPDATE','DELETE') THEN
    RAISE EXCEPTION 'pathless publication adoption staging is immutable'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER pathless_publication_adoptions_zz029_keep_history
BEFORE UPDATE OR DELETE ON pathless_publication_adoptions
FOR EACH ROW EXECUTE FUNCTION guard_pathless_publication_adoption_history();
CREATE TRIGGER pathless_adoption_staging_029_keep_history
BEFORE UPDATE OR DELETE ON pathless_publication_adoption_staging
FOR EACH ROW EXECUTE FUNCTION guard_pathless_publication_adoption_staging_history();

-- A hub's public revision is intentionally not current and therefore has no
-- 027 generic contract. Its durable corpus completion carries the full parser
-- receipt (including dangling UUIDs); document_links must equal the extant
-- subset before that receipt can drive a fresh public projection.
CREATE FUNCTION pathless_publication_hub_target_ids(
  p_source_document_id uuid
) RETURNS uuid[]
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
DECLARE
  receipt jsonb;
  public_revision_id uuid;
  canonical uuid[];
  indexed uuid[];
  expected_indexed uuid[];
BEGIN
  SELECT completion.details->'public_target_document_ids',
    mapping.public_revision_id
  INTO receipt,public_revision_id
  FROM directory_hub_migrations mapping
  JOIN corpus_migration_completions completion
    ON completion.run_id=mapping.migration_run_id
   AND completion.item_kind='directory'
   AND completion.item_id=mapping.directory_id
   AND completion.result_kind='hub'
   AND completion.output_document_id=mapping.document_id
   AND completion.output_revision_id=mapping.private_revision_id
  JOIN corpus_migration_runs run
    ON run.id=mapping.migration_run_id AND run.phase='ready'
  WHERE mapping.document_id=p_source_document_id
    AND mapping.public_revision_id IS NOT NULL
    AND mapping.public_id IS NOT NULL;
  IF receipt IS NULL OR jsonb_typeof(receipt)<>'array'
     OR jsonb_array_length(receipt)>100000
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements_text(receipt) value
       WHERE value !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     ) THEN
    RAISE EXCEPTION 'directory hub has no exact public target receipt'
      USING ERRCODE='23514';
  END IF;
  SELECT canonical_public_uuid_set(coalesce(array_agg(value::uuid),'{}'::uuid[]))
  INTO canonical
  FROM jsonb_array_elements_text(receipt) value;
  IF to_jsonb(canonical) IS DISTINCT FROM receipt THEN
    RAISE EXCEPTION 'directory hub public target receipt is not canonical'
      USING ERRCODE='23514';
  END IF;
  SELECT coalesce(array_agg(link.target_document_id ORDER BY link.target_document_id),
    '{}'::uuid[])
  INTO indexed
  FROM document_links link
  WHERE link.source_revision_id=public_revision_id;
  SELECT coalesce(array_agg(document.id ORDER BY document.id),'{}'::uuid[])
  INTO expected_indexed
  FROM unnest(canonical) target(id)
  JOIN hypermedia_documents document ON document.id=target.id;
  IF indexed IS DISTINCT FROM expected_indexed OR NOT EXISTS (
    SELECT 1 FROM hypermedia_document_revisions revision
    WHERE revision.id=public_revision_id
      AND revision.document_id=p_source_document_id
      AND revision.links_indexed_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'directory hub indexed links do not match its full receipt'
      USING ERRCODE='23514';
  END IF;
  RETURN canonical;
END;
$$;

CREATE FUNCTION pathless_publication_adoption_projection_plan(
  p_source_document_id uuid,
  p_public_id uuid,
  p_target_document_ids uuid[]
) RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path=pg_catalog,public
SET TimeZone='UTC'
AS $$
  WITH targets AS (
    SELECT unnest(canonical_public_uuid_set(p_target_document_ids)) AS target_document_id
  ), described AS (
    SELECT target.target_document_id,resource.public_id AS mapped_public_id,
      resource.resource_kind AS mapped_resource_kind,
      CASE
        WHEN target.target_document_id=p_source_document_id THEN 'self'
        WHEN EXISTS (
          SELECT 1 FROM blocking_public_namespace_conflicts conflict
          WHERE conflict.namespace_uuid=target.target_document_id
             OR conflict.namespace_uuid=resource.public_id
        ) THEN 'namespace_conflict'
        WHEN resource.public_id IS NOT NULL
         AND resource.document_id=target.target_document_id
         AND (
           (resource.resource_kind='page' AND EXISTS (
             SELECT 1 FROM page_publications publication
             WHERE publication.public_id=resource.public_id
           ))
           OR (resource.resource_kind='asset' AND EXISTS (
             SELECT 1 FROM asset_publications publication
             WHERE publication.public_id=resource.public_id
           ))
         ) THEN 'active_public'
        WHEN resource.public_id IS NOT NULL THEN 'inactive_public'
        WHEN public_uuid_has_private_identity(target.target_document_id) THEN 'private'
        ELSE 'dangling'
      END AS outcome
    FROM targets target
    LEFT JOIN LATERAL (
      SELECT public_id,document_id,resource_kind
      FROM public_resources
      WHERE original_document_id=target.target_document_id
      LIMIT 1
    ) resource ON true
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'target_document_id',target_document_id,
    'outcome',outcome,
    'public_id',CASE
      WHEN outcome='self' THEN p_public_id
      WHEN outcome='active_public' THEN mapped_public_id
      ELSE NULL
    END,
    'public_target_kind',CASE
      WHEN outcome='self' THEN 'page'
      WHEN outcome='active_public' THEN mapped_resource_kind::text
      ELSE NULL
    END
  ) ORDER BY target_document_id),'[]'::jsonb)
  FROM described;
$$;

CREATE FUNCTION pathless_publication_adoption_projected_target_ids(
  p_source_document_id uuid,
  p_public_id uuid,
  p_target_document_ids uuid[]
) RETURNS uuid[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
  SELECT canonical_public_uuid_set(coalesce(array_agg(
    (entry->>'public_id')::uuid
  ),'{}'::uuid[]))
  FROM jsonb_array_elements(pathless_publication_adoption_projection_plan(
    p_source_document_id,p_public_id,p_target_document_ids
  )) entry
  WHERE entry->>'public_id' IS NOT NULL;
$$;

CREATE FUNCTION pathless_publication_adoption_frozen_receipt_hash(
  p_source_fingerprint text,
  p_target_document_ids uuid[],
  p_target_projection jsonb
) RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path=pg_catalog,public
SET TimeZone='UTC'
AS $$
  SELECT encode(digest(convert_to(jsonb_build_object(
    'source_fingerprint',p_source_fingerprint,
    'target_document_ids',canonical_public_uuid_set(p_target_document_ids),
    'target_projection',p_target_projection
  )::text,'UTF8'),'sha256'),'hex');
$$;

CREATE FUNCTION pathless_publication_adoption_projection_receipt_hash(
  p_source_fingerprint text,
  p_source_document_id uuid,
  p_public_id uuid,
  p_target_document_ids uuid[]
) RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path=pg_catalog,public
SET TimeZone='UTC'
AS $$
  SELECT pathless_publication_adoption_frozen_receipt_hash(
    p_source_fingerprint,canonical_public_uuid_set(p_target_document_ids),
    pathless_publication_adoption_projection_plan(
      p_source_document_id,p_public_id,p_target_document_ids
    )
  );
$$;

CREATE FUNCTION pathless_publication_adoption_source_snapshot(
  p_adoption_kind pathless_publication_adoption_kind,
  p_source_document_id uuid,
  p_public_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path=pg_catalog,public
SET TimeZone='UTC'
AS $$
DECLARE
  snapshot jsonb;
  hub_targets uuid[];
BEGIN
  IF p_adoption_kind='legacy_page' THEN
    SELECT jsonb_build_object(
      'adoption_kind','legacy_page',
      'source_document_id',page.id,
      'source_revision_id',version.id,
      'public_id',resource.public_id,
      'current_path',page.current_path,
      'current_revision_id',page.current_version_id,
      'archived_at',page.archived_at,
      'legacy_public_path',page.public_path,
      'legacy_projection_generation',projection.generation,
      'legacy_source_artifact_id',artifact.artifact_id,
      'copy_source_body_object_key',artifact.body_object_key,
      'copy_source_body_size_bytes',artifact.body_size_bytes,
      'copy_source_body_content_hash',artifact.body_content_hash,
      'source_revision_body_size_bytes',revision.body_size_bytes,
      'source_revision_body_content_hash',revision.body_content_hash,
      'public_title',version.title,
      'public_summary',version.summary,
      'public_last_edited_at',version.created_at,
      'target_document_ids','[]'::jsonb,
      'target_projection','[]'::jsonb
    ) INTO snapshot
    FROM knowledge_pages page
    JOIN public_resources resource
      ON resource.original_document_id=page.id
     AND resource.document_id=page.id AND resource.resource_kind='page'
     AND resource.public_id=p_public_id
    JOIN knowledge_page_versions version
      ON version.id=page.published_version_id AND version.page_id=page.id
    JOIN hypermedia_document_revisions revision
      ON revision.id=version.id AND revision.document_id=page.id
    JOIN public_projection_state projection ON projection.singleton
    JOIN published_page_artifacts artifact
      ON artifact.page_id=page.id AND artifact.version_id=version.id
     AND artifact.projection_generation=projection.generation
    WHERE page.id=p_source_document_id AND page.archived_at IS NULL
      AND page.public_path IS NOT NULL;
  ELSIF p_adoption_kind='legacy_asset' THEN
    SELECT jsonb_build_object(
      'adoption_kind','legacy_asset',
      'source_document_id',asset.id,
      'source_revision_id',NULL,
      'public_id',resource.public_id,
      'current_path',asset.current_path,
      'created_at',asset.created_at,
      'deleted_at',asset.deleted_at,
      'legacy_public_path',asset.public_path,
      'copy_source_body_object_key',asset.s3_object_key,
      'copy_source_body_size_bytes',asset.size_bytes,
      'copy_source_body_content_hash',asset.content_hash,
      'public_filename',asset.filename,
      'public_content_type',asset.content_type,
      'public_width',asset.width,
      'public_height',asset.height,
      'public_duration_seconds',asset.duration_seconds,
      'target_document_ids','[]'::jsonb,
      'target_projection','[]'::jsonb
    ) INTO snapshot
    FROM assets asset
    JOIN public_resources resource
      ON resource.original_document_id=asset.id
     AND resource.document_id=asset.id AND resource.resource_kind='asset'
     AND resource.public_id=p_public_id
    WHERE asset.id=p_source_document_id AND asset.deleted_at IS NULL
      AND asset.public_path IS NOT NULL;
  ELSIF p_adoption_kind='directory_hub' THEN
    hub_targets := pathless_publication_hub_target_ids(p_source_document_id);
    SELECT jsonb_build_object(
      'adoption_kind','directory_hub',
      'source_document_id',mapping.document_id,
      'source_revision_id',mapping.public_revision_id,
      'public_id',mapping.public_id,
      'current_path',page.current_path,
      'current_revision_id',page.current_version_id,
      'archived_at',page.archived_at,
      'migration_run_id',mapping.migration_run_id,
      'completion_source_fingerprint',completion.source_fingerprint,
      'completion_details',completion.details,
      'legacy_path',mapping.legacy_path,
      'temporary_path',mapping.temporary_path,
      'private_revision_id',mapping.private_revision_id,
      'private_projection_fingerprint',mapping.private_projection_fingerprint,
      'public_projection_fingerprint',mapping.public_projection_fingerprint,
      'copy_source_body_object_key',revision.body_object_key,
      'copy_source_body_size_bytes',revision.body_size_bytes,
      'copy_source_body_content_hash',revision.body_content_hash,
      'source_revision_body_size_bytes',revision.body_size_bytes,
      'source_revision_body_content_hash',revision.body_content_hash,
      'source_revision_number',revision.revision_number,
      'source_revision_links_indexed_at',revision.links_indexed_at,
      'source_version_path',version.path,
      'public_title',version.title,
      'public_summary',version.summary,
      'public_last_edited_at',version.created_at,
      'target_document_ids',to_jsonb(hub_targets),
      'target_projection',pathless_publication_adoption_projection_plan(
        mapping.document_id,mapping.public_id,hub_targets
      )
    ) INTO snapshot
    FROM directory_hub_migrations mapping
    JOIN corpus_migration_runs run
      ON run.id=mapping.migration_run_id AND run.phase='ready'
    JOIN corpus_migration_completions completion
      ON completion.run_id=mapping.migration_run_id
     AND completion.item_kind='directory'
     AND completion.item_id=mapping.directory_id
     AND completion.result_kind='hub'
     AND completion.output_document_id=mapping.document_id
     AND completion.output_revision_id=mapping.private_revision_id
    JOIN knowledge_pages page
      ON page.id=mapping.document_id AND page.archived_at IS NULL
     AND page.current_path=mapping.temporary_path
     AND page.current_version_id=mapping.private_revision_id
    JOIN public_resources resource
      ON resource.public_id=mapping.public_id
     AND resource.original_document_id=mapping.document_id
     AND resource.document_id=mapping.document_id
     AND resource.resource_kind='page'
    JOIN hypermedia_document_revisions revision
      ON revision.id=mapping.public_revision_id
     AND revision.document_id=mapping.document_id
    JOIN knowledge_page_versions version
      ON version.id=revision.id AND version.page_id=mapping.document_id
    WHERE mapping.document_id=p_source_document_id
      AND mapping.public_id=p_public_id
      AND mapping.public_revision_id IS NOT NULL
      AND mapping.public_projection_fingerprint IS NOT NULL;
  END IF;
  RETURN snapshot;
END;
$$;

CREATE FUNCTION pathless_publication_adoption_source_fingerprint(
  p_adoption_kind pathless_publication_adoption_kind,
  p_source_document_id uuid,
  p_public_id uuid
) RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path=pg_catalog,public
SET TimeZone='UTC'
AS $$
  SELECT encode(digest(convert_to(snapshot::text,'UTF8'),'sha256'),'hex')
  FROM (SELECT pathless_publication_adoption_source_snapshot(
    p_adoption_kind,p_source_document_id,p_public_id
  ) AS snapshot) source
  WHERE snapshot IS NOT NULL;
$$;

CREATE FUNCTION lock_pathless_publication_adoption_context(
  p_adoption_kind pathless_publication_adoption_kind,
  p_source_document_id uuid
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
DECLARE
  target_ids uuid[] := '{}'::uuid[];
  locked_target_ids uuid[];
  identity_ids uuid[];
  namespace_ids uuid[];
  identity_id uuid;
  hub_run_id uuid;
  hub_public_revision_id uuid;
  locked_hub_run_id uuid;
  locked_hub_public_revision_id uuid;
BEGIN
  IF p_adoption_kind IS NULL OR p_source_document_id IS NULL THEN
    RAISE EXCEPTION 'adoption source identity is required' USING ERRCODE='22023';
  END IF;
  PERFORM pg_advisory_xact_lock_shared(
    hashtextextended('filesystem-hypermedia-corpus-transition',0)
  );
  IF p_adoption_kind='directory_hub' THEN
    SELECT mapping.migration_run_id,mapping.public_revision_id
    INTO hub_run_id,hub_public_revision_id
    FROM directory_hub_migrations mapping
    WHERE mapping.document_id=p_source_document_id;
    IF NOT FOUND OR hub_public_revision_id IS NULL THEN
      RAISE EXCEPTION 'directory hub mapping not found' USING ERRCODE='P0002';
    END IF;
    -- Corpus transitions consistently acquire the run before a revision. Hold
    -- both exact proof rows before taking the private target/mapping locks.
    PERFORM 1 FROM corpus_migration_runs run
    WHERE run.id=hub_run_id AND run.phase='ready'
    FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'directory hub migration is no longer ready'
        USING ERRCODE='40001';
    END IF;
    PERFORM 1 FROM hypermedia_document_revisions revision
    WHERE revision.id=hub_public_revision_id
      AND revision.document_id=p_source_document_id
    FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'directory hub public revision changed'
        USING ERRCODE='40001';
    END IF;
    target_ids := pathless_publication_hub_target_ids(p_source_document_id);
  END IF;
  identity_ids := canonical_public_uuid_set(
    array_append(target_ids,p_source_document_id)
  );
  FOREACH identity_id IN ARRAY identity_ids LOOP
    PERFORM lock_operational_document(identity_id);
  END LOOP;

  IF p_adoption_kind='legacy_asset' THEN
    PERFORM 1 FROM assets WHERE id=p_source_document_id FOR UPDATE;
  ELSE
    PERFORM 1 FROM knowledge_pages WHERE id=p_source_document_id FOR UPDATE;
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'adoption source target not found' USING ERRCODE='P0002';
  END IF;

  IF p_adoption_kind='directory_hub' THEN
    SELECT mapping.migration_run_id,mapping.public_revision_id
    INTO locked_hub_run_id,locked_hub_public_revision_id
    FROM directory_hub_migrations mapping
    WHERE mapping.document_id=p_source_document_id
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'directory hub mapping not found' USING ERRCODE='P0002';
    END IF;
    IF locked_hub_run_id IS DISTINCT FROM hub_run_id
       OR locked_hub_public_revision_id IS DISTINCT FROM
         hub_public_revision_id THEN
      RAISE EXCEPTION 'directory hub mapping changed while locking'
        USING ERRCODE='40001';
    END IF;
    locked_target_ids := pathless_publication_hub_target_ids(
      p_source_document_id
    );
    IF locked_target_ids IS DISTINCT FROM target_ids THEN
      RAISE EXCEPTION 'directory hub target receipt changed while locking'
        USING ERRCODE='40001';
    END IF;
  END IF;

  PERFORM page.id FROM knowledge_pages page
  WHERE page.id=ANY(identity_ids) AND page.id<>p_source_document_id
  ORDER BY page.id FOR SHARE;
  PERFORM asset.id FROM assets asset
  WHERE asset.id=ANY(identity_ids) AND asset.id<>p_source_document_id
  ORDER BY asset.id FOR SHARE;

  PERFORM resource.public_id
  FROM public_resources resource
  WHERE resource.original_document_id=ANY(identity_ids)
  ORDER BY resource.original_document_id,resource.public_id
  FOR UPDATE;
  PERFORM generation.public_id
  FROM public_visibility_generations generation
  JOIN public_resources resource ON resource.public_id=generation.public_id
  WHERE resource.original_document_id=ANY(identity_ids)
  ORDER BY generation.public_id
  FOR UPDATE OF generation;
  PERFORM publication.public_id
  FROM page_publications publication
  JOIN public_resources resource ON resource.public_id=publication.public_id
  WHERE resource.original_document_id=ANY(identity_ids)
  ORDER BY publication.public_id
  FOR SHARE OF publication;
  PERFORM publication.public_id
  FROM asset_publications publication
  JOIN public_resources resource ON resource.public_id=publication.public_id
  WHERE resource.original_document_id=ANY(identity_ids)
  ORDER BY publication.public_id
  FOR SHARE OF publication;
  PERFORM generation.target_document_id
  FROM publication_target_generations generation
  WHERE generation.target_document_id=ANY(identity_ids)
  ORDER BY generation.target_kind,generation.target_document_id
  FOR UPDATE;

  SELECT canonical_public_uuid_set(coalesce(array_agg(value),'{}'::uuid[]))
  INTO namespace_ids
  FROM (
    SELECT unnest(identity_ids) AS value
    UNION ALL
    SELECT resource.public_id
    FROM public_resources resource
    WHERE resource.original_document_id=ANY(identity_ids)
  ) namespaces;
  FOREACH identity_id IN ARRAY namespace_ids LOOP
    PERFORM lock_public_uuid_namespace(identity_id);
  END LOOP;

  IF p_adoption_kind='legacy_page' THEN
    PERFORM 1 FROM public_projection_state WHERE singleton FOR SHARE;
    PERFORM artifact.artifact_id
    FROM knowledge_pages page
    JOIN public_projection_state projection ON projection.singleton
    JOIN published_page_artifacts artifact
      ON artifact.page_id=page.id
     AND artifact.version_id=page.published_version_id
     AND artifact.projection_generation=projection.generation
    WHERE page.id=p_source_document_id
    FOR SHARE OF artifact;
  END IF;
END;
$$;

CREATE FUNCTION pathless_publication_adoption_is_current(
  p_adoption_id uuid
) RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
DECLARE
  adoption pathless_publication_adoptions%ROWTYPE;
  resolved_resource_kind publication_target;
  current_target_generation bigint;
  current_visibility_generation bigint;
  current_snapshot jsonb;
  current_fingerprint text;
  projected_ids uuid[] := '{}'::uuid[];
BEGIN
  SELECT * INTO adoption
  FROM pathless_publication_adoptions WHERE id=p_adoption_id;
  IF NOT FOUND OR adoption.phase<>'planned' THEN RETURN false; END IF;
  resolved_resource_kind := CASE adoption.adoption_kind
    WHEN 'legacy_asset' THEN 'asset'::publication_target
    ELSE 'page'::publication_target
  END;
  SELECT generation INTO current_target_generation
  FROM publication_target_generations
  WHERE target_kind=resolved_resource_kind
    AND target_document_id=adoption.source_document_id;
  SELECT generation INTO current_visibility_generation
  FROM public_visibility_generations
  WHERE public_id=adoption.public_id;
  current_snapshot := pathless_publication_adoption_source_snapshot(
    adoption.adoption_kind,adoption.source_document_id,adoption.public_id
  );
  current_fingerprint := pathless_publication_adoption_source_fingerprint(
    adoption.adoption_kind,adoption.source_document_id,adoption.public_id
  );
  IF adoption.adoption_kind='directory_hub' AND current_snapshot IS NOT NULL THEN
    SELECT canonical_public_uuid_set(coalesce(array_agg(
      (entry->>'public_id')::uuid
    ),'{}'::uuid[])) INTO projected_ids
    FROM jsonb_array_elements(current_snapshot->'target_projection') entry
    WHERE entry->>'public_id' IS NOT NULL;
  END IF;
  RETURN current_target_generation IS NOT DISTINCT FROM
      adoption.expected_target_generation
    AND current_visibility_generation IS NOT DISTINCT FROM
      adoption.expected_visibility_generation
    AND pathless_publication_visibility_state_hash(
      resolved_resource_kind,adoption.source_document_id,adoption.public_id
    ) IS NOT DISTINCT FROM adoption.expected_visibility_state_hash
    AND current_snapshot IS NOT DISTINCT FROM adoption.source_snapshot
    AND current_fingerprint IS NOT DISTINCT FROM adoption.source_fingerprint
    AND EXISTS (
      SELECT 1 FROM public_resources resource
      WHERE resource.public_id=adoption.public_id
        AND resource.original_document_id=adoption.source_document_id
        AND resource.document_id=adoption.source_document_id
        AND resource.resource_kind=resolved_resource_kind
    )
    AND NOT (
      (adoption.adoption_kind<>'legacy_asset' AND EXISTS (
        SELECT 1 FROM page_publications publication
        WHERE publication.public_id=adoption.public_id
      ))
      OR (adoption.adoption_kind='legacy_asset' AND EXISTS (
        SELECT 1 FROM asset_publications publication
        WHERE publication.public_id=adoption.public_id
      ))
    )
    AND NOT (
      adoption.adoption_kind='legacy_page'
      AND pathless_publication_target_is_operational(
        adoption.source_document_id
      )
    )
    AND NOT EXISTS (
      SELECT 1 FROM blocking_public_namespace_conflicts conflict
      WHERE conflict.namespace_uuid=adoption.source_document_id
         OR conflict.namespace_uuid=adoption.source_revision_id
         OR conflict.namespace_uuid=adoption.public_id
         OR conflict.namespace_uuid=ANY(projected_ids)
    )
    AND NOT (
      adoption.adoption_kind='directory_hub' AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements(current_snapshot->'target_projection') entry
        WHERE entry->>'outcome'='namespace_conflict'
      )
    );
END;
$$;

CREATE FUNCTION begin_pathless_publication_adoption(
  p_adoption_id uuid,
  p_adoption_kind pathless_publication_adoption_kind,
  p_source_document_id uuid
) RETURNS TABLE (
  id uuid,
  adoption_kind pathless_publication_adoption_kind,
  source_document_id uuid,
  source_revision_id uuid,
  public_id uuid,
  candidate_artifact_id uuid,
  phase pathless_publication_adoption_phase
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
SET jit=off
AS $$
DECLARE
  stored pathless_publication_adoptions%ROWTYPE;
  resolved_resource_kind publication_target;
  mapped_public_id uuid;
  mapped_document_id uuid;
  source_snapshot jsonb;
  source_fingerprint text;
  resolved_source_revision_id uuid;
  visibility_generation bigint;
  visibility_hash text;
  target_generation bigint;
  projected_ids uuid[] := '{}'::uuid[];
  allocated_artifact_id uuid;
  allocated_object_key text;
  existing_plan_id uuid;
  attempt integer;
BEGIN
  IF p_adoption_id IS NULL OR p_adoption_kind IS NULL
     OR p_source_document_id IS NULL THEN
    RAISE EXCEPTION 'complete pathless adoption input is required'
      USING ERRCODE='22023';
  END IF;
  PERFORM pg_advisory_xact_lock_shared(
    hashtextextended('filesystem-hypermedia-corpus-transition',0)
  );
  SELECT * INTO stored FROM pathless_publication_adoptions
  WHERE pathless_publication_adoptions.id=p_adoption_id FOR UPDATE;
  IF FOUND THEN
    IF stored.adoption_kind IS DISTINCT FROM p_adoption_kind
       OR stored.source_document_id IS DISTINCT FROM p_source_document_id THEN
      RAISE EXCEPTION 'pathless adoption retry does not match'
        USING ERRCODE='23505';
    END IF;
    RETURN QUERY SELECT stored.id,stored.adoption_kind,
      stored.source_document_id,stored.source_revision_id,stored.public_id,
      stored.candidate_artifact_id,stored.phase;
    RETURN;
  END IF;

  PERFORM lock_pathless_publication_adoption_context(
    p_adoption_kind,p_source_document_id
  );
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'pathless-publication-adoption:'||p_adoption_id::text,0
  ));
  SELECT * INTO stored FROM pathless_publication_adoptions
  WHERE pathless_publication_adoptions.id=p_adoption_id FOR UPDATE;
  IF FOUND THEN
    IF stored.adoption_kind IS DISTINCT FROM p_adoption_kind
       OR stored.source_document_id IS DISTINCT FROM p_source_document_id THEN
      RAISE EXCEPTION 'pathless adoption retry does not match'
        USING ERRCODE='23505';
    END IF;
    RETURN QUERY SELECT stored.id,stored.adoption_kind,
      stored.source_document_id,stored.source_revision_id,stored.public_id,
      stored.candidate_artifact_id,stored.phase;
    RETURN;
  END IF;

  resolved_resource_kind := CASE p_adoption_kind
    WHEN 'legacy_asset' THEN 'asset'::publication_target
    ELSE 'page'::publication_target
  END;
  SELECT resource.public_id,resource.document_id
  INTO mapped_public_id,mapped_document_id
  FROM public_resources resource
  WHERE resource.original_document_id=p_source_document_id
    AND resource.resource_kind=resolved_resource_kind;
  IF mapped_public_id IS NULL
     OR mapped_document_id IS DISTINCT FROM p_source_document_id THEN
    RAISE EXCEPTION 'adoption requires an exact attached public mapping'
      USING ERRCODE='23514';
  END IF;
  IF (p_adoption_kind<>'legacy_asset' AND EXISTS (
      SELECT 1 FROM page_publications publication
      WHERE publication.public_id=mapped_public_id
    )) OR (p_adoption_kind='legacy_asset' AND EXISTS (
      SELECT 1 FROM asset_publications publication
      WHERE publication.public_id=mapped_public_id
    )) THEN
    RAISE EXCEPTION 'adoption cannot replace an active pathless publication'
      USING ERRCODE='23514';
  END IF;
  IF p_adoption_kind='legacy_page'
     AND pathless_publication_target_is_operational(p_source_document_id) THEN
    RAISE EXCEPTION 'only an exact directory hub may adopt operational knowledge'
      USING ERRCODE='23514';
  END IF;

  source_snapshot := pathless_publication_adoption_source_snapshot(
    p_adoption_kind,p_source_document_id,mapped_public_id
  );
  source_fingerprint := pathless_publication_adoption_source_fingerprint(
    p_adoption_kind,p_source_document_id,mapped_public_id
  );
  IF source_snapshot IS NULL OR source_fingerprint IS NULL THEN
    RAISE EXCEPTION 'adoption source proof is unavailable' USING ERRCODE='23514';
  END IF;
  resolved_source_revision_id := (source_snapshot->>'source_revision_id')::uuid;

  IF resolved_resource_kind='page' THEN
    PERFORM assert_pathless_public_metadata_safe(
      'page',source_snapshot->>'public_title',
      source_snapshot->>'public_summary',NULL
    );
    IF p_adoption_kind='directory_hub' THEN
      SELECT canonical_public_uuid_set(coalesce(array_agg(
        (entry->>'public_id')::uuid
      ),'{}'::uuid[])) INTO projected_ids
      FROM jsonb_array_elements(source_snapshot->'target_projection') entry
      WHERE entry->>'public_id' IS NOT NULL;
      IF EXISTS (
        SELECT 1
        FROM jsonb_array_elements(source_snapshot->'target_projection') entry
        WHERE entry->>'outcome'='namespace_conflict'
      ) THEN
        RAISE EXCEPTION 'directory hub projection has a namespace conflict'
          USING ERRCODE='23505';
      END IF;
    END IF;
  ELSE
    PERFORM assert_pathless_public_metadata_safe(
      'asset',NULL,NULL,source_snapshot->>'public_filename'
    );
    IF NOT pathless_public_metadata_is_safe(
         source_snapshot->>'public_content_type'
       ) OR length(source_snapshot->>'public_content_type')>255
       OR (source_snapshot->>'copy_source_body_size_bytes')::bigint>5000000000
       OR NOT pathless_public_duration_is_safe(
         (source_snapshot->>'public_duration_seconds')::numeric
       ) THEN
      RAISE EXCEPTION 'legacy asset metadata is not safely representable'
        USING ERRCODE='22023';
    END IF;
  END IF;

  SELECT generation.generation INTO target_generation
  FROM publication_target_generations generation
  WHERE generation.target_kind=resolved_resource_kind
    AND generation.target_document_id=p_source_document_id;
  SELECT generation.generation INTO visibility_generation
  FROM public_visibility_generations generation
  WHERE generation.public_id=mapped_public_id;
  IF target_generation IS NULL OR target_generation<=0
     OR visibility_generation IS NULL THEN
    RAISE EXCEPTION 'adoption CAS generation is unavailable'
      USING ERRCODE='23503';
  END IF;
  visibility_hash := pathless_publication_visibility_state_hash(
    resolved_resource_kind,p_source_document_id,mapped_public_id
  );

  IF EXISTS (
    SELECT 1 FROM blocking_public_namespace_conflicts conflict
    WHERE conflict.namespace_uuid=p_source_document_id
       OR conflict.namespace_uuid=resolved_source_revision_id
       OR conflict.namespace_uuid=mapped_public_id
       OR conflict.namespace_uuid=ANY(projected_ids)
  ) THEN
    RAISE EXCEPTION 'adoption source has an unresolved namespace conflict'
      USING ERRCODE='23505';
  END IF;
  PERFORM assert_public_uuid_available(
    mapped_public_id,p_source_document_id,resolved_resource_kind
  );

  SELECT prior.id INTO existing_plan_id
  FROM pathless_publication_adoptions prior
  WHERE prior.adoption_kind=p_adoption_kind
    AND prior.source_document_id=p_source_document_id
    AND prior.phase='planned'
  FOR UPDATE;
  IF existing_plan_id IS NOT NULL THEN
    IF pathless_publication_adoption_is_current(existing_plan_id) THEN
      RAISE EXCEPTION 'a current pathless adoption plan already exists'
        USING ERRCODE='23505';
    END IF;
    UPDATE pathless_publication_adoptions prior
    SET phase='superseded',superseded_at=now()
    WHERE prior.id=existing_plan_id AND prior.phase='planned';
  END IF;

  FOR attempt IN 1..32 LOOP
    allocated_artifact_id := gen_random_uuid();
    CONTINUE WHEN allocated_artifact_id IN (
      p_adoption_id,p_source_document_id,resolved_source_revision_id,
      mapped_public_id
    );
    allocated_object_key := CASE resolved_resource_kind
      WHEN 'page' THEN
        'documents/public/'||allocated_artifact_id::text||'.md'
      WHEN 'asset' THEN 'artifacts/public/'||allocated_artifact_id::text
    END;
    BEGIN
      PERFORM reserve_public_artifact_identity(
        allocated_artifact_id,allocated_object_key,
        'pathless_adoption',p_adoption_id
      );
      EXIT;
    EXCEPTION WHEN unique_violation THEN
      allocated_artifact_id := NULL;
    END;
  END LOOP;
  IF allocated_artifact_id IS NULL THEN
    RAISE EXCEPTION 'could not allocate a public adoption artifact UUID'
      USING ERRCODE='54000';
  END IF;

  INSERT INTO pathless_publication_adoptions(
    id,adoption_kind,source_document_id,source_revision_id,public_id,
    candidate_artifact_id,candidate_object_key,reservation_allocation_id,
    source_snapshot,source_fingerprint,expected_visibility_generation,
    expected_visibility_state_hash,expected_target_generation
  ) VALUES (
    p_adoption_id,p_adoption_kind,p_source_document_id,
    resolved_source_revision_id,
    mapped_public_id,allocated_artifact_id,allocated_object_key,p_adoption_id,
    source_snapshot,source_fingerprint,visibility_generation,visibility_hash,
    target_generation
  );
  RETURN QUERY SELECT p_adoption_id,p_adoption_kind,p_source_document_id,
    resolved_source_revision_id,mapped_public_id,allocated_artifact_id,
    'planned'::pathless_publication_adoption_phase;
END;
$$;

CREATE FUNCTION get_pathless_publication_adoption_write_target(
  p_adoption_id uuid
) RETURNS TABLE (
  adoption_id uuid,
  adoption_kind pathless_publication_adoption_kind,
  resource_kind publication_target,
  public_id uuid,
  artifact_id uuid,
  source_body_object_key text,
  source_body_size_bytes bigint,
  source_body_content_hash text,
  body_object_key text,
  max_body_size_bytes bigint,
  public_title text,
  public_summary text,
  public_last_edited_at text,
  public_filename text,
  public_content_type text,
  public_width integer,
  public_height integer,
  public_duration_seconds text,
  projected_target_public_ids uuid[],
  projection_receipt_hash text,
  target_projection jsonb
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
SET jit=off
SET TimeZone='UTC'
AS $$
DECLARE
  preliminary record;
  adoption record;
  snapshot jsonb;
  target_ids uuid[] := '{}'::uuid[];
  projected_ids uuid[] := '{}'::uuid[];
  receipt_hash text;
BEGIN
  IF p_adoption_id IS NULL THEN
    RAISE EXCEPTION 'adoption allocation is required' USING ERRCODE='22023';
  END IF;
  PERFORM pg_advisory_xact_lock_shared(
    hashtextextended('filesystem-hypermedia-corpus-transition',0)
  );
  SELECT stored.adoption_kind,stored.source_document_id
  INTO preliminary
  FROM pathless_publication_adoptions stored WHERE stored.id=p_adoption_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'pathless publication adoption not found'
      USING ERRCODE='P0002';
  END IF;
  PERFORM lock_pathless_publication_adoption_context(
    preliminary.adoption_kind,preliminary.source_document_id
  );
  SELECT stored.id,stored.adoption_kind,stored.source_document_id,
    stored.source_revision_id,stored.public_id,stored.candidate_artifact_id,
    stored.candidate_object_key,stored.source_snapshot,
    stored.source_fingerprint,stored.phase
  INTO adoption
  FROM pathless_publication_adoptions stored
  WHERE stored.id=p_adoption_id FOR UPDATE;
  IF adoption.adoption_kind IS DISTINCT FROM preliminary.adoption_kind
     OR adoption.source_document_id IS DISTINCT FROM
       preliminary.source_document_id THEN
    RAISE EXCEPTION 'pathless adoption changed while locking'
      USING ERRCODE='40001';
  END IF;
  IF adoption.phase<>'planned' OR EXISTS (
    SELECT 1 FROM pathless_publication_adoption_staging staging
    WHERE staging.adoption_id=adoption.id
  ) OR NOT pathless_publication_adoption_is_current(adoption.id) THEN
    RAISE EXCEPTION 'pathless adoption object write is no longer pending'
      USING ERRCODE='55000';
  END IF;
  snapshot := adoption.source_snapshot;
  IF adoption.adoption_kind='directory_hub' THEN
    SELECT canonical_public_uuid_set(coalesce(array_agg(value::uuid),
      '{}'::uuid[])) INTO target_ids
    FROM jsonb_array_elements_text(snapshot->'target_document_ids') value;
    SELECT canonical_public_uuid_set(coalesce(array_agg(
      (entry->>'public_id')::uuid
    ),'{}'::uuid[])) INTO projected_ids
    FROM jsonb_array_elements(snapshot->'target_projection') entry
    WHERE entry->>'public_id' IS NOT NULL;
  END IF;
  receipt_hash := pathless_publication_adoption_frozen_receipt_hash(
    adoption.source_fingerprint,target_ids,
    coalesce(snapshot->'target_projection','[]'::jsonb)
  );

  RETURN QUERY SELECT
    adoption.id,adoption.adoption_kind,
    CASE adoption.adoption_kind WHEN 'legacy_asset'
      THEN 'asset'::publication_target ELSE 'page'::publication_target END,
    adoption.public_id,adoption.candidate_artifact_id,
    snapshot->>'copy_source_body_object_key',
    (snapshot->>'copy_source_body_size_bytes')::bigint,
    snapshot->>'copy_source_body_content_hash',adoption.candidate_object_key,
    CASE adoption.adoption_kind WHEN 'legacy_asset'
      THEN 5000000000::bigint ELSE 4000000::bigint END,
    snapshot->>'public_title',snapshot->>'public_summary',
    CASE WHEN snapshot->>'public_last_edited_at' IS NULL THEN NULL::text
      ELSE to_char(
        (snapshot->>'public_last_edited_at')::timestamptz AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      ) END,
    snapshot->>'public_filename',snapshot->>'public_content_type',
    (snapshot->>'public_width')::integer,
    (snapshot->>'public_height')::integer,
    snapshot->>'public_duration_seconds',projected_ids,receipt_hash,
    coalesce(snapshot->'target_projection','[]'::jsonb);
END;
$$;

CREATE FUNCTION stage_pathless_publication_adoption(
  p_adoption_id uuid,
  p_adoption_kind pathless_publication_adoption_kind,
  p_body_size_bytes bigint,
  p_body_content_hash text,
  p_public_title text,
  p_public_summary text,
  p_public_last_edited_at timestamptz,
  p_public_filename text,
  p_public_content_type text,
  p_public_width integer,
  p_public_height integer,
  p_public_duration_seconds text,
  p_projected_target_public_ids uuid[],
  p_observed_public_uuid_tokens uuid[],
  p_projection_receipt_hash text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
SET jit=off
SET TimeZone='UTC'
AS $$
DECLARE
  preliminary record;
  adoption pathless_publication_adoptions%ROWTYPE;
  existing pathless_publication_adoption_staging%ROWTYPE;
  snapshot jsonb;
  resource_kind publication_target;
  source_revision_id uuid;
  target_ids uuid[] := '{}'::uuid[];
  projected_ids uuid[] := '{}'::uuid[];
  expected_receipt_hash text;
  expected_token text;
  duration_value numeric;
BEGIN
  IF p_adoption_id IS NULL OR p_adoption_kind IS NULL
     OR p_body_size_bytes IS NULL OR p_body_size_bytes<0
     OR p_body_content_hash IS NULL
     OR p_body_content_hash !~ '^[a-f0-9]{64}$'
     OR p_projected_target_public_ids IS NULL
     OR p_observed_public_uuid_tokens IS NULL
     OR p_projection_receipt_hash IS NULL
     OR p_projection_receipt_hash !~ '^[a-f0-9]{64}$'
     OR canonical_public_uuid_set(p_projected_target_public_ids)
          IS DISTINCT FROM p_projected_target_public_ids
     OR canonical_public_uuid_set(p_observed_public_uuid_tokens)
          IS DISTINCT FROM p_observed_public_uuid_tokens THEN
    RAISE EXCEPTION 'complete canonical adoption artifact receipt is required'
      USING ERRCODE='22023';
  END IF;
  IF p_public_duration_seconds IS NOT NULL THEN
    IF length(p_public_duration_seconds)>1024
       OR p_public_duration_seconds !~ '^(0|[1-9][0-9]*)([.][0-9]+)?$' THEN
      RAISE EXCEPTION 'public duration must be an exact canonical decimal'
        USING ERRCODE='22023';
    END IF;
    duration_value := p_public_duration_seconds::numeric;
    IF NOT pathless_public_duration_is_safe(duration_value)
       OR duration_value::text IS DISTINCT FROM p_public_duration_seconds THEN
      RAISE EXCEPTION 'public duration is not losslessly representable'
        USING ERRCODE='22023';
    END IF;
  END IF;

  SELECT stored.adoption_kind,stored.source_document_id,stored.source_revision_id,
    stored.public_id,stored.candidate_artifact_id,stored.candidate_object_key,
    stored.source_snapshot,stored.source_fingerprint
  INTO preliminary
  FROM pathless_publication_adoptions stored WHERE stored.id=p_adoption_id;
  IF NOT FOUND OR preliminary.adoption_kind IS DISTINCT FROM p_adoption_kind THEN
    RAISE EXCEPTION 'pathless publication adoption not found'
      USING ERRCODE='P0002';
  END IF;
  snapshot := preliminary.source_snapshot;
  resource_kind := CASE p_adoption_kind WHEN 'legacy_asset'
    THEN 'asset'::publication_target ELSE 'page'::publication_target END;
  source_revision_id := preliminary.source_revision_id;
  IF p_adoption_kind='directory_hub' THEN
    SELECT canonical_public_uuid_set(coalesce(array_agg(value::uuid),
      '{}'::uuid[])) INTO target_ids
    FROM jsonb_array_elements_text(snapshot->'target_document_ids') value;
    SELECT canonical_public_uuid_set(coalesce(array_agg(
      (entry->>'public_id')::uuid
    ),'{}'::uuid[])) INTO projected_ids
    FROM jsonb_array_elements(snapshot->'target_projection') entry
    WHERE entry->>'public_id' IS NOT NULL;
  END IF;
  expected_receipt_hash := pathless_publication_adoption_frozen_receipt_hash(
    preliminary.source_fingerprint,target_ids,
    coalesce(snapshot->'target_projection','[]'::jsonb)
  );
  expected_token := pathless_publication_representation_token(
    jsonb_build_object(
      'adoption_kind',p_adoption_kind,
      'resource_kind',resource_kind,
      'public_id',preliminary.public_id,
      'artifact_id',preliminary.candidate_artifact_id,
      'source_fingerprint',preliminary.source_fingerprint,
      'body_object_key',preliminary.candidate_object_key,
      'body_size_bytes',p_body_size_bytes,
      'body_content_hash',p_body_content_hash,
      'public_title',p_public_title,
      'public_summary',p_public_summary,
      'public_last_edited_at',p_public_last_edited_at,
      'public_filename',p_public_filename,
      'public_content_type',p_public_content_type,
      'public_width',p_public_width,
      'public_height',p_public_height,
      'public_duration_seconds',p_public_duration_seconds,
      'projected_target_public_ids',p_projected_target_public_ids,
      'observed_public_uuid_tokens',p_observed_public_uuid_tokens,
      'projection_receipt_hash',p_projection_receipt_hash
    )
  );

  SELECT * INTO existing
  FROM pathless_publication_adoption_staging staging
  WHERE staging.adoption_id=p_adoption_id;
  IF FOUND THEN
    IF existing.adoption_kind IS DISTINCT FROM p_adoption_kind
       OR existing.resource_kind IS DISTINCT FROM resource_kind
       OR existing.source_document_id IS DISTINCT FROM
         preliminary.source_document_id
       OR existing.source_revision_id IS DISTINCT FROM source_revision_id
       OR existing.public_id IS DISTINCT FROM preliminary.public_id
       OR existing.artifact_id IS DISTINCT FROM preliminary.candidate_artifact_id
       OR existing.body_object_key IS DISTINCT FROM preliminary.candidate_object_key
       OR existing.body_size_bytes IS DISTINCT FROM p_body_size_bytes
       OR existing.body_content_hash IS DISTINCT FROM p_body_content_hash
       OR existing.public_title IS DISTINCT FROM p_public_title
       OR existing.public_summary IS DISTINCT FROM p_public_summary
       OR existing.public_last_edited_at IS DISTINCT FROM p_public_last_edited_at
       OR existing.public_filename IS DISTINCT FROM p_public_filename
       OR existing.public_content_type IS DISTINCT FROM p_public_content_type
       OR existing.public_width IS DISTINCT FROM p_public_width
       OR existing.public_height IS DISTINCT FROM p_public_height
       OR existing.public_duration_seconds::text IS DISTINCT FROM
         p_public_duration_seconds
       OR existing.projected_target_public_ids IS DISTINCT FROM
         p_projected_target_public_ids
       OR existing.observed_public_uuid_tokens IS DISTINCT FROM
         p_observed_public_uuid_tokens
       OR existing.projection_receipt_hash IS DISTINCT FROM
         p_projection_receipt_hash
       OR existing.representation_token IS DISTINCT FROM expected_token THEN
      RAISE EXCEPTION 'adoption staging retry does not match'
        USING ERRCODE='23505';
    END IF;
    RETURN;
  END IF;

  PERFORM lock_pathless_publication_adoption_context(
    p_adoption_kind,preliminary.source_document_id
  );
  SELECT * INTO adoption FROM pathless_publication_adoptions stored
  WHERE stored.id=p_adoption_id FOR UPDATE;
  IF adoption.adoption_kind IS DISTINCT FROM p_adoption_kind
     OR adoption.source_document_id IS DISTINCT FROM
       preliminary.source_document_id
     OR adoption.source_revision_id IS DISTINCT FROM
       preliminary.source_revision_id
     OR adoption.public_id IS DISTINCT FROM preliminary.public_id
     OR adoption.candidate_artifact_id IS DISTINCT FROM
       preliminary.candidate_artifact_id
     OR adoption.candidate_object_key IS DISTINCT FROM
       preliminary.candidate_object_key
     OR adoption.source_snapshot IS DISTINCT FROM preliminary.source_snapshot
     OR adoption.source_fingerprint IS DISTINCT FROM
       preliminary.source_fingerprint THEN
    RAISE EXCEPTION 'pathless adoption changed while locking'
      USING ERRCODE='40001';
  END IF;
  SELECT * INTO existing
  FROM pathless_publication_adoption_staging staging
  WHERE staging.adoption_id=p_adoption_id;
  IF FOUND THEN
    IF existing.adoption_kind IS DISTINCT FROM p_adoption_kind
       OR existing.resource_kind IS DISTINCT FROM resource_kind
       OR existing.source_document_id IS DISTINCT FROM
         preliminary.source_document_id
       OR existing.source_revision_id IS DISTINCT FROM
         preliminary.source_revision_id
       OR existing.public_id IS DISTINCT FROM preliminary.public_id
       OR existing.artifact_id IS DISTINCT FROM
         preliminary.candidate_artifact_id
       OR existing.body_object_key IS DISTINCT FROM
         preliminary.candidate_object_key
       OR existing.allocation_kind<>'pathless_adoption'
       OR existing.allocation_id IS DISTINCT FROM p_adoption_id
       OR existing.representation_token IS DISTINCT FROM expected_token
       OR existing.body_size_bytes IS DISTINCT FROM p_body_size_bytes
       OR existing.body_content_hash IS DISTINCT FROM p_body_content_hash
       OR existing.public_title IS DISTINCT FROM p_public_title
       OR existing.public_summary IS DISTINCT FROM p_public_summary
       OR existing.public_last_edited_at IS DISTINCT FROM p_public_last_edited_at
       OR existing.public_filename IS DISTINCT FROM p_public_filename
       OR existing.public_content_type IS DISTINCT FROM p_public_content_type
       OR existing.public_width IS DISTINCT FROM p_public_width
       OR existing.public_height IS DISTINCT FROM p_public_height
       OR existing.public_duration_seconds::text IS DISTINCT FROM
         p_public_duration_seconds
       OR existing.projected_target_public_ids IS DISTINCT FROM
         p_projected_target_public_ids
       OR existing.observed_public_uuid_tokens IS DISTINCT FROM
         p_observed_public_uuid_tokens
       OR existing.projection_receipt_hash IS DISTINCT FROM
         p_projection_receipt_hash THEN
      RAISE EXCEPTION 'adoption staging retry does not match'
        USING ERRCODE='23505';
    END IF;
    RETURN;
  END IF;
  IF NOT pathless_publication_adoption_is_current(adoption.id) THEN
    RAISE EXCEPTION 'pathless adoption source changed before staging'
      USING ERRCODE='40001';
  END IF;

  IF resource_kind='page' THEN
    PERFORM assert_pathless_public_metadata_safe(
      'page',p_public_title,p_public_summary,NULL
    );
    IF p_body_size_bytes>4000000
       OR p_public_title IS DISTINCT FROM snapshot->>'public_title'
       OR p_public_summary IS DISTINCT FROM snapshot->>'public_summary'
       OR p_public_last_edited_at IS DISTINCT FROM
         (snapshot->>'public_last_edited_at')::timestamptz
       OR p_public_filename IS NOT NULL OR p_public_content_type IS NOT NULL
       OR p_public_width IS NOT NULL OR p_public_height IS NOT NULL
       OR p_public_duration_seconds IS NOT NULL
       OR p_projected_target_public_ids IS DISTINCT FROM projected_ids
       OR p_observed_public_uuid_tokens IS DISTINCT FROM projected_ids
       OR p_projection_receipt_hash IS DISTINCT FROM expected_receipt_hash THEN
      RAISE EXCEPTION 'page adoption receipt is not exact'
        USING ERRCODE='23514';
    END IF;
    IF p_adoption_kind='legacy_page' AND (
      p_body_size_bytes IS DISTINCT FROM
        (snapshot->>'copy_source_body_size_bytes')::bigint
      OR p_body_content_hash IS DISTINCT FROM
        snapshot->>'copy_source_body_content_hash'
    ) THEN
      RAISE EXCEPTION 'legacy page adoption must copy the exact active artifact'
        USING ERRCODE='23514';
    ELSIF p_adoption_kind='directory_hub'
       AND p_body_content_hash IS NOT DISTINCT FROM
         snapshot->>'copy_source_body_content_hash' THEN
      RAISE EXCEPTION 'directory hub requires separately projected public bytes'
        USING ERRCODE='23514';
    END IF;
  ELSE
    PERFORM assert_pathless_public_metadata_safe(
      'asset',NULL,NULL,p_public_filename
    );
    IF p_body_size_bytes>5000000000
       OR p_body_size_bytes IS DISTINCT FROM
         (snapshot->>'copy_source_body_size_bytes')::bigint
       OR p_body_content_hash IS DISTINCT FROM
         snapshot->>'copy_source_body_content_hash'
       OR p_public_title IS NOT NULL OR p_public_summary IS NOT NULL
       OR p_public_last_edited_at IS NOT NULL
       OR p_public_filename IS DISTINCT FROM snapshot->>'public_filename'
       OR p_public_content_type IS DISTINCT FROM
         snapshot->>'public_content_type'
       OR p_public_width IS DISTINCT FROM
         (snapshot->>'public_width')::integer
       OR p_public_height IS DISTINCT FROM
         (snapshot->>'public_height')::integer
       OR p_public_duration_seconds IS DISTINCT FROM
         snapshot->>'public_duration_seconds'
       OR cardinality(p_projected_target_public_ids)<>0
       OR cardinality(p_observed_public_uuid_tokens)<>0
       OR p_projection_receipt_hash IS DISTINCT FROM expected_receipt_hash THEN
      RAISE EXCEPTION 'asset adoption receipt is not exact'
        USING ERRCODE='23514';
    END IF;
  END IF;

  PERFORM reserve_public_representation_token(
    expected_token,adoption.candidate_artifact_id,resource_kind
  );
  INSERT INTO pathless_publication_adoption_staging(
    adoption_id,adoption_kind,resource_kind,source_document_id,
    source_revision_id,public_id,artifact_id,body_object_key,
    body_size_bytes,body_content_hash,public_title,public_summary,
    public_last_edited_at,public_filename,public_content_type,public_width,
    public_height,public_duration_seconds,projected_target_public_ids,
    observed_public_uuid_tokens,projection_receipt_hash,representation_token,
    allocation_id
  ) VALUES (
    adoption.id,adoption.adoption_kind,resource_kind,
    adoption.source_document_id,adoption.source_revision_id,
    adoption.public_id,adoption.candidate_artifact_id,
    adoption.candidate_object_key,p_body_size_bytes,p_body_content_hash,
    p_public_title,p_public_summary,p_public_last_edited_at,p_public_filename,
    p_public_content_type,p_public_width,p_public_height,duration_value,
    p_projected_target_public_ids,p_observed_public_uuid_tokens,
    p_projection_receipt_hash,expected_token,adoption.id
  );
END;
$$;

CREATE FUNCTION assert_pathless_publication_adoption_staging_exact(
  p_adoption_id uuid
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
SET jit=off
SET TimeZone='UTC'
AS $$
DECLARE
  adoption pathless_publication_adoptions%ROWTYPE;
  staging pathless_publication_adoption_staging%ROWTYPE;
  snapshot jsonb;
  target_ids uuid[] := '{}'::uuid[];
  expected_projected_ids uuid[] := '{}'::uuid[];
  expected_receipt_hash text;
  expected_token text;
BEGIN
  SELECT * INTO adoption FROM pathless_publication_adoptions
  WHERE id=p_adoption_id;
  SELECT * INTO staging FROM pathless_publication_adoption_staging
  WHERE adoption_id=p_adoption_id;
  IF adoption.id IS NULL OR staging.adoption_id IS NULL THEN
    RAISE EXCEPTION 'pathless adoption artifact is not staged'
      USING ERRCODE='55000';
  END IF;
  snapshot := adoption.source_snapshot;
  IF adoption.adoption_kind='directory_hub' THEN
    SELECT canonical_public_uuid_set(coalesce(array_agg(value::uuid),
      '{}'::uuid[])) INTO target_ids
    FROM jsonb_array_elements_text(snapshot->'target_document_ids') value;
    SELECT canonical_public_uuid_set(coalesce(array_agg(
      (entry->>'public_id')::uuid
    ),'{}'::uuid[])) INTO expected_projected_ids
    FROM jsonb_array_elements(snapshot->'target_projection') entry
    WHERE entry->>'public_id' IS NOT NULL;
  END IF;
  expected_receipt_hash := pathless_publication_adoption_frozen_receipt_hash(
    adoption.source_fingerprint,target_ids,
    coalesce(snapshot->'target_projection','[]'::jsonb)
  );
  expected_token := pathless_publication_representation_token(
    jsonb_build_object(
      'adoption_kind',adoption.adoption_kind,
      'resource_kind',staging.resource_kind,
      'public_id',adoption.public_id,
      'artifact_id',adoption.candidate_artifact_id,
      'source_fingerprint',adoption.source_fingerprint,
      'body_object_key',adoption.candidate_object_key,
      'body_size_bytes',staging.body_size_bytes,
      'body_content_hash',staging.body_content_hash,
      'public_title',staging.public_title,
      'public_summary',staging.public_summary,
      'public_last_edited_at',staging.public_last_edited_at,
      'public_filename',staging.public_filename,
      'public_content_type',staging.public_content_type,
      'public_width',staging.public_width,
      'public_height',staging.public_height,
      'public_duration_seconds',staging.public_duration_seconds::text,
      'projected_target_public_ids',staging.projected_target_public_ids,
      'observed_public_uuid_tokens',staging.observed_public_uuid_tokens,
      'projection_receipt_hash',staging.projection_receipt_hash
    )
  );
  IF staging.adoption_kind IS DISTINCT FROM adoption.adoption_kind
     OR staging.resource_kind IS DISTINCT FROM (CASE adoption.adoption_kind
       WHEN 'legacy_asset' THEN 'asset'::publication_target
       ELSE 'page'::publication_target END)
     OR staging.source_document_id IS DISTINCT FROM adoption.source_document_id
     OR staging.source_revision_id IS DISTINCT FROM adoption.source_revision_id
     OR staging.public_id IS DISTINCT FROM adoption.public_id
     OR staging.artifact_id IS DISTINCT FROM adoption.candidate_artifact_id
     OR staging.body_object_key IS DISTINCT FROM adoption.candidate_object_key
     OR staging.allocation_kind<>'pathless_adoption'
     OR staging.allocation_id IS DISTINCT FROM adoption.id
     OR staging.projected_target_public_ids IS DISTINCT FROM expected_projected_ids
     OR staging.observed_public_uuid_tokens IS DISTINCT FROM expected_projected_ids
     OR staging.projection_receipt_hash IS DISTINCT FROM expected_receipt_hash
     OR staging.representation_token IS DISTINCT FROM expected_token
     OR NOT EXISTS (
       SELECT 1 FROM public_representation_token_reservations reservation
       WHERE reservation.representation_token=staging.representation_token
         AND reservation.artifact_id=staging.artifact_id
         AND reservation.resource_kind=staging.resource_kind
     ) THEN
    RAISE EXCEPTION 'pathless adoption staging evidence is not exact'
      USING ERRCODE='23514';
  END IF;

  IF staging.resource_kind='page' THEN
    PERFORM assert_pathless_public_metadata_safe(
      'page',staging.public_title,staging.public_summary,NULL
    );
    IF staging.body_size_bytes>4000000
       OR staging.public_title IS DISTINCT FROM snapshot->>'public_title'
       OR staging.public_summary IS DISTINCT FROM snapshot->>'public_summary'
       OR staging.public_last_edited_at IS DISTINCT FROM
         (snapshot->>'public_last_edited_at')::timestamptz
       OR staging.public_filename IS NOT NULL
       OR staging.public_content_type IS NOT NULL
       OR staging.public_width IS NOT NULL OR staging.public_height IS NOT NULL
       OR staging.public_duration_seconds IS NOT NULL THEN
      RAISE EXCEPTION 'pathless page adoption staging is not exact'
        USING ERRCODE='23514';
    END IF;
    IF adoption.adoption_kind='legacy_page' AND (
      staging.body_size_bytes IS DISTINCT FROM
        (snapshot->>'copy_source_body_size_bytes')::bigint
      OR staging.body_content_hash IS DISTINCT FROM
        snapshot->>'copy_source_body_content_hash'
    ) THEN
      RAISE EXCEPTION 'legacy page adoption staging source is not exact'
        USING ERRCODE='23514';
    ELSIF adoption.adoption_kind='directory_hub'
       AND staging.body_content_hash IS NOT DISTINCT FROM
         snapshot->>'copy_source_body_content_hash' THEN
      RAISE EXCEPTION 'directory hub staging reused its private projection'
        USING ERRCODE='23514';
    END IF;
  ELSE
    PERFORM assert_pathless_public_metadata_safe(
      'asset',NULL,NULL,staging.public_filename
    );
    IF staging.body_size_bytes>5000000000
       OR staging.body_size_bytes IS DISTINCT FROM
         (snapshot->>'copy_source_body_size_bytes')::bigint
       OR staging.body_content_hash IS DISTINCT FROM
         snapshot->>'copy_source_body_content_hash'
       OR staging.public_title IS NOT NULL OR staging.public_summary IS NOT NULL
       OR staging.public_last_edited_at IS NOT NULL
       OR staging.public_filename IS DISTINCT FROM snapshot->>'public_filename'
       OR staging.public_content_type IS DISTINCT FROM
         snapshot->>'public_content_type'
       OR staging.public_width IS DISTINCT FROM
         (snapshot->>'public_width')::integer
       OR staging.public_height IS DISTINCT FROM
         (snapshot->>'public_height')::integer
       OR staging.public_duration_seconds::text IS DISTINCT FROM
         snapshot->>'public_duration_seconds' THEN
      RAISE EXCEPTION 'pathless asset adoption staging is not exact'
        USING ERRCODE='23514';
    END IF;
  END IF;
END;
$$;

CREATE FUNCTION apply_pathless_publication_adoption(
  p_adoption_id uuid
) RETURNS pathless_publication_adoption_phase
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
SET jit=off
SET TimeZone='UTC'
AS $$
DECLARE
  preliminary record;
  adoption pathless_publication_adoptions%ROWTYPE;
  staging pathless_publication_adoption_staging%ROWTYPE;
  snapshot jsonb;
  namespace_ids uuid[];
  namespace_id uuid;
BEGIN
  IF p_adoption_id IS NULL THEN
    RAISE EXCEPTION 'adoption allocation is required' USING ERRCODE='22023';
  END IF;
  PERFORM pg_advisory_xact_lock_shared(
    hashtextextended('filesystem-hypermedia-corpus-transition',0)
  );
  SELECT stored.adoption_kind,stored.source_document_id,stored.phase
  INTO preliminary
  FROM pathless_publication_adoptions stored WHERE stored.id=p_adoption_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'pathless publication adoption not found'
      USING ERRCODE='P0002';
  END IF;
  IF preliminary.phase='applied' THEN RETURN 'applied'; END IF;
  IF preliminary.phase='superseded' THEN RETURN 'superseded'; END IF;

  BEGIN
    PERFORM lock_pathless_publication_adoption_context(
      preliminary.adoption_kind,preliminary.source_document_id
    );
  EXCEPTION WHEN serialization_failure OR foreign_key_violation
    OR check_violation OR no_data_found THEN
    UPDATE pathless_publication_adoptions
    SET phase='superseded',superseded_at=now()
    WHERE id=p_adoption_id AND phase='planned';
    RETURN 'superseded';
  END;
  SELECT * INTO adoption FROM pathless_publication_adoptions stored
  WHERE stored.id=p_adoption_id FOR UPDATE;
  IF adoption.adoption_kind IS DISTINCT FROM preliminary.adoption_kind
     OR adoption.source_document_id IS DISTINCT FROM
       preliminary.source_document_id THEN
    RAISE EXCEPTION 'pathless adoption changed while locking'
      USING ERRCODE='40001';
  END IF;
  IF adoption.phase='applied' THEN RETURN 'applied'; END IF;
  IF adoption.phase='superseded' THEN RETURN 'superseded'; END IF;
  IF NOT pathless_publication_adoption_is_current(adoption.id) THEN
    UPDATE pathless_publication_adoptions
    SET phase='superseded',superseded_at=now()
    WHERE id=adoption.id AND phase='planned';
    RETURN 'superseded';
  END IF;

  SELECT * INTO staging
  FROM pathless_publication_adoption_staging stored
  WHERE stored.adoption_id=adoption.id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'pathless adoption artifact is not staged'
      USING ERRCODE='55000';
  END IF;
  PERFORM assert_pathless_publication_adoption_staging_exact(adoption.id);
  snapshot := adoption.source_snapshot;

  SELECT canonical_public_uuid_set(array_agg(value)) INTO namespace_ids
  FROM (
    SELECT adoption.public_id AS value
    UNION ALL SELECT adoption.candidate_artifact_id
    UNION ALL SELECT unnest(staging.projected_target_public_ids)
  ) namespace;
  FOREACH namespace_id IN ARRAY namespace_ids LOOP
    PERFORM lock_public_uuid_namespace(namespace_id);
  END LOOP;
  IF NOT pathless_publication_adoption_is_current(adoption.id)
     OR EXISTS (
       SELECT 1 FROM blocking_public_namespace_conflicts conflict
       WHERE conflict.namespace_uuid=adoption.source_document_id
          OR conflict.namespace_uuid=adoption.source_revision_id
          OR conflict.namespace_uuid=adoption.public_id
          OR conflict.namespace_uuid=adoption.candidate_artifact_id
          OR conflict.namespace_uuid=ANY(staging.projected_target_public_ids)
     ) THEN
    UPDATE pathless_publication_adoptions
    SET phase='superseded',superseded_at=now()
    WHERE id=adoption.id AND phase='planned';
    RETURN 'superseded';
  END IF;
  PERFORM assert_public_uuid_available(
    adoption.public_id,adoption.source_document_id,staging.resource_kind
  );
  IF NOT EXISTS (
    SELECT 1 FROM public_artifact_id_reservations reservation
    WHERE reservation.artifact_id=adoption.candidate_artifact_id
      AND reservation.body_object_key=adoption.candidate_object_key
      AND reservation.allocation_kind='pathless_adoption'
      AND reservation.allocation_id=adoption.id
  ) THEN
    RAISE EXCEPTION 'pathless adoption artifact reservation changed'
      USING ERRCODE='23514';
  END IF;

  IF staging.resource_kind='page' THEN
    INSERT INTO public_page_artifacts(
      artifact_id,public_id,source_document_id,source_revision_id,
      source_body_size_bytes,source_body_content_hash,body_object_key,
      body_size_bytes,body_content_hash,public_title,public_summary,
      public_last_edited_at,projected_target_public_ids,
      observed_public_uuid_tokens,projection_receipt_hash,origin,
      source_adoption_id,source_adoption_kind,legacy_source_artifact_id,
      legacy_projection_generation,representation_token,
      reservation_allocation_kind,reservation_allocation_id
    ) VALUES (
      staging.artifact_id,staging.public_id,staging.source_document_id,
      staging.source_revision_id,
      (snapshot->>'source_revision_body_size_bytes')::integer,
      snapshot->>'source_revision_body_content_hash',staging.body_object_key,
      staging.body_size_bytes::integer,staging.body_content_hash,
      staging.public_title,staging.public_summary,staging.public_last_edited_at,
      staging.projected_target_public_ids,staging.observed_public_uuid_tokens,
      staging.projection_receipt_hash,
      CASE adoption.adoption_kind WHEN 'legacy_page'
        THEN 'legacy_adoption'::public_artifact_origin
        ELSE 'directory_hub_promotion'::public_artifact_origin END,
      adoption.id,adoption.adoption_kind,
      CASE adoption.adoption_kind WHEN 'legacy_page'
        THEN (snapshot->>'legacy_source_artifact_id')::uuid ELSE NULL END,
      CASE adoption.adoption_kind WHEN 'legacy_page'
        THEN (snapshot->>'legacy_projection_generation')::bigint ELSE NULL END,
      staging.representation_token,'pathless_adoption',adoption.id
    );
    INSERT INTO page_publications(public_id,artifact_id)
    VALUES (staging.public_id,staging.artifact_id);
  ELSE
    INSERT INTO public_asset_artifacts(
      artifact_id,public_id,source_document_id,body_object_key,
      body_size_bytes,body_content_hash,public_filename,public_content_type,
      public_width,public_height,public_duration_seconds,origin,
      source_adoption_id,source_adoption_kind,representation_token,
      reservation_allocation_kind,reservation_allocation_id
    ) VALUES (
      staging.artifact_id,staging.public_id,staging.source_document_id,
      staging.body_object_key,staging.body_size_bytes,
      staging.body_content_hash,staging.public_filename,
      staging.public_content_type,staging.public_width,staging.public_height,
      staging.public_duration_seconds,'legacy_adoption',adoption.id,
      adoption.adoption_kind,staging.representation_token,
      'pathless_adoption',adoption.id
    );
    INSERT INTO asset_publications(public_id,artifact_id)
    VALUES (staging.public_id,staging.artifact_id);
  END IF;
  UPDATE pathless_publication_adoptions
  SET phase='applied',applied_at=now()
  WHERE id=adoption.id AND phase='planned';
  RETURN 'applied';
END;
$$;

-- Adoption sources and immutable staging are never raw corpus tables. The
-- corpus login can plan/apply through checked definers; only storage can
-- translate a stable allocation into source/destination object locations.
GRANT SELECT,INSERT ON pathless_publication_adoptions
  TO context_use_boundary_owner;
GRANT UPDATE (id,phase,applied_at,superseded_at)
  ON pathless_publication_adoptions TO context_use_boundary_owner;
GRANT SELECT,INSERT ON pathless_publication_adoption_staging
  TO context_use_boundary_owner;
GRANT UPDATE (adoption_id) ON pathless_publication_adoption_staging
  TO context_use_boundary_owner;
GRANT SELECT (adoption_id) ON pathless_publication_adoption_staging
  TO context_use_pathless_storage_owner;
GRANT SELECT (
  id,adoption_kind,source_document_id,source_revision_id,public_id,
  candidate_artifact_id,candidate_object_key,source_snapshot,
  source_fingerprint,phase
) ON pathless_publication_adoptions TO context_use_pathless_storage_owner;
GRANT UPDATE (id) ON pathless_publication_adoptions
  TO context_use_pathless_storage_owner;
GRANT SELECT (singleton,generation) ON public_projection_state
  TO context_use_pathless_storage_owner;
GRANT SELECT (
  page_id,version_id,projection_generation,artifact_id,body_object_key,
  body_size_bytes,body_content_hash
) ON published_page_artifacts TO context_use_pathless_storage_owner;
GRANT SELECT (
  directory_id,document_id,migration_run_id,legacy_path,temporary_path,
  private_revision_id,public_revision_id,public_id,
  private_projection_fingerprint,public_projection_fingerprint
) ON directory_hub_migrations TO context_use_pathless_storage_owner;
GRANT SELECT (id,phase) ON corpus_migration_runs
  TO context_use_pathless_storage_owner;
GRANT SELECT (
  run_id,item_kind,item_id,source_fingerprint,result_kind,
  output_document_id,output_revision_id,details
) ON corpus_migration_completions TO context_use_pathless_storage_owner;
GRANT SELECT (public_id,document_id,original_document_id,resource_kind)
  ON public_resources TO context_use_pathless_storage_owner;
GRANT SELECT (current_path,published_version_id,public_path)
  ON knowledge_pages TO context_use_pathless_storage_owner;
GRANT SELECT (public_path) ON assets TO context_use_pathless_storage_owner;
GRANT SELECT (links_indexed_at) ON hypermedia_document_revisions
  TO context_use_pathless_storage_owner;

-- The adoption apply boundary uses the ordinary immutable artifact insert
-- surface plus the adoption-only lineage columns added in 028.
GRANT INSERT (
  source_adoption_id,source_adoption_kind,legacy_source_artifact_id,
  legacy_projection_generation
) ON public_page_artifacts TO context_use_boundary_owner;
GRANT INSERT (source_adoption_id,source_adoption_kind)
  ON public_asset_artifacts TO context_use_boundary_owner;

GRANT SELECT (adoption_id) ON pathless_publication_adoption_staging
  TO context_use_reset_owner;
GRANT SELECT ON pathless_publication_adoption_staging TO context_use_backup;

REVOKE ALL ON FUNCTION guard_pathless_publication_adoption_history()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION guard_pathless_publication_adoption_staging_history()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION pathless_publication_hub_target_ids(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION pathless_publication_adoption_projection_plan(
  uuid,uuid,uuid[]
) FROM PUBLIC;
REVOKE ALL ON FUNCTION pathless_publication_adoption_projected_target_ids(
  uuid,uuid,uuid[]
) FROM PUBLIC;
REVOKE ALL ON FUNCTION pathless_publication_adoption_frozen_receipt_hash(
  text,uuid[],jsonb
) FROM PUBLIC;
REVOKE ALL ON FUNCTION pathless_publication_adoption_projection_receipt_hash(
  text,uuid,uuid,uuid[]
) FROM PUBLIC;
REVOKE ALL ON FUNCTION pathless_publication_adoption_source_snapshot(
  pathless_publication_adoption_kind,uuid,uuid
) FROM PUBLIC;
REVOKE ALL ON FUNCTION pathless_publication_adoption_source_fingerprint(
  pathless_publication_adoption_kind,uuid,uuid
) FROM PUBLIC;
REVOKE ALL ON FUNCTION lock_pathless_publication_adoption_context(
  pathless_publication_adoption_kind,uuid
) FROM PUBLIC;
REVOKE ALL ON FUNCTION pathless_publication_adoption_is_current(uuid)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION begin_pathless_publication_adoption(
  uuid,pathless_publication_adoption_kind,uuid
) FROM PUBLIC;
REVOKE ALL ON FUNCTION get_pathless_publication_adoption_write_target(uuid)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION stage_pathless_publication_adoption(
  uuid,pathless_publication_adoption_kind,bigint,text,text,text,timestamptz,
  text,text,integer,integer,text,uuid[],uuid[],text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION assert_pathless_publication_adoption_staging_exact(uuid)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION apply_pathless_publication_adoption(uuid) FROM PUBLIC;

GRANT USAGE,CREATE ON SCHEMA public TO context_use_boundary_owner;
ALTER FUNCTION guard_pathless_publication_adoption_history()
  OWNER TO context_use_boundary_owner;
ALTER FUNCTION guard_pathless_publication_adoption_staging_history()
  OWNER TO context_use_boundary_owner;
ALTER FUNCTION pathless_publication_hub_target_ids(uuid)
  OWNER TO context_use_boundary_owner;
ALTER FUNCTION pathless_publication_adoption_projection_plan(uuid,uuid,uuid[])
  OWNER TO context_use_boundary_owner;
ALTER FUNCTION pathless_publication_adoption_projected_target_ids(
  uuid,uuid,uuid[]
) OWNER TO context_use_boundary_owner;
ALTER FUNCTION pathless_publication_adoption_frozen_receipt_hash(
  text,uuid[],jsonb
) OWNER TO context_use_boundary_owner;
ALTER FUNCTION pathless_publication_adoption_projection_receipt_hash(
  text,uuid,uuid,uuid[]
) OWNER TO context_use_boundary_owner;
ALTER FUNCTION lock_pathless_publication_adoption_context(
  pathless_publication_adoption_kind,uuid
) OWNER TO context_use_boundary_owner;
ALTER FUNCTION pathless_publication_adoption_is_current(uuid)
  OWNER TO context_use_boundary_owner;
ALTER FUNCTION begin_pathless_publication_adoption(
  uuid,pathless_publication_adoption_kind,uuid
) OWNER TO context_use_boundary_owner;
ALTER FUNCTION stage_pathless_publication_adoption(
  uuid,pathless_publication_adoption_kind,bigint,text,text,text,timestamptz,
  text,text,integer,integer,text,uuid[],uuid[],text
) OWNER TO context_use_boundary_owner;
ALTER FUNCTION assert_pathless_publication_adoption_staging_exact(uuid)
  OWNER TO context_use_boundary_owner;
ALTER FUNCTION apply_pathless_publication_adoption(uuid)
  OWNER TO context_use_boundary_owner;
REVOKE CREATE ON SCHEMA public FROM context_use_boundary_owner;

GRANT USAGE,CREATE ON SCHEMA public TO context_use_pathless_storage_owner;
ALTER FUNCTION pathless_publication_adoption_source_snapshot(
  pathless_publication_adoption_kind,uuid,uuid
) OWNER TO context_use_pathless_storage_owner;
ALTER FUNCTION pathless_publication_adoption_source_fingerprint(
  pathless_publication_adoption_kind,uuid,uuid
) OWNER TO context_use_pathless_storage_owner;
ALTER FUNCTION get_pathless_publication_adoption_write_target(uuid)
  OWNER TO context_use_pathless_storage_owner;
REVOKE CREATE ON SCHEMA public FROM context_use_pathless_storage_owner;

GRANT EXECUTE ON FUNCTION pathless_publication_hub_target_ids(uuid),
  pathless_publication_adoption_projection_plan(uuid,uuid,uuid[]),
  canonical_public_uuid_set(uuid[]),
  pathless_publication_adoption_frozen_receipt_hash(text,uuid[],jsonb)
  TO context_use_pathless_storage_owner;
GRANT EXECUTE ON FUNCTION pathless_publication_adoption_source_snapshot(
  pathless_publication_adoption_kind,uuid,uuid
),pathless_publication_adoption_source_fingerprint(
  pathless_publication_adoption_kind,uuid,uuid
) TO context_use_boundary_owner;
GRANT EXECUTE ON FUNCTION lock_pathless_publication_adoption_context(
  pathless_publication_adoption_kind,uuid
),pathless_publication_adoption_is_current(uuid)
  TO context_use_pathless_storage_owner;

GRANT EXECUTE ON FUNCTION begin_pathless_publication_adoption(
  uuid,pathless_publication_adoption_kind,uuid
),apply_pathless_publication_adoption(uuid)
  TO context_use_corpus;
GRANT EXECUTE ON FUNCTION get_pathless_publication_adoption_write_target(uuid),
  stage_pathless_publication_adoption(
    uuid,pathless_publication_adoption_kind,bigint,text,text,text,timestamptz,
    text,text,integer,integer,text,uuid[],uuid[],text
  ) TO context_use_storage;

-- Public routing has an exact three-state result. `unassigned` means no
-- durable public authority exists for this route, while `inactive` deliberately
-- hides every identity and historical artifact behind an assigned authority.
CREATE TYPE pathless_public_route_state AS ENUM (
  'unassigned','inactive','active'
);

CREATE VIEW pathless_public_pages
WITH (security_barrier=true,security_invoker=false)
AS
SELECT artifact.public_id,
  '/p/'||artifact.public_id::text AS canonical_path,
  '/p/'||artifact.public_id::text||'.md' AS markdown_path,
  artifact.public_title,artifact.public_summary,
  to_char(
    artifact.public_last_edited_at AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
  ) AS public_last_edited_at,
  artifact.representation_token
FROM page_publications publication
JOIN public_page_artifacts artifact
  ON artifact.public_id=publication.public_id
 AND artifact.artifact_id=publication.artifact_id
JOIN public_resources resource
  ON resource.public_id=publication.public_id
 AND resource.resource_kind='page'
 AND resource.document_id IS NOT NULL
WHERE NOT EXISTS (
  SELECT 1 FROM blocking_public_namespace_conflicts conflict
  WHERE conflict.namespace_uuid IN (artifact.public_id,artifact.artifact_id)
     OR conflict.public_id=artifact.public_id
);

CREATE VIEW pathless_public_assets
WITH (security_barrier=true,security_invoker=false)
AS
SELECT artifact.public_id,
  '/a/'||artifact.public_id::text AS canonical_path,
  artifact.public_filename,artifact.public_content_type,
  artifact.public_width,artifact.public_height,
  artifact.public_duration_seconds::text AS public_duration_seconds,
  artifact.representation_token
FROM asset_publications publication
JOIN public_asset_artifacts artifact
  ON artifact.public_id=publication.public_id
 AND artifact.artifact_id=publication.artifact_id
JOIN public_resources resource
  ON resource.public_id=publication.public_id
 AND resource.resource_kind='asset'
 AND resource.document_id IS NOT NULL
WHERE NOT EXISTS (
  SELECT 1 FROM blocking_public_namespace_conflicts conflict
  WHERE conflict.namespace_uuid IN (artifact.public_id,artifact.artifact_id)
     OR conflict.public_id=artifact.public_id
);

CREATE FUNCTION get_pathless_publication_entrypoint()
RETURNS TABLE (
  public_id uuid,
  configured boolean,
  active boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
  SELECT settings.entrypoint_public_id,
    settings.updated_at IS NOT NULL,
    settings.entrypoint_public_id IS NOT NULL AND EXISTS (
      SELECT 1
      FROM page_publications publication
      JOIN public_page_artifacts artifact
        ON artifact.public_id=publication.public_id
       AND artifact.artifact_id=publication.artifact_id
      JOIN public_resources resource
        ON resource.public_id=publication.public_id
       AND resource.document_id IS NOT NULL
       AND resource.resource_kind='page'
      WHERE publication.public_id=settings.entrypoint_public_id
        AND NOT EXISTS (
          SELECT 1 FROM blocking_public_namespace_conflicts conflict
          WHERE conflict.namespace_uuid IN (
                  artifact.public_id,artifact.artifact_id
                )
             OR conflict.public_id=artifact.public_id
        )
    )
  FROM pathless_publication_settings settings
  WHERE settings.singleton;
$$;

CREATE FUNCTION list_pathless_publication_entrypoint_candidates()
RETURNS TABLE (
  public_id uuid,
  public_title text,
  public_summary text,
  public_last_edited_at text,
  representation_token text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path=pg_catalog,public
SET TimeZone='UTC'
AS $$
  SELECT page.public_id,page.public_title,page.public_summary,
    page.public_last_edited_at,page.representation_token
  FROM pathless_public_pages page
  ORDER BY page.public_title,page.public_id;
$$;

-- Activation invokes this one-time corpus boundary explicitly. Deployment
-- itself leaves updated_at NULL so legacy-only reset remains available.
CREATE FUNCTION seed_pathless_publication_entrypoint()
RETURNS TABLE (
  public_id uuid,
  configured boolean,
  active boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
DECLARE
  preliminary_updated_at timestamptz;
  stored_updated_at timestamptz;
  legacy_page_id uuid;
  locked_legacy_page_id uuid;
  resolved_public_id uuid;
BEGIN
  PERFORM pg_advisory_xact_lock_shared(
    hashtextextended('filesystem-hypermedia-corpus-transition',0)
  );
  SELECT pathless.updated_at,legacy.entrypoint_page_id
  INTO preliminary_updated_at,legacy_page_id
  FROM pathless_publication_settings pathless
  JOIN public_knowledge_settings legacy ON legacy.singleton
  WHERE pathless.singleton;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'pathless publication settings are missing'
      USING ERRCODE='P0002';
  END IF;
  IF preliminary_updated_at IS NOT NULL THEN
    RETURN QUERY SELECT * FROM get_pathless_publication_entrypoint();
    RETURN;
  END IF;

  IF legacy_page_id IS NOT NULL THEN
    PERFORM lock_operational_document(legacy_page_id);
    PERFORM page.id FROM knowledge_pages page
    WHERE page.id=legacy_page_id FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'legacy entrypoint page is missing'
        USING ERRCODE='23514';
    END IF;
    SELECT resource.public_id
    INTO resolved_public_id
    FROM public_resources resource
    WHERE resource.original_document_id=legacy_page_id
      AND resource.document_id=legacy_page_id
      AND resource.resource_kind='page'
    FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'legacy entrypoint has no exact permanent page mapping'
        USING ERRCODE='23514';
    END IF;
  END IF;

  SELECT settings.entrypoint_page_id
  INTO locked_legacy_page_id
  FROM public_knowledge_settings settings
  WHERE settings.singleton
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'legacy public settings are missing' USING ERRCODE='P0002';
  END IF;
  IF locked_legacy_page_id IS DISTINCT FROM legacy_page_id THEN
    RAISE EXCEPTION 'legacy entrypoint changed while seeding'
      USING ERRCODE='40001';
  END IF;
  SELECT settings.updated_at
  INTO stored_updated_at
  FROM pathless_publication_settings settings
  WHERE settings.singleton
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'pathless publication settings are missing'
      USING ERRCODE='P0002';
  END IF;
  IF stored_updated_at IS NOT NULL THEN
    RETURN QUERY SELECT * FROM get_pathless_publication_entrypoint();
    RETURN;
  END IF;
  UPDATE pathless_publication_settings settings
  SET entrypoint_public_id=resolved_public_id,updated_at=now()
  WHERE settings.singleton AND settings.updated_at IS NULL;
  RETURN QUERY SELECT * FROM get_pathless_publication_entrypoint();
END;
$$;

CREATE FUNCTION set_pathless_publication_entrypoint(p_public_id uuid)
RETURNS TABLE (
  public_id uuid,
  configured boolean,
  active boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
DECLARE
  stored_public_id uuid;
  stored_updated_at timestamptz;
  selected_document_id uuid;
  selected_artifact_id uuid;
  selected_origin public_artifact_origin;
BEGIN
  PERFORM pg_advisory_xact_lock_shared(
    hashtextextended('filesystem-hypermedia-corpus-transition',0)
  );
  SELECT settings.entrypoint_public_id,settings.updated_at
  INTO stored_public_id,stored_updated_at
  FROM pathless_publication_settings settings
  WHERE settings.singleton;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'pathless publication settings are missing'
      USING ERRCODE='P0002';
  END IF;

  -- An exact lost-reply retry returns the latched preference even if that page
  -- has since become inactive. It never resurrects or remirrors visibility.
  IF stored_updated_at IS NOT NULL
     AND stored_public_id IS NOT DISTINCT FROM p_public_id THEN
    SELECT settings.entrypoint_public_id,settings.updated_at
    INTO stored_public_id,stored_updated_at
    FROM pathless_publication_settings settings
    WHERE settings.singleton
    FOR UPDATE;
    IF stored_updated_at IS NOT NULL
       AND stored_public_id IS NOT DISTINCT FROM p_public_id THEN
      RETURN QUERY SELECT * FROM get_pathless_publication_entrypoint();
      RETURN;
    END IF;
    RAISE EXCEPTION 'entrypoint changed while replaying setter'
      USING ERRCODE='40001';
  END IF;

  IF p_public_id IS NOT NULL THEN
    SELECT resource.document_id INTO selected_document_id
    FROM public_resources resource
    WHERE resource.public_id=p_public_id
      AND resource.original_document_id=resource.document_id
      AND resource.resource_kind='page';
    IF NOT FOUND OR selected_document_id IS NULL THEN
      RAISE EXCEPTION 'entrypoint must be an exact active pathless page'
        USING ERRCODE='23514';
    END IF;
    PERFORM lock_operational_document(selected_document_id);
    PERFORM page.id FROM knowledge_pages page
    WHERE page.id=selected_document_id AND page.archived_at IS NULL
    FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'entrypoint must be an exact active pathless page'
        USING ERRCODE='23514';
    END IF;
    SELECT resource.document_id,artifact.artifact_id,artifact.origin
    INTO selected_document_id,selected_artifact_id,selected_origin
    FROM public_resources resource
    JOIN knowledge_pages page
      ON page.id=resource.document_id AND page.archived_at IS NULL
    JOIN page_publications publication
      ON publication.public_id=resource.public_id
    JOIN public_page_artifacts artifact
      ON artifact.public_id=publication.public_id
     AND artifact.artifact_id=publication.artifact_id
    WHERE resource.public_id=p_public_id
      AND resource.original_document_id=resource.document_id
      AND resource.resource_kind='page'
      AND NOT EXISTS (
        SELECT 1 FROM blocking_public_namespace_conflicts conflict
        WHERE conflict.namespace_uuid IN (
                artifact.public_id,artifact.artifact_id
              )
           OR conflict.public_id=artifact.public_id
      )
    FOR SHARE OF resource,page,publication;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'entrypoint must be an exact active pathless page'
        USING ERRCODE='23514';
    END IF;
  END IF;

  PERFORM 1 FROM public_knowledge_settings settings
  WHERE settings.singleton FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'legacy public settings are missing' USING ERRCODE='P0002';
  END IF;
  SELECT settings.entrypoint_public_id,settings.updated_at
  INTO stored_public_id,stored_updated_at
  FROM pathless_publication_settings settings
  WHERE settings.singleton
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'pathless publication settings are missing'
      USING ERRCODE='P0002';
  END IF;
  IF stored_updated_at IS NOT NULL
     AND stored_public_id IS NOT DISTINCT FROM p_public_id THEN
    RETURN QUERY SELECT * FROM get_pathless_publication_entrypoint();
    RETURN;
  END IF;
  IF p_public_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM blocking_public_namespace_conflicts conflict
    WHERE conflict.namespace_uuid IN (p_public_id,selected_artifact_id)
       OR conflict.public_id=p_public_id
  ) THEN
    RAISE EXCEPTION 'entrypoint candidate acquired a namespace conflict'
      USING ERRCODE='40001';
  END IF;

  UPDATE pathless_publication_settings settings
  SET entrypoint_public_id=p_public_id,updated_at=now()
  WHERE settings.singleton;
  -- Keep rollback readers coherent without making their path authority part of
  -- the new setting: ordinary pages mirror their private page identity, while
  -- a separately projected directory hub (and explicit NULL) clears legacy.
  UPDATE public_knowledge_settings settings
  SET entrypoint_page_id=CASE
    WHEN p_public_id IS NULL
      OR selected_origin='directory_hub_promotion' THEN NULL
    ELSE selected_document_id
  END,updated_at=now()
  WHERE settings.singleton;
  RETURN QUERY SELECT * FROM get_pathless_publication_entrypoint();
END;
$$;

GRANT SELECT,UPDATE ON pathless_publication_settings
  TO context_use_boundary_owner;
GRANT SELECT,UPDATE ON public_knowledge_settings
  TO context_use_boundary_owner;
GRANT SELECT (
  artifact_id,public_id,public_title,public_summary,public_last_edited_at,
  representation_token,origin
) ON public_page_artifacts TO context_use_boundary_owner;
GRANT SELECT (
  artifact_id,public_id,public_filename,public_content_type,public_width,
  public_height,public_duration_seconds,representation_token
) ON public_asset_artifacts TO context_use_boundary_owner;

GRANT SELECT (singleton,entrypoint_public_id,updated_at)
  ON pathless_publication_settings TO context_use_projection_owner;
GRANT SELECT (public_id,document_id,resource_kind)
  ON public_resources TO context_use_projection_owner;
GRANT SELECT (public_id,artifact_id)
  ON page_publications,asset_publications TO context_use_projection_owner;
GRANT SELECT (
  artifact_id,public_id,public_title,public_summary,public_last_edited_at,
  representation_token
) ON public_page_artifacts TO context_use_projection_owner;
GRANT SELECT (
  artifact_id,public_id,public_filename,public_content_type,public_width,
  public_height,public_duration_seconds,representation_token
) ON public_asset_artifacts TO context_use_projection_owner;

REVOKE ALL ON FUNCTION get_pathless_publication_entrypoint() FROM PUBLIC;
REVOKE ALL ON FUNCTION list_pathless_publication_entrypoint_candidates()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION seed_pathless_publication_entrypoint() FROM PUBLIC;
REVOKE ALL ON FUNCTION set_pathless_publication_entrypoint(uuid) FROM PUBLIC;

GRANT USAGE,CREATE ON SCHEMA public TO context_use_projection_owner;
ALTER VIEW pathless_public_pages OWNER TO context_use_projection_owner;
ALTER VIEW pathless_public_assets OWNER TO context_use_projection_owner;
REVOKE CREATE ON SCHEMA public FROM context_use_projection_owner;

GRANT USAGE,CREATE ON SCHEMA public TO context_use_boundary_owner;
ALTER FUNCTION get_pathless_publication_entrypoint()
  OWNER TO context_use_boundary_owner;
ALTER FUNCTION list_pathless_publication_entrypoint_candidates()
  OWNER TO context_use_boundary_owner;
ALTER FUNCTION seed_pathless_publication_entrypoint()
  OWNER TO context_use_boundary_owner;
ALTER FUNCTION set_pathless_publication_entrypoint(uuid)
  OWNER TO context_use_boundary_owner;
REVOKE CREATE ON SCHEMA public FROM context_use_boundary_owner;

GRANT SELECT ON pathless_public_pages,pathless_public_assets
  TO context_use_boundary_owner,context_use_public,context_use_backup;
GRANT EXECUTE ON FUNCTION seed_pathless_publication_entrypoint()
  TO context_use_corpus;
GRANT EXECUTE ON FUNCTION get_pathless_publication_entrypoint(),
  list_pathless_publication_entrypoint_candidates(),
  set_pathless_publication_entrypoint(uuid)
  TO context_use_dashboard;

CREATE FUNCTION pathless_public_route_kind(p_route text)
RETURNS public_route_kind
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path=pg_catalog
RETURN CASE
  WHEN p_route='/p/' THEN 'directory'::public_route_kind
  WHEN p_route LIKE '/a/%'
   AND length(substring(p_route FROM 4)) BETWEEN 1 AND 512
   AND substring(p_route FROM 4) ~ '^[a-z0-9][a-z0-9/_-]*$'
   AND substring(p_route FROM 4) !~ '//'
   AND right(p_route,1)<>'/' THEN 'asset'::public_route_kind
  WHEN p_route LIKE '/p/%/'
   AND length(substring(p_route FROM 4 FOR length(p_route)-4)) BETWEEN 1 AND 512
   AND substring(p_route FROM 4 FOR length(p_route)-4)
         ~ '^[a-z0-9][a-z0-9/_-]*$'
   AND substring(p_route FROM 4 FOR length(p_route)-4) !~ '//'
   AND right(substring(p_route FROM 4 FOR length(p_route)-4),1)<>'/'
     THEN 'directory'::public_route_kind
  WHEN p_route LIKE '/p/%.md'
   AND length(substring(p_route FROM 4 FOR length(p_route)-6)) BETWEEN 1 AND 512
   AND substring(p_route FROM 4 FOR length(p_route)-6)
         ~ '^[a-z0-9][a-z0-9/_-]*$'
   AND substring(p_route FROM 4 FOR length(p_route)-6) !~ '//'
   AND right(substring(p_route FROM 4 FOR length(p_route)-6),1)<>'/'
     THEN 'markdown'::public_route_kind
  WHEN p_route LIKE '/p/%'
   AND length(substring(p_route FROM 4)) BETWEEN 1 AND 512
   AND substring(p_route FROM 4) ~ '^[a-z0-9][a-z0-9/_-]*$'
   AND substring(p_route FROM 4) !~ '//'
   AND right(p_route,1)<>'/' THEN 'page'::public_route_kind
  ELSE NULL
END;

CREATE FUNCTION resolve_pathless_public_route(p_route text)
RETURNS TABLE (
  state pathless_public_route_state,
  route_kind public_route_kind,
  canonical_path text,
  public_id uuid,
  representation_token text,
  public_title text,
  public_summary text,
  public_last_edited_at text,
  public_filename text,
  public_content_type text,
  public_width integer,
  public_height integer,
  public_duration_seconds text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path=pg_catalog,public
SET TimeZone='UTC'
AS $$
DECLARE
  requested_kind public_route_kind;
  resolved_public_id uuid;
  expected_resource_kind publication_target;
  actual_resource_kind publication_target;
  resolved_document_id uuid;
  direct_token text;
  page_row record;
  asset_row record;
  assigned boolean := false;
BEGIN
  requested_kind := pathless_public_route_kind(p_route);
  IF requested_kind IS NULL THEN
    RAISE EXCEPTION 'public route is not exact or canonical'
      USING ERRCODE='22023';
  END IF;
  route_kind := requested_kind;

  -- `/p/` belongs exclusively to the independently latched pathless setting;
  -- a permanent legacy root alias can never become an implicit fallback.
  IF p_route='/p/' THEN
    SELECT settings.entrypoint_public_id,
      settings.updated_at IS NOT NULL
    INTO resolved_public_id,assigned
    FROM pathless_publication_settings settings
    WHERE settings.singleton;
    IF NOT assigned THEN state := 'unassigned'; RETURN NEXT; RETURN; END IF;
    IF resolved_public_id IS NULL THEN
      state := 'inactive'; RETURN NEXT; RETURN;
    END IF;
    SELECT page.* INTO page_row
    FROM pathless_public_pages page
    WHERE page.public_id=resolved_public_id;
    IF NOT FOUND THEN state := 'inactive'; RETURN NEXT; RETURN; END IF;
    state := 'active';
    canonical_path := page_row.canonical_path;
    public_id := page_row.public_id;
    representation_token := page_row.representation_token;
    public_title := page_row.public_title;
    public_summary := page_row.public_summary;
    public_last_edited_at := page_row.public_last_edited_at;
    RETURN NEXT;
    RETURN;
  END IF;

  IF p_route ~ '^/p/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    direct_token := substring(p_route FROM 4);
    expected_resource_kind := 'page';
  ELSIF p_route ~ '^/p/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.]md$' THEN
    direct_token := substring(p_route FROM 4 FOR 36);
    expected_resource_kind := 'page';
  ELSIF p_route ~ '^/a/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    direct_token := substring(p_route FROM 4);
    expected_resource_kind := 'asset';
  END IF;

  IF direct_token IS NOT NULL THEN
    resolved_public_id := direct_token::uuid;
    -- Canonical authority wins over aliases only when any grandfathered alias
    -- at that spelling agrees exactly; ambiguity fails closed.
    IF EXISTS (
      SELECT 1 FROM public_route_aliases alias
      WHERE alias.alias_path=p_route
        AND (
          alias.public_id<>resolved_public_id
          OR alias.route_kind<>requested_kind
        )
    ) THEN
      state := 'inactive'; RETURN NEXT; RETURN;
    END IF;
    SELECT resource.resource_kind,resource.document_id
    INTO actual_resource_kind,resolved_document_id
    FROM public_resources resource
    WHERE resource.public_id=resolved_public_id;
    IF NOT FOUND THEN
      state := 'unassigned';
      RETURN NEXT;
      RETURN;
    END IF;
    IF EXISTS (
      SELECT 1 FROM blocking_public_namespace_conflicts conflict
      WHERE conflict.namespace_uuid=resolved_public_id
         OR conflict.public_id=resolved_public_id
         OR conflict.alias_path=p_route
    ) THEN
      state := 'inactive'; RETURN NEXT; RETURN;
    END IF;
    IF resolved_document_id IS NULL
       OR actual_resource_kind<>expected_resource_kind THEN
      state := 'inactive'; RETURN NEXT; RETURN;
    END IF;
  ELSE
    SELECT alias.public_id INTO resolved_public_id
    FROM public_route_aliases alias
    WHERE alias.alias_path=p_route AND alias.route_kind=requested_kind;
    IF NOT FOUND THEN
      state := 'unassigned';
      RETURN NEXT;
      RETURN;
    END IF;
    IF EXISTS (
      SELECT 1 FROM blocking_public_namespace_conflicts conflict
      WHERE conflict.namespace_uuid=resolved_public_id
         OR conflict.public_id=resolved_public_id
         OR conflict.alias_path=p_route
    ) THEN
      state := 'inactive'; RETURN NEXT; RETURN;
    END IF;
    SELECT resource.resource_kind,resource.document_id
    INTO actual_resource_kind,resolved_document_id
    FROM public_resources resource
    WHERE resource.public_id=resolved_public_id;
    IF NOT FOUND OR resolved_document_id IS NULL
       OR (requested_kind='asset' AND actual_resource_kind<>'asset')
       OR (requested_kind<>'asset' AND actual_resource_kind<>'page') THEN
      state := 'inactive'; RETURN NEXT; RETURN;
    END IF;
  END IF;

  IF actual_resource_kind='page' THEN
    SELECT page.* INTO page_row
    FROM pathless_public_pages page
    WHERE page.public_id=resolved_public_id;
    IF NOT FOUND THEN state := 'inactive'; RETURN NEXT; RETURN; END IF;
    state := 'active';
    canonical_path := CASE requested_kind
      WHEN 'markdown' THEN page_row.markdown_path
      ELSE page_row.canonical_path END;
    public_id := page_row.public_id;
    representation_token := page_row.representation_token;
    public_title := page_row.public_title;
    public_summary := page_row.public_summary;
    public_last_edited_at := page_row.public_last_edited_at;
  ELSE
    SELECT asset.* INTO asset_row
    FROM pathless_public_assets asset
    WHERE asset.public_id=resolved_public_id;
    IF NOT FOUND THEN state := 'inactive'; RETURN NEXT; RETURN; END IF;
    state := 'active';
    canonical_path := asset_row.canonical_path;
    public_id := asset_row.public_id;
    representation_token := asset_row.representation_token;
    public_filename := asset_row.public_filename;
    public_content_type := asset_row.public_content_type;
    public_width := asset_row.public_width;
    public_height := asset_row.public_height;
    public_duration_seconds := asset_row.public_duration_seconds;
  END IF;
  RETURN NEXT;
END;
$$;

CREATE FUNCTION resolve_pathless_storage_route(p_representation_token text)
RETURNS TABLE (
  resource_kind publication_target,
  representation_token text,
  body_object_key text,
  body_size_bytes bigint,
  body_content_hash text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
BEGIN
  IF p_representation_token IS NULL
     OR p_representation_token !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'representation token must be exact lowercase hex'
      USING ERRCODE='22023';
  END IF;
  RETURN QUERY
  SELECT 'page'::publication_target,reservation.representation_token,
    artifact.body_object_key,artifact.body_size_bytes::bigint,
    artifact.body_content_hash
  FROM public_representation_token_reservations reservation
  JOIN public_page_artifacts artifact
    ON artifact.representation_token=reservation.representation_token
   AND artifact.artifact_id=reservation.artifact_id
   AND reservation.resource_kind='page'
  JOIN page_publications publication
    ON publication.public_id=artifact.public_id
   AND publication.artifact_id=artifact.artifact_id
  JOIN public_resources resource
    ON resource.public_id=publication.public_id
   AND resource.document_id IS NOT NULL
   AND resource.resource_kind='page'
  WHERE reservation.representation_token=p_representation_token
    AND NOT EXISTS (
      SELECT 1 FROM blocking_public_namespace_conflicts conflict
      WHERE conflict.namespace_uuid IN (artifact.public_id,artifact.artifact_id)
         OR conflict.public_id=artifact.public_id
    )
  UNION ALL
  SELECT 'asset'::publication_target,reservation.representation_token,
    artifact.body_object_key,artifact.body_size_bytes,
    artifact.body_content_hash
  FROM public_representation_token_reservations reservation
  JOIN public_asset_artifacts artifact
    ON artifact.representation_token=reservation.representation_token
   AND artifact.artifact_id=reservation.artifact_id
   AND reservation.resource_kind='asset'
  JOIN asset_publications publication
    ON publication.public_id=artifact.public_id
   AND publication.artifact_id=artifact.artifact_id
  JOIN public_resources resource
    ON resource.public_id=publication.public_id
   AND resource.document_id IS NOT NULL
   AND resource.resource_kind='asset'
  WHERE reservation.representation_token=p_representation_token
    AND NOT EXISTS (
      SELECT 1 FROM blocking_public_namespace_conflicts conflict
      WHERE conflict.namespace_uuid IN (artifact.public_id,artifact.artifact_id)
         OR conflict.public_id=artifact.public_id
    );
END;
$$;

GRANT SELECT ON pathless_public_pages,pathless_public_assets
  TO context_use_projection_owner;

GRANT SELECT (
  representation_token,artifact_id,resource_kind
) ON public_representation_token_reservations
  TO context_use_pathless_storage_owner;
GRANT SELECT (
  artifact_id,public_id,body_object_key,body_size_bytes,body_content_hash,
  representation_token
) ON public_page_artifacts,public_asset_artifacts
  TO context_use_pathless_storage_owner;
GRANT SELECT (public_id,artifact_id)
  ON page_publications,asset_publications
  TO context_use_pathless_storage_owner;
GRANT SELECT ON blocking_public_namespace_conflicts
  TO context_use_pathless_storage_owner;
GRANT EXECUTE ON FUNCTION canonical_legacy_alias_uuid(text),
  canonical_legacy_alias_kind(text)
  TO context_use_pathless_storage_owner,context_use_public,context_use_backup;

REVOKE ALL ON FUNCTION pathless_public_route_kind(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION resolve_pathless_public_route(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION resolve_pathless_storage_route(text) FROM PUBLIC;

GRANT USAGE,CREATE ON SCHEMA public TO context_use_projection_owner;
ALTER FUNCTION pathless_public_route_kind(text)
  OWNER TO context_use_projection_owner;
ALTER FUNCTION resolve_pathless_public_route(text)
  OWNER TO context_use_projection_owner;
REVOKE CREATE ON SCHEMA public FROM context_use_projection_owner;

GRANT USAGE,CREATE ON SCHEMA public TO context_use_pathless_storage_owner;
ALTER FUNCTION resolve_pathless_storage_route(text)
  OWNER TO context_use_pathless_storage_owner;
REVOKE CREATE ON SCHEMA public FROM context_use_pathless_storage_owner;

GRANT USAGE ON TYPE pathless_public_route_state
  TO context_use_public,context_use_backup;
GRANT EXECUTE ON FUNCTION resolve_pathless_public_route(text)
  TO context_use_public;
GRANT EXECUTE ON FUNCTION resolve_pathless_storage_route(text)
  TO context_use_storage;
