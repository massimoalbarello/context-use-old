-- Give the authenticated dashboard one exact, read-only publication status
-- boundary without granting it artifact, pin, or public-resource table access.

SELECT pg_advisory_xact_lock(
  hashtextextended('filesystem-hypermedia-corpus-transition',0)
);

CREATE FUNCTION get_pathless_dashboard_publication_status(
  p_target_kind publication_target,
  p_target_document_id uuid
)
RETURNS TABLE (
  public_id uuid,
  published_revision_id uuid,
  published_revision_number integer,
  active boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
BEGIN
  IF p_target_kind='page' THEN
    RETURN QUERY
    SELECT resource.public_id,
      CASE WHEN active_page.public_id IS NOT NULL
        THEN artifact.source_revision_id ELSE NULL END,
      CASE WHEN active_page.public_id IS NOT NULL
        THEN version.version_number ELSE NULL END,
      active_page.public_id IS NOT NULL
    FROM (SELECT 1) singleton
    LEFT JOIN public_resources resource
      ON resource.resource_kind='page'
     AND resource.document_id=p_target_document_id
    LEFT JOIN page_publications pin
      ON pin.public_id=resource.public_id
    LEFT JOIN public_page_artifacts artifact
      ON artifact.public_id=pin.public_id
     AND artifact.artifact_id=pin.artifact_id
    LEFT JOIN knowledge_page_versions version
      ON version.id=artifact.source_revision_id
     AND version.page_id=p_target_document_id
    LEFT JOIN pathless_public_pages active_page
      ON active_page.public_id=resource.public_id
    LIMIT 1;
    RETURN;
  END IF;

  RETURN QUERY
  SELECT resource.public_id,NULL::uuid,NULL::integer,
    active_asset.public_id IS NOT NULL
  FROM (SELECT 1) singleton
  LEFT JOIN public_resources resource
    ON resource.resource_kind='asset'
   AND resource.document_id=p_target_document_id
  LEFT JOIN pathless_public_assets active_asset
    ON active_asset.public_id=resource.public_id
  LIMIT 1;
END;
$$;

REVOKE ALL ON FUNCTION get_pathless_dashboard_publication_status(
  publication_target,uuid
) FROM PUBLIC;

GRANT USAGE,CREATE ON SCHEMA public TO context_use_boundary_owner;
ALTER FUNCTION get_pathless_dashboard_publication_status(
  publication_target,uuid
) OWNER TO context_use_boundary_owner;
REVOKE CREATE ON SCHEMA public FROM context_use_boundary_owner;

GRANT EXECUTE ON FUNCTION get_pathless_dashboard_publication_status(
  publication_target,uuid
) TO context_use_dashboard;
