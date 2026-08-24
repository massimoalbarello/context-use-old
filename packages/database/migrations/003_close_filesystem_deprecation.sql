-- Remove the last schema vocabulary and ordering names left by the filesystem
-- retirement. The baseline remains immutable; current installations converge
-- here through an ordinary forward migration.

ALTER TYPE private_document_operational_role
  RENAME TO private_document_operational_role_with_directory_hub;

CREATE TYPE private_document_operational_role AS ENUM (
  'global_guide',
  'automation_instructions',
  'automation_state'
);
ALTER TYPE private_document_operational_role OWNER TO postgres;

DO $replace_operational_role_type$
DECLARE
  definition text;
BEGIN
  SELECT pg_get_functiondef(
    'search_private_document_catalog(text,real,bigint,uuid,boolean,integer,'
    'hypermedia_document_authority,hypermedia_document_representation,'
    'private_document_kind,private_document_lifecycle,text,'
    'private_document_operational_role_with_directory_hub)'::regprocedure
  ) INTO definition;
  EXECUTE replace(
    definition,
    'private_document_operational_role_with_directory_hub',
    'private_document_operational_role'
  );
END;
$replace_operational_role_type$;

ALTER FUNCTION search_private_document_catalog(
  text,real,bigint,uuid,boolean,integer,
  hypermedia_document_authority,hypermedia_document_representation,
  private_document_kind,private_document_lifecycle,text,
  private_document_operational_role
) OWNER TO context_use_projection_owner;
REVOKE ALL ON FUNCTION search_private_document_catalog(
  text,real,bigint,uuid,boolean,integer,
  hypermedia_document_authority,hypermedia_document_representation,
  private_document_kind,private_document_lifecycle,text,
  private_document_operational_role
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION search_private_document_catalog(
  text,real,bigint,uuid,boolean,integer,
  hypermedia_document_authority,hypermedia_document_representation,
  private_document_kind,private_document_lifecycle,text,
  private_document_operational_role
) TO context_use_dashboard,context_use_mcp;

DROP FUNCTION search_private_document_catalog(
  text,real,bigint,uuid,boolean,integer,
  hypermedia_document_authority,hypermedia_document_representation,
  private_document_kind,private_document_lifecycle,text,
  private_document_operational_role_with_directory_hub
);
DROP TYPE private_document_operational_role_with_directory_hub;

CREATE OR REPLACE FUNCTION replace_document_links(
  p_source_revision_id uuid,
  p_target_document_ids uuid[]
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
DECLARE
  linked_count integer;
  source_authority hypermedia_document_authority;
BEGIN
  IF p_source_revision_id IS NULL OR p_target_document_ids IS NULL THEN
    RAISE EXCEPTION 'source revision and target document array are required'
      USING ERRCODE='22023';
  END IF;
  IF cardinality(p_target_document_ids)>100000
     OR array_position(p_target_document_ids,NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'target document array is invalid' USING ERRCODE='22023';
  END IF;

  SELECT document.authority INTO source_authority
  FROM hypermedia_document_revisions revision
  JOIN hypermedia_documents document ON document.id=revision.document_id
  WHERE revision.id=p_source_revision_id
  FOR UPDATE OF revision;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'source revision not found' USING ERRCODE='P0002';
  END IF;

  DELETE FROM document_links WHERE source_revision_id=p_source_revision_id;
  INSERT INTO document_links(source_revision_id,target_document_id)
  SELECT p_source_revision_id,document.id
  FROM (SELECT DISTINCT unnest(p_target_document_ids) AS id) target
  JOIN hypermedia_documents document ON document.id=target.id
  WHERE source_authority='knowledge';
  GET DIAGNOSTICS linked_count=ROW_COUNT;

  UPDATE hypermedia_document_revisions
  SET links_indexed_at=now(),links_index_attempted_at=now()
  WHERE id=p_source_revision_id;
  RETURN linked_count;
END;
$$;
ALTER FUNCTION replace_document_links(uuid,uuid[])
  OWNER TO context_use_boundary_owner;

ALTER TRIGGER asset_publications_028_validate_active_mapping
  ON asset_publications RENAME TO asset_publications_validate_active_mapping;
ALTER TRIGGER asset_publications_029_bump_public_visibility
  ON asset_publications RENAME TO asset_publications_bump_public_visibility;
ALTER TRIGGER assets_028_protect_active_publication_delete
  ON assets RENAME TO assets_protect_active_publication_delete;
ALTER TRIGGER assets_028_protect_active_publication_update
  ON assets RENAME TO assets_protect_active_publication_update;
ALTER TRIGGER assets_zz029_bump_publication_target
  ON assets RENAME TO assets_zz_bump_publication_target;
ALTER TRIGGER hypermedia_bootstrap_040_keep_allocations
  ON hypermedia_bootstrap_allocations RENAME TO hypermedia_bootstrap_keep_allocations;
ALTER TRIGGER hypermedia_documents_028_guard_public_uuid
  ON hypermedia_documents RENAME TO hypermedia_documents_guard_public_uuid;
ALTER TRIGGER hypermedia_revisions_028_guard_public_uuid
  ON hypermedia_document_revisions RENAME TO hypermedia_revisions_guard_public_uuid;
ALTER TRIGGER knowledge_pages_028_protect_active_publication_delete
  ON knowledge_pages RENAME TO knowledge_pages_protect_active_publication_delete;
ALTER TRIGGER knowledge_pages_028_protect_active_publication_update
  ON knowledge_pages RENAME TO knowledge_pages_protect_active_publication_update;
ALTER TRIGGER knowledge_pages_037_capture_archive
  ON knowledge_pages RENAME TO knowledge_pages_capture_archive;
ALTER TRIGGER knowledge_pages_zz029_bump_publication_target
  ON knowledge_pages RENAME TO knowledge_pages_zz_bump_publication_target;
ALTER TRIGGER page_publications_028_validate_active_mapping
  ON page_publications RENAME TO page_publications_validate_active_mapping;
ALTER TRIGGER page_publications_029_bump_public_visibility
  ON page_publications RENAME TO page_publications_bump_public_visibility;
ALTER TRIGGER public_artifact_reservations_028_guard_namespace
  ON public_artifact_id_reservations RENAME TO public_artifact_reservations_guard_namespace;
ALTER TRIGGER public_asset_artifacts_029_keep_history
  ON public_asset_artifacts RENAME TO public_asset_artifacts_keep_history;
ALTER TRIGGER public_page_artifacts_029_keep_history
  ON public_page_artifacts RENAME TO public_page_artifacts_keep_history;
ALTER TRIGGER public_representation_tokens_029_keep_immutable
  ON public_representation_token_reservations RENAME TO public_representation_tokens_keep_immutable;
ALTER TRIGGER public_resources_028_guard_identity
  ON public_resources RENAME TO public_resources_guard_identity;
ALTER TRIGGER public_resources_029_initialize_visibility_generation
  ON public_resources RENAME TO public_resources_initialize_visibility_generation;
ALTER TRIGGER public_route_aliases_028_guard_namespace
  ON public_route_aliases RENAME TO public_route_aliases_guard_namespace;
ALTER TRIGGER publication_intent_ids_029_keep_immutable
  ON publication_intent_id_reservations RENAME TO publication_intent_ids_keep_immutable;
ALTER TRIGGER publication_intents_029_reserve_uuid
  ON publication_intents RENAME TO publication_intents_reserve_uuid;
ALTER TRIGGER publication_intents_zz029_keep_history
  ON publication_intents RENAME TO publication_intents_zz_keep_history;
ALTER TRIGGER publication_staging_029_keep_history
  ON publication_artifact_staging RENAME TO publication_staging_keep_history;
ALTER TRIGGER retained_page_artifacts_028_reserve_identity
  ON retained_page_artifacts RENAME TO retained_page_artifacts_reserve_identity;
