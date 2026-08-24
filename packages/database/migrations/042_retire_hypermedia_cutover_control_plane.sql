-- The v0.1.82 transition is complete before an existing installation reaches
-- this migration. Fresh databases are allowed through only while they contain
-- no retained knowledge; the hypermedia bootstrap remains their sole creator.

SELECT pg_advisory_xact_lock(
  hashtextextended('filesystem-hypermedia-corpus-transition',0)
);

DO $$
DECLARE
  cutover_finalized_at timestamptz;
BEGIN
  SELECT finalized_at INTO cutover_finalized_at
  FROM hypermedia_cutover_state WHERE singleton FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'hypermedia cutover state is missing' USING ERRCODE='55000';
  END IF;
  IF cutover_finalized_at IS NULL AND (
    EXISTS (SELECT 1 FROM hypermedia_documents)
    OR EXISTS (SELECT 1 FROM knowledge_pages)
    OR EXISTS (SELECT 1 FROM assets)
    OR EXISTS (SELECT 1 FROM automation_registry)
    OR EXISTS (SELECT 1 FROM public_resources)
    OR EXISTS (SELECT 1 FROM corpus_migration_runs)
    OR EXISTS (SELECT 1 FROM pathless_publication_adoptions)
    OR EXISTS (SELECT 1 FROM knowledge_settings
      WHERE global_guide_document_id IS NOT NULL)
    OR EXISTS (SELECT 1 FROM pathless_publication_settings
      WHERE updated_at IS NOT NULL)
  ) THEN
    RAISE EXCEPTION
      'retained data requires a completed v0.1.82 hypermedia cutover'
      USING ERRCODE='55000';
  END IF;
END;
$$;

-- These views are recreated below from permanent hypermedia authorities only.
DROP VIEW private_document_catalog;
DROP VIEW live_public_namespace_conflicts;

-- Remove migration-only hooks from long-lived knowledge tables before their
-- backing state disappears.
DROP TRIGGER knowledge_pages_reset_corpus_migration_state ON knowledge_pages;
DROP TRIGGER knowledge_page_versions_reset_corpus_migration_state
  ON knowledge_page_versions;

-- Object claims remain crash-replay state for ordinary publication only.
DROP TRIGGER pathless_publication_claims_030_keep_history
  ON pathless_publication_object_claims;
DELETE FROM pathless_publication_object_claims
WHERE allocation_kind='pathless_adoption';
ALTER TABLE pathless_publication_object_claims
  DROP CONSTRAINT pathless_publication_object_claims_allocation_kind_check,
  ADD CONSTRAINT pathless_publication_object_claims_allocation_kind_check
    CHECK (allocation_kind='pathless_intent');
CREATE TRIGGER pathless_publication_claims_030_keep_history
BEFORE UPDATE OR DELETE ON pathless_publication_object_claims
FOR EACH ROW EXECUTE FUNCTION guard_pathless_publication_object_claim_history();

-- Applied artifacts remain immutable public history. Their old source-plan FK
-- is no longer needed once every plan is applied and the control plane retires.
ALTER TABLE public_page_artifacts
  DROP CONSTRAINT public_page_artifacts_source_adoption_fk;
ALTER TABLE public_asset_artifacts
  DROP CONSTRAINT public_asset_artifacts_source_adoption_fk;

DROP TABLE pathless_publication_adoption_staging,
  pathless_publication_adoptions,
  corpus_migration_completions,
  corpus_migration_automation_plans,
  corpus_page_migration_plans,
  corpus_directory_migration_plans,
  corpus_migration_inventory,
  directory_hub_migrations,
  operational_document_replacements,
  corpus_migration_runs CASCADE;

-- Remove every retired callable boundary. Signatures are resolved from the
-- catalog so overloads and enum-typed arguments disappear together.
DO $$
DECLARE
  routine record;
BEGIN
  FOR routine IN
    SELECT procedure.oid::regprocedure AS signature
    FROM pg_proc procedure
    JOIN pg_namespace namespace ON namespace.oid=procedure.pronamespace
    WHERE namespace.nspname='public'
      AND procedure.proname=ANY(ARRAY[
        'apply_pathless_publication_adoption',
        'assert_pathless_publication_adoption_staging_exact',
        'begin_pathless_publication_adoption',
        'claim_pathless_publication_adoption_artifact',
        'corpus_public_path_title',
        'corpus_published_artifact_matches',
        'finalize_pathless_publication_adoption_claim',
        'get_pathless_publication_adoption_write_target',
        'guard_corpus_directory_plan_namespace',
        'guard_corpus_migration_phase_progression',
        'guard_operational_replacement_phase_progression',
        'guard_pathless_publication_adoption_history',
        'guard_pathless_publication_adoption_staging_history',
        'hydrate_corpus_knowledge_revision',
        'invalidate_pathless_hub_publication_on_mapping_drift',
        'list_pathless_publication_adoption_candidates',
        'lock_corpus_migration_audit_tables',
        'lock_corpus_migration_generated_targets',
        'lock_corpus_migration_hub_apply_tables',
        'lock_corpus_migration_item',
        'lock_corpus_migration_runs_for_operational_change',
        'lock_pathless_publication_adoption_context',
        'pathless_publication_adoption_frozen_receipt_hash',
        'pathless_publication_adoption_is_current',
        'pathless_publication_adoption_projected_target_ids',
        'pathless_publication_adoption_projection_plan',
        'pathless_publication_adoption_projection_receipt_hash',
        'pathless_publication_adoption_source_fingerprint',
        'pathless_publication_adoption_source_snapshot',
        'pathless_publication_hub_target_ids',
        'prevent_planned_automation_document_role_reuse',
        'reconcile_deleted_public_namespace_conflicts',
        'reconcile_finished_operational_public_namespace_conflicts',
        'reconcile_planned_public_namespace_conflicts',
        'reconcile_superseded_public_namespace_conflicts',
        'register_directory_hub_migration',
        'render_corpus_public_directory_hub',
        'reset_corpus_migration_operational_state',
        'retarget_managed_operational_document',
        'stage_pathless_publication_adoption'
      ])
  LOOP
    EXECUTE format('DROP FUNCTION %s CASCADE',routine.signature);
  END LOOP;
END;
$$;

DROP TYPE corpus_migration_item_kind,
  corpus_migration_phase,
  corpus_migration_result_kind,
  operational_document_replacement_kind,
  operational_document_replacement_phase;

-- Planned conflict history has no authority after the cutover. Permanent
-- collision evidence and immutable aliases remain.
DELETE FROM public_namespace_conflicts WHERE conflict_lifecycle='planned';
ALTER TABLE public_namespace_conflicts
  DROP CONSTRAINT public_namespace_conflicts_conflict_kind_check,
  DROP CONSTRAINT public_namespace_conflicts_conflict_lifecycle_check,
  ADD CONSTRAINT public_namespace_conflicts_conflict_kind_check CHECK (
    conflict_kind=ANY(ARRAY[
      'public_id_private_id','public_id_artifact_id','public_id_alias_token',
      'alias_token_private_id','alias_token_artifact_id',
      'alias_token_public_mapping','artifact_id_private_id'
    ])
  ),
  ADD CONSTRAINT public_namespace_conflicts_conflict_lifecycle_check
    CHECK (conflict_lifecycle='permanent');

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
), public_candidate(public_id,document_id,resource_kind) AS (
  SELECT public_id,original_document_id,resource_kind FROM public_resources
), alias_token AS (
  SELECT alias_path,route_kind,public_id,
    canonical_legacy_alias_uuid(alias_path) AS token,
    canonical_legacy_alias_kind(alias_path) AS expected_route_kind
  FROM public_route_aliases
  WHERE canonical_legacy_alias_uuid(alias_path) IS NOT NULL
), detected AS (
  SELECT DISTINCT 'public:resource:'||candidate.public_id::text||
      ':private:'||private.kind AS conflict_key,
    candidate.public_id AS namespace_uuid,'public_id_private_id' AS conflict_kind,
    candidate.public_id,NULL::text AS alias_path,private.kind AS identity_kind
  FROM public_candidate candidate JOIN private_identity private
    ON private.id=candidate.public_id
  UNION
  SELECT DISTINCT 'public:resource:'||candidate.public_id::text||':artifact',
    candidate.public_id,'public_id_artifact_id',candidate.public_id,NULL::text,
    'public_artifact'
  FROM public_candidate candidate JOIN public_artifact_id_reservations artifact
    ON artifact.artifact_id=candidate.public_id
  UNION
  SELECT DISTINCT 'public:resource:'||candidate.public_id::text||
      ':alias:'||alias.alias_path,
    candidate.public_id,'public_id_alias_token',candidate.public_id,
    alias.alias_path,'legacy_alias_token'
  FROM public_candidate candidate JOIN alias_token alias
    ON alias.token=candidate.public_id
  WHERE alias.public_id<>candidate.public_id
     OR alias.route_kind<>alias.expected_route_kind
     OR (candidate.resource_kind='page'
       AND alias.route_kind NOT IN ('page','markdown'))
     OR (candidate.resource_kind='asset' AND alias.route_kind<>'asset')
  UNION
  SELECT DISTINCT 'alias:'||alias.alias_path||':private:'||private.kind,
    alias.token,'alias_token_private_id',alias.public_id,alias.alias_path,
    private.kind
  FROM alias_token alias JOIN private_identity private ON private.id=alias.token
  UNION
  SELECT DISTINCT 'alias:'||alias.alias_path||':artifact',alias.token,
    'alias_token_artifact_id',alias.public_id,alias.alias_path,'public_artifact'
  FROM alias_token alias JOIN public_artifact_id_reservations artifact
    ON artifact.artifact_id=alias.token
  UNION
  SELECT DISTINCT 'artifact:'||artifact.artifact_id::text||
      ':private:'||private.kind,
    artifact.artifact_id,'artifact_id_private_id',NULL::uuid,NULL::text,
    private.kind
  FROM public_artifact_id_reservations artifact JOIN private_identity private
    ON private.id=artifact.artifact_id
  UNION
  SELECT DISTINCT 'alias:'||alias.alias_path||':mapping',alias.token,
    'alias_token_public_mapping',alias.public_id,alias.alias_path,
    'public_resource'
  FROM alias_token alias
  LEFT JOIN public_resources resource ON resource.public_id=alias.token
  WHERE resource.public_id IS NULL OR alias.public_id<>alias.token
     OR alias.route_kind<>alias.expected_route_kind
     OR (resource.resource_kind='page'
       AND alias.route_kind NOT IN ('page','markdown'))
     OR (resource.resource_kind='asset' AND alias.route_kind<>'asset')
)
SELECT conflict_key,namespace_uuid,conflict_kind,public_id,alias_path,
  identity_kind AS conflicting_identity_kind,'permanent'::text AS conflict_lifecycle
FROM detected;

ALTER VIEW live_public_namespace_conflicts OWNER TO context_use_projection_owner;
GRANT SELECT ON live_public_namespace_conflicts
  TO context_use_boundary_owner,context_use_backup;

CREATE OR REPLACE FUNCTION public_uuid_has_reserved_public_identity(p_uuid uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
  SELECT EXISTS (SELECT 1 FROM public_resources WHERE public_id=p_uuid);
$$;

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
    UNION ALL SELECT 1 FROM hypermedia_bootstrap_allocations
      WHERE document_id=p_uuid OR revision_id=p_uuid
    UNION ALL SELECT 1 FROM knowledge_directories WHERE id=p_uuid
    UNION ALL SELECT 1 FROM legacy_public_directory_prefixes
      WHERE directory_id=p_uuid
    UNION ALL SELECT 1 FROM public_resources WHERE original_document_id=p_uuid
    UNION ALL SELECT 1 FROM publication_target_generations
      WHERE target_document_id=p_uuid
  );
$$;

CREATE OR REPLACE FUNCTION assert_public_uuid_available(
  p_uuid uuid,p_original_document_id uuid,p_resource_kind publication_target
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
DECLARE namespace_uuid uuid;
BEGIN
  FOR namespace_uuid IN
    SELECT DISTINCT value FROM unnest(ARRAY[p_uuid,p_original_document_id]) value
    WHERE value IS NOT NULL ORDER BY value
  LOOP
    PERFORM lock_public_uuid_namespace(namespace_uuid);
  END LOOP;
  IF public_uuid_has_private_identity(p_uuid)
     OR public_uuid_has_artifact_identity(p_uuid)
     OR EXISTS (
       SELECT 1 FROM public_namespace_conflicts conflict
       WHERE conflict.namespace_uuid=p_uuid AND conflict.resolved_at IS NULL
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
  ) THEN
    RAISE EXCEPTION 'public UUID is permanently assigned to another resource'
      USING ERRCODE='23505';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public_resources resource
    WHERE resource.original_document_id=p_original_document_id
      AND resource.public_id<>p_uuid
  ) THEN
    RAISE EXCEPTION 'private document is assigned another permanent public UUID'
      USING ERRCODE='23505';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public_route_aliases alias
    WHERE canonical_legacy_alias_uuid(alias.alias_path)=p_uuid AND (
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

CREATE OR REPLACE FUNCTION pathless_publication_target_is_operational(
  p_document_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM knowledge_settings
    WHERE singleton AND global_guide_document_id=p_document_id
    UNION ALL SELECT 1 FROM automation_registry
    WHERE instructions_document_id=p_document_id OR state_document_id=p_document_id
  );
$$;

CREATE OR REPLACE FUNCTION prevent_automation_document_role_reuse()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
DECLARE target_id uuid;
BEGIN
  FOR target_id IN
    SELECT id FROM unnest(array_remove(
      ARRAY[NEW.instructions_document_id,NEW.state_document_id],NULL
    )) id ORDER BY id
  LOOP
    PERFORM lock_operational_document(target_id);
  END LOOP;
  IF EXISTS (
    SELECT 1 FROM automation_registry registry
    WHERE registry.id<>NEW.id AND (
      registry.instructions_document_id=ANY(array_remove(
        ARRAY[NEW.instructions_document_id,NEW.state_document_id],NULL
      )) OR registry.state_document_id=ANY(array_remove(
        ARRAY[NEW.instructions_document_id,NEW.state_document_id],NULL
      ))
    )
  ) THEN
    RAISE EXCEPTION 'an automation document cannot be reused in another registry role'
      USING ERRCODE='23505';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION validate_global_knowledge_guide()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
BEGIN
  IF NEW.global_guide_document_id IS NOT NULL THEN
    PERFORM lock_operational_document(NEW.global_guide_document_id);
    IF EXISTS (
      SELECT 1 FROM automation_registry
      WHERE instructions_document_id=NEW.global_guide_document_id
         OR state_document_id=NEW.global_guide_document_id
    ) THEN
      RAISE EXCEPTION 'an automation document cannot be the global knowledge guide'
        USING ERRCODE='23505';
    END IF;
    PERFORM 1
    FROM knowledge_pages page
    JOIN hypermedia_documents document ON document.id=page.id
    WHERE page.id=NEW.global_guide_document_id
      AND page.archived_at IS NULL
      AND page.published_version_id IS NULL AND page.public_path IS NULL
      AND document.authority='knowledge' AND document.representation='markdown'
    FOR UPDATE OF page;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'global guide must be active, private knowledge Markdown'
        USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION prevent_operational_document_publication()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
BEGIN
  PERFORM lock_operational_document(NEW.id);
  IF (NEW.published_version_id IS NOT NULL OR NEW.public_path IS NOT NULL)
     AND pathless_publication_target_is_operational(NEW.id) THEN
    RAISE EXCEPTION 'operational control documents cannot be published'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION prevent_operational_publication_intent()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
BEGIN
  IF NEW.action='publish' AND NEW.target_kind='page' THEN
    PERFORM lock_operational_document(NEW.target_id);
    IF pathless_publication_target_is_operational(NEW.target_id) THEN
      RAISE EXCEPTION 'operational control documents cannot be published'
        USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION protect_registered_automation_documents()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
DECLARE target_id uuid := CASE WHEN TG_OP='DELETE' THEN OLD.id ELSE NEW.id END;
BEGIN
  PERFORM lock_operational_document(target_id);
  IF EXISTS (
    SELECT 1 FROM automation_registry
    WHERE instructions_document_id=target_id OR state_document_id=target_id
  ) AND (TG_OP='DELETE' OR NEW.archived_at IS NOT NULL
    OR NEW.current_path IS DISTINCT FROM OLD.current_path) THEN
    RAISE EXCEPTION 'registered automation documents cannot be moved, archived or deleted'
      USING ERRCODE='23514';
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE OR REPLACE FUNCTION protect_configured_global_knowledge_guide()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=pg_catalog,public
AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF EXISTS (SELECT 1 FROM knowledge_settings
      WHERE singleton AND global_guide_document_id=OLD.id) THEN
      RAISE EXCEPTION 'the configured global knowledge guide cannot be archived or deleted'
        USING ERRCODE='23514';
    END IF;
    RETURN OLD;
  END IF;
  IF (NEW.archived_at IS NOT NULL
      OR NEW.current_path IS DISTINCT FROM OLD.current_path)
     AND EXISTS (SELECT 1 FROM knowledge_settings
       WHERE singleton AND global_guide_document_id=OLD.id) THEN
    RAISE EXCEPTION 'the configured global knowledge guide cannot be moved, archived or deleted'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

-- Retained pre-cutover installations can still carry the former `agents`
-- label until the following path-schema contraction. Keep its immobility
-- without consulting the retired managed-replacement plan.
CREATE OR REPLACE FUNCTION protect_root_knowledge_guide()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=pg_catalog,public
AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.current_path='agents' THEN
      RAISE EXCEPTION 'the root AGENTS.md page cannot be deleted'
        USING ERRCODE='23514';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.current_path='agents'
     AND (NEW.current_path IS DISTINCT FROM 'agents'
       OR NEW.archived_at IS NOT NULL) THEN
    RAISE EXCEPTION 'the root AGENTS.md page must remain active at agents'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION protect_published_page_directory_ancestors()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
DECLARE directory_path text := OLD.current_path;
BEGIN
  IF TG_OP='DELETE' THEN
    PERFORM 1 FROM knowledge_pages page
    WHERE page.archived_at IS NULL
      AND page.published_version_id IS NOT NULL AND page.public_path IS NOT NULL
      AND (directory_path='' OR page.public_path LIKE directory_path||'/%')
    FOR KEY SHARE OF page;
    IF FOUND THEN
      RAISE EXCEPTION
        'a published page directory ancestor cannot be moved or deleted before cutover'
        USING ERRCODE='23514';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.current_path IS DISTINCT FROM OLD.current_path THEN
    PERFORM 1 FROM knowledge_pages page
    WHERE page.archived_at IS NULL
      AND page.published_version_id IS NOT NULL AND page.public_path IS NOT NULL
      AND (directory_path='' OR page.public_path LIKE directory_path||'/%')
    FOR KEY SHARE OF page;
    IF FOUND THEN
      RAISE EXCEPTION
        'a published page directory ancestor cannot be moved or deleted before cutover'
        USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION validate_active_pathless_publication_pin()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
DECLARE target_document_id uuid;
BEGIN
  IF TG_OP='UPDATE' THEN
    RAISE EXCEPTION 'active pathless publication pins are immutable; unpublish first'
      USING ERRCODE='23514';
  END IF;
  SELECT document_id INTO target_document_id
  FROM public_resources WHERE public_id=NEW.public_id;
  IF TG_TABLE_NAME='page_publications' THEN
    PERFORM 1 FROM knowledge_pages page
    WHERE page.id=target_document_id AND page.archived_at IS NULL
    FOR SHARE OF page;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'a page pin requires an active mapped private page'
        USING ERRCODE='23514';
    END IF;
    PERFORM 1 FROM public_resources resource
    WHERE resource.public_id=NEW.public_id
      AND resource.document_id=target_document_id
      AND resource.resource_kind='page' FOR SHARE OF resource;
  ELSIF TG_TABLE_NAME='asset_publications' THEN
    PERFORM 1 FROM assets asset
    WHERE asset.id=target_document_id AND asset.deleted_at IS NULL
    FOR SHARE OF asset;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'an asset pin requires an active mapped private asset'
        USING ERRCODE='23514';
    END IF;
    PERFORM 1 FROM public_resources resource
    WHERE resource.public_id=NEW.public_id
      AND resource.document_id=target_document_id
      AND resource.resource_kind='asset' FOR SHARE OF resource;
  ELSE
    RAISE EXCEPTION 'pathless pin guard attached to an unsupported relation'
      USING ERRCODE='55000';
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'a publication pin requires its exact active mapping'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION require_finalized_pathless_publication_object_claim()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
DECLARE claim pathless_publication_object_claims%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME<>'pathless_publication_artifact_staging' THEN
    RAISE EXCEPTION 'unexpected pathless publication staging table'
      USING ERRCODE='55000';
  END IF;
  SELECT * INTO claim FROM pathless_publication_object_claims stored
  WHERE stored.allocation_kind='pathless_intent'
    AND stored.allocation_id=NEW.intent_id FOR SHARE;
  IF NOT FOUND OR claim.finalized_at IS NULL
     OR claim.artifact_id IS DISTINCT FROM NEW.artifact_id
     OR claim.body_object_key IS DISTINCT FROM NEW.body_object_key
     OR claim.body_size_bytes IS DISTINCT FROM NEW.body_size_bytes
     OR claim.body_content_hash IS DISTINCT FROM NEW.body_content_hash THEN
    RAISE EXCEPTION 'publication artifact requires an exact finalized object claim'
      USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION list_hypermedia_cutover_blockers()
RETURNS TABLE(blocker_code text,affected_count bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path=pg_catalog,public
SET jit=off
AS $$
  WITH blockers(blocker_code,affected_count) AS (
    SELECT 'pathless_entrypoint_not_latched',count(*)::bigint
    FROM pathless_publication_settings WHERE updated_at IS NULL HAVING count(*)>0
    UNION ALL
    SELECT 'active_page_missing_hypermedia_identity',count(*)::bigint
    FROM knowledge_pages page LEFT JOIN hypermedia_documents document
      ON document.id=page.id AND document.authority='knowledge'
     AND document.representation='markdown'
    WHERE page.archived_at IS NULL AND document.id IS NULL HAVING count(*)>0
    UNION ALL
    SELECT 'active_asset_missing_hypermedia_identity',count(*)::bigint
    FROM assets asset LEFT JOIN hypermedia_documents document
      ON document.id=asset.id AND document.authority='knowledge'
     AND document.representation='asset'
    WHERE asset.deleted_at IS NULL AND document.id IS NULL HAVING count(*)>0
    UNION ALL
    SELECT 'current_revision_missing_hypermedia_contract',count(*)::bigint
    FROM knowledge_pages page LEFT JOIN knowledge_revision_contracts contract
      ON contract.revision_id=page.current_version_id
     AND contract.document_id=page.id AND contract.link_contract='generic_document_v1'
    WHERE page.archived_at IS NULL AND contract.revision_id IS NULL
    HAVING count(*)>0
    UNION ALL
    SELECT 'current_revision_missing_pathless_search',count(*)::bigint
    FROM knowledge_pages page LEFT JOIN pathless_knowledge_search search
      ON search.document_id=page.id AND search.revision_id=page.current_version_id
    WHERE page.archived_at IS NULL AND search.document_id IS NULL
    HAVING count(*)>0
    UNION ALL
    SELECT 'legacy_page_visibility_not_adopted',count(*)::bigint
    FROM knowledge_pages page JOIN public_resources resource
      ON resource.original_document_id=page.id AND resource.document_id=page.id
     AND resource.resource_kind='page'
    LEFT JOIN page_publications publication ON publication.public_id=resource.public_id
    WHERE page.public_path IS NOT NULL AND publication.public_id IS NULL
    HAVING count(*)>0
    UNION ALL
    SELECT 'legacy_asset_visibility_not_adopted',count(*)::bigint
    FROM assets asset JOIN public_resources resource
      ON resource.original_document_id=asset.id AND resource.document_id=asset.id
     AND resource.resource_kind='asset'
    LEFT JOIN asset_publications publication ON publication.public_id=resource.public_id
    WHERE asset.public_path IS NOT NULL AND publication.public_id IS NULL
    HAVING count(*)>0
    UNION ALL
    SELECT 'active_public_resource_detached',count(*)::bigint
    FROM public_resources resource WHERE resource.document_id IS NULL AND (
      EXISTS (SELECT 1 FROM page_publications publication
        WHERE publication.public_id=resource.public_id)
      OR EXISTS (SELECT 1 FROM asset_publications publication
        WHERE publication.public_id=resource.public_id)
    ) HAVING count(*)>0
    UNION ALL
    SELECT 'unresolved_public_namespace_conflict',count(*)::bigint
    FROM public_namespace_conflicts WHERE resolved_at IS NULL HAVING count(*)>0
  )
  SELECT blocker_code,affected_count FROM blockers ORDER BY blocker_code;
$$;

CREATE OR REPLACE FUNCTION begin_hypermedia_bootstrap()
RETURNS TABLE(document_kind text,document_id uuid,revision_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
DECLARE cutover_finalized_at timestamptz;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('filesystem-hypermedia-corpus-transition',0)
  );
  SELECT finalized_at INTO cutover_finalized_at
  FROM hypermedia_cutover_state WHERE singleton FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'hypermedia cutover state is missing' USING ERRCODE='55000';
  END IF;
  IF cutover_finalized_at IS NOT NULL THEN RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM hypermedia_bootstrap_allocations) THEN
    IF EXISTS (SELECT 1 FROM hypermedia_documents)
       OR EXISTS (SELECT 1 FROM knowledge_pages)
       OR EXISTS (SELECT 1 FROM assets)
       OR EXISTS (SELECT 1 FROM automation_registry)
       OR EXISTS (SELECT 1 FROM public_resources)
       OR EXISTS (SELECT 1 FROM knowledge_settings
         WHERE global_guide_document_id IS NOT NULL)
       OR EXISTS (SELECT 1 FROM pathless_publication_settings
         WHERE updated_at IS NOT NULL) THEN
      RAISE EXCEPTION
        'retained data requires a completed v0.1.82 hypermedia cutover'
        USING ERRCODE='55000';
    END IF;
    INSERT INTO hypermedia_bootstrap_allocations(
      document_kind,document_id,revision_id
    ) SELECT kind,gen_random_uuid(),gen_random_uuid() FROM unnest(ARRAY[
      'global_guide','activity_distiller_instructions',
      'activity_distiller_state','diary_composer_instructions',
      'diary_composer_state'
    ]::text[]) kind;
  END IF;
  IF (SELECT count(*) FROM hypermedia_bootstrap_allocations)<>5 THEN
    RAISE EXCEPTION 'hypermedia bootstrap allocation set is incomplete'
      USING ERRCODE='55000';
  END IF;
  RETURN QUERY SELECT allocation.document_kind,allocation.document_id,
    allocation.revision_id FROM hypermedia_bootstrap_allocations allocation
    ORDER BY allocation.document_kind;
END;
$$;

CREATE VIEW private_document_catalog
WITH (security_barrier=true,security_invoker=false)
AS
SELECT document.id AS document_id,'knowledge'::text AS document_kind,
  document.authority,document.representation,
  CASE WHEN page.archived_at IS NULL THEN 'active' ELSE 'archived' END AS lifecycle,
  page.current_version_id AS current_revision_id,
  revision.revision_number AS current_revision_number,version.title,version.summary,
  NULL::text AS filename,NULL::text AS content_type,
  revision.body_size_bytes::bigint AS size_bytes,
  revision.body_content_hash AS content_hash,NULL::integer AS width,
  NULL::integer AS height,NULL::numeric AS duration_seconds,
  NULL::text AS integration,NULL::bigint AS connection_instance_id,
  NULL::text AS connection_id,NULL::text AS source_model,
  NULL::text AS source_record_id,
  array_remove(ARRAY[
    CASE WHEN settings.global_guide_document_id=page.id
      THEN 'global_guide' END,
    CASE WHEN EXISTS (SELECT 1 FROM automation_registry registry
      WHERE registry.instructions_document_id=page.id)
      THEN 'automation_instructions' END,
    CASE WHEN EXISTS (SELECT 1 FROM automation_registry registry
      WHERE registry.state_document_id=page.id)
      THEN 'automation_state' END
  ],NULL) AS operational_roles,
  resource.public_id,
  page.published_version_id IS NOT NULL AND page.public_path IS NOT NULL
    AS legacy_published,
  contract.link_contract::text AS current_link_contract,revision.links_indexed_at,
  coalesce(search.revision_id=page.current_version_id,false) AS pathless_search_ready,
  document.created_at,document.updated_at
FROM hypermedia_documents document
JOIN knowledge_pages page ON page.id=document.id
JOIN knowledge_page_versions version
  ON version.id=page.current_version_id AND version.page_id=page.id
JOIN hypermedia_document_revisions revision
  ON revision.id=page.current_version_id AND revision.document_id=page.id
LEFT JOIN knowledge_settings settings ON settings.singleton
LEFT JOIN public_resources resource ON resource.document_id=page.id
LEFT JOIN knowledge_revision_contracts contract
  ON contract.revision_id=page.current_version_id
LEFT JOIN pathless_knowledge_search search ON search.document_id=page.id
WHERE document.authority='knowledge' AND document.representation='markdown'
UNION ALL
SELECT document.id,'record',document.authority,document.representation,
  CASE WHEN record.deleted_at IS NULL THEN 'active' ELSE 'deleted' END,
  record.current_revision_id,revision.revision_number,NULL,NULL,NULL,NULL,
  revision.body_size_bytes::bigint,revision.body_content_hash,NULL,NULL,NULL,
  record.integration,record.connection_instance_id,record.connection_id,
  record.model,record.source_record_id,'{}'::text[],NULL::uuid,false,NULL::text,
  revision.links_indexed_at,
  CASE WHEN record.current_revision_id IS NULL THEN record.deleted_at IS NOT NULL
    ELSE revision.id IS NOT NULL AND revision.links_indexed_at IS NOT NULL END,
  document.created_at,document.updated_at
FROM hypermedia_documents document
JOIN source_records record ON record.document_id=document.id
LEFT JOIN hypermedia_document_revisions revision
  ON revision.id=record.current_revision_id
 AND revision.document_id=record.document_id
WHERE document.authority='source' AND document.representation='markdown'
UNION ALL
SELECT document.id,'asset',document.authority,document.representation,
  CASE WHEN asset.deleted_at IS NULL THEN 'active' ELSE 'deleted' END,
  NULL::uuid,NULL::integer,NULL::text,NULL::text,asset.filename,
  asset.content_type,asset.size_bytes,asset.content_hash,asset.width,asset.height,
  asset.duration_seconds,NULL::text,NULL::bigint,NULL::text,NULL::text,NULL::text,
  '{}'::text[],resource.public_id,asset.public_path IS NOT NULL,NULL::text,
  NULL::timestamptz,true,document.created_at,document.updated_at
FROM hypermedia_documents document
JOIN assets asset ON asset.id=document.id
LEFT JOIN public_resources resource ON resource.document_id=asset.id
WHERE document.authority='knowledge' AND document.representation='asset';

ALTER VIEW private_document_catalog OWNER TO context_use_projection_owner;
GRANT SELECT ON private_document_catalog
  TO context_use_dashboard,context_use_mcp,context_use_backup;
