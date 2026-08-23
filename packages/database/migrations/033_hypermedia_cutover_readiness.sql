-- Make the filesystem-to-hypermedia cutover a checked database state rather
-- than an application assumption. The corpus one-shot calls this boundary
-- after revision hydration and retained-publication adoption; the following
-- contraction migration calls the same assertion before removing any bridge.

SELECT pg_advisory_xact_lock(
  hashtextextended('filesystem-hypermedia-corpus-transition',0)
);

CREATE FUNCTION list_hypermedia_cutover_blockers()
RETURNS TABLE (
  blocker_code text,
  affected_count bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path=pg_catalog,public
SET jit=off
AS $$
  WITH blockers(blocker_code,affected_count) AS (
    SELECT 'corpus_migration_in_progress',count(*)::bigint
    FROM corpus_migration_runs WHERE phase='applying'
    HAVING count(*)>0
    UNION ALL
    SELECT 'operational_replacement_planned',count(*)::bigint
    FROM operational_document_replacements WHERE phase='planned'
    HAVING count(*)>0
    UNION ALL
    SELECT 'retained_publication_adoption_pending',count(*)::bigint
    FROM list_pathless_publication_adoption_candidates()
    HAVING count(*)>0
    UNION ALL
    SELECT 'publication_adoption_plan_pending',count(*)::bigint
    FROM pathless_publication_adoptions WHERE phase='planned'
    HAVING count(*)>0
    UNION ALL
    SELECT 'publication_adoption_object_pending',count(*)::bigint
    FROM pathless_publication_object_claims claim
    JOIN pathless_publication_adoptions adoption
      ON adoption.id=claim.allocation_id
     AND claim.allocation_kind='pathless_adoption'
    WHERE adoption.phase='planned' AND claim.finalized_at IS NULL
    HAVING count(*)>0
    UNION ALL
    SELECT 'pathless_entrypoint_not_latched',count(*)::bigint
    FROM pathless_publication_settings WHERE updated_at IS NULL
    HAVING count(*)>0
    UNION ALL
    SELECT 'active_page_missing_hypermedia_identity',count(*)::bigint
    FROM knowledge_pages page
    LEFT JOIN hypermedia_documents document
      ON document.id=page.id
     AND document.authority='knowledge'
     AND document.representation='markdown'
    WHERE page.archived_at IS NULL AND document.id IS NULL
    HAVING count(*)>0
    UNION ALL
    SELECT 'active_asset_missing_hypermedia_identity',count(*)::bigint
    FROM assets asset
    LEFT JOIN hypermedia_documents document
      ON document.id=asset.id
     AND document.authority='knowledge'
     AND document.representation='asset'
    WHERE asset.deleted_at IS NULL AND document.id IS NULL
    HAVING count(*)>0
    UNION ALL
    SELECT 'current_revision_missing_hypermedia_contract',count(*)::bigint
    FROM knowledge_pages page
    LEFT JOIN knowledge_revision_contracts contract
      ON contract.revision_id=page.current_version_id
     AND contract.document_id=page.id
     AND contract.link_contract='generic_document_v1'
    WHERE page.archived_at IS NULL AND contract.revision_id IS NULL
    HAVING count(*)>0
    UNION ALL
    SELECT 'current_revision_missing_pathless_search',count(*)::bigint
    FROM knowledge_pages page
    LEFT JOIN pathless_knowledge_search search
      ON search.document_id=page.id
     AND search.revision_id=page.current_version_id
    WHERE page.archived_at IS NULL AND search.document_id IS NULL
    HAVING count(*)>0
    UNION ALL
    SELECT 'legacy_page_visibility_not_adopted',count(*)::bigint
    FROM knowledge_pages page
    JOIN public_resources resource
      ON resource.original_document_id=page.id
     AND resource.document_id=page.id
     AND resource.resource_kind='page'
    LEFT JOIN page_publications publication
      ON publication.public_id=resource.public_id
    WHERE page.public_path IS NOT NULL AND publication.public_id IS NULL
    HAVING count(*)>0
    UNION ALL
    SELECT 'legacy_asset_visibility_not_adopted',count(*)::bigint
    FROM assets asset
    JOIN public_resources resource
      ON resource.original_document_id=asset.id
     AND resource.document_id=asset.id
     AND resource.resource_kind='asset'
    LEFT JOIN asset_publications publication
      ON publication.public_id=resource.public_id
    WHERE asset.public_path IS NOT NULL AND publication.public_id IS NULL
    HAVING count(*)>0
    UNION ALL
    SELECT 'directory_hub_visibility_not_adopted',count(*)::bigint
    FROM directory_hub_migrations hub
    LEFT JOIN page_publications publication
      ON publication.public_id=hub.public_id
    WHERE hub.public_id IS NOT NULL AND publication.public_id IS NULL
    HAVING count(*)>0
    UNION ALL
    SELECT 'active_public_resource_detached',count(*)::bigint
    FROM public_resources resource
    WHERE resource.document_id IS NULL AND (
      EXISTS (SELECT 1 FROM page_publications publication
        WHERE publication.public_id=resource.public_id)
      OR EXISTS (SELECT 1 FROM asset_publications publication
        WHERE publication.public_id=resource.public_id)
    )
    HAVING count(*)>0
    UNION ALL
    SELECT 'unresolved_public_namespace_conflict',count(*)::bigint
    FROM public_namespace_conflicts WHERE resolved_at IS NULL
    HAVING count(*)>0
  )
  SELECT blocker_code,affected_count
  FROM blockers
  ORDER BY blocker_code;
$$;

CREATE FUNCTION assert_hypermedia_cutover_ready()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
SET jit=off
AS $$
DECLARE
  blockers text;
BEGIN
  PERFORM pg_advisory_xact_lock_shared(
    hashtextextended('filesystem-hypermedia-corpus-transition',0)
  );
  SELECT string_agg(blocker_code||'='||affected_count::text,',' ORDER BY blocker_code)
  INTO blockers
  FROM list_hypermedia_cutover_blockers();
  IF blockers IS NOT NULL THEN
    RAISE EXCEPTION 'hypermedia cutover is not ready: %',blockers
      USING ERRCODE='55000';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION list_hypermedia_cutover_blockers() FROM PUBLIC;
REVOKE ALL ON FUNCTION assert_hypermedia_cutover_ready() FROM PUBLIC;

GRANT SELECT (phase) ON corpus_migration_runs,
  operational_document_replacements TO context_use_boundary_owner;
GRANT SELECT (id,phase) ON pathless_publication_adoptions
  TO context_use_boundary_owner;
GRANT SELECT (allocation_kind,allocation_id,finalized_at)
  ON pathless_publication_object_claims TO context_use_boundary_owner;
GRANT SELECT (updated_at) ON pathless_publication_settings
  TO context_use_boundary_owner;
GRANT SELECT (id,current_version_id,archived_at,public_path)
  ON knowledge_pages TO context_use_boundary_owner;
GRANT SELECT (id,deleted_at,public_path) ON assets
  TO context_use_boundary_owner;
GRANT SELECT (id,authority,representation) ON hypermedia_documents
  TO context_use_boundary_owner;
GRANT SELECT (revision_id,document_id,link_contract)
  ON knowledge_revision_contracts TO context_use_boundary_owner;
GRANT SELECT (document_id,revision_id) ON pathless_knowledge_search
  TO context_use_boundary_owner;
GRANT SELECT (public_id,original_document_id,document_id,resource_kind)
  ON public_resources TO context_use_boundary_owner;
GRANT SELECT (public_id) ON page_publications,asset_publications
  TO context_use_boundary_owner;
GRANT SELECT (public_id) ON directory_hub_migrations
  TO context_use_boundary_owner;
GRANT SELECT (resolved_at) ON public_namespace_conflicts
  TO context_use_boundary_owner;

GRANT USAGE,CREATE ON SCHEMA public TO context_use_boundary_owner;
ALTER FUNCTION list_hypermedia_cutover_blockers()
  OWNER TO context_use_boundary_owner;
ALTER FUNCTION assert_hypermedia_cutover_ready()
  OWNER TO context_use_boundary_owner;
REVOKE CREATE ON SCHEMA public FROM context_use_boundary_owner;

GRANT EXECUTE ON FUNCTION list_hypermedia_cutover_blockers()
  TO context_use_corpus;
GRANT EXECUTE ON FUNCTION assert_hypermedia_cutover_ready()
  TO context_use_corpus;
