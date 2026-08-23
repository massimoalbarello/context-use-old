-- Expose the exact retained-publication worklist to the isolated corpus
-- activation job. The list contains no object keys or private revision data;
-- every returned source is revalidated and locked by the existing adoption
-- boundaries before an immutable artifact can be staged or applied.

SELECT pg_advisory_xact_lock(
  hashtextextended('filesystem-hypermedia-corpus-transition',0)
);

CREATE FUNCTION list_pathless_publication_adoption_candidates()
RETURNS TABLE (
  adoption_kind pathless_publication_adoption_kind,
  source_document_id uuid,
  adoption_id uuid
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
  WITH eligible AS (
    SELECT 'legacy_page'::pathless_publication_adoption_kind AS adoption_kind,
      page.id AS source_document_id,1 AS adoption_order,0 AS dependency_depth
    FROM knowledge_pages page
    JOIN public_resources resource
      ON resource.original_document_id=page.id
     AND resource.document_id=page.id
     AND resource.resource_kind='page'
    JOIN knowledge_page_versions version
      ON version.id=page.published_version_id
     AND version.page_id=page.id
    JOIN public_projection_state projection ON projection.singleton
    JOIN published_page_artifacts artifact
      ON artifact.page_id=page.id
     AND artifact.version_id=version.id
     AND artifact.projection_generation=projection.generation
    WHERE page.archived_at IS NULL
      AND page.public_path IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM directory_hub_migrations mapping
        WHERE mapping.document_id=page.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM page_publications publication
        WHERE publication.public_id=resource.public_id
      )
    UNION ALL
    SELECT 'legacy_asset'::pathless_publication_adoption_kind,
      asset.id,2,0
    FROM assets asset
    JOIN public_resources resource
      ON resource.original_document_id=asset.id
     AND resource.document_id=asset.id
     AND resource.resource_kind='asset'
    WHERE asset.deleted_at IS NULL
      AND asset.public_path IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM asset_publications publication
        WHERE publication.public_id=resource.public_id
      )
    UNION ALL
    SELECT 'directory_hub'::pathless_publication_adoption_kind,
      mapping.document_id,3,
      cardinality(string_to_array(mapping.legacy_path,'/'))
    FROM directory_hub_migrations mapping
    JOIN corpus_migration_runs run
      ON run.id=mapping.migration_run_id AND run.phase='ready'
    JOIN knowledge_pages page
      ON page.id=mapping.document_id
     AND page.archived_at IS NULL
     AND page.current_path=mapping.temporary_path
     AND page.current_version_id=mapping.private_revision_id
    JOIN public_resources resource
      ON resource.public_id=mapping.public_id
     AND resource.original_document_id=mapping.document_id
     AND resource.document_id=mapping.document_id
     AND resource.resource_kind='page'
    WHERE mapping.public_id IS NOT NULL
      AND mapping.public_revision_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM page_publications publication
        WHERE publication.public_id=mapping.public_id
      )
  )
  SELECT eligible.adoption_kind,eligible.source_document_id,planned.id
  FROM eligible
  LEFT JOIN pathless_publication_adoptions planned
    ON planned.adoption_kind=eligible.adoption_kind
   AND planned.source_document_id=eligible.source_document_id
   AND planned.phase='planned'
  WHERE NOT EXISTS (
    SELECT 1 FROM pathless_publication_adoptions applied
    WHERE applied.adoption_kind=eligible.adoption_kind
      AND applied.source_document_id=eligible.source_document_id
      AND applied.phase='applied'
  )
  -- Directory indexes link to their children. Promote the deepest retained
  -- hubs first so a parent snapshot sees every already-adopted child as an
  -- active public target rather than freezing an avoidable omission.
  ORDER BY eligible.adoption_order,eligible.dependency_depth DESC,
    eligible.source_document_id;
$$;

REVOKE ALL ON FUNCTION list_pathless_publication_adoption_candidates()
  FROM PUBLIC;

GRANT USAGE,CREATE ON SCHEMA public TO context_use_boundary_owner;
ALTER FUNCTION list_pathless_publication_adoption_candidates()
  OWNER TO context_use_boundary_owner;
REVOKE CREATE ON SCHEMA public FROM context_use_boundary_owner;

GRANT EXECUTE ON FUNCTION list_pathless_publication_adoption_candidates()
  TO context_use_corpus;
