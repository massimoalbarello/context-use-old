-- Add a bounded, revision-scoped designation for canonical entity pages.
-- Entity labels remain outside the full-text document vector: they are facets,
-- with only a modest ranking boost after a page already matches the query.

CREATE TYPE knowledge_entity_type AS ENUM (
  'person',
  'organization',
  'place',
  'event',
  'thing'
);

ALTER TABLE knowledge_page_versions
  ADD COLUMN entity_type knowledge_entity_type;

GRANT INSERT(entity_type) ON knowledge_page_versions
  TO context_use_dashboard,context_use_mcp;
GRANT SELECT(entity_type) ON knowledge_page_versions TO
  context_use_projection_owner,
  context_use_boundary_owner,
  context_use_storage,
  context_use_storage_owner,
  context_use_document_history_owner;

GRANT USAGE ON TYPE knowledge_entity_type TO
  context_use_boundary_owner,
  context_use_projection_owner,
  context_use_dashboard,
  context_use_mcp,
  context_use_backup;

CREATE OR REPLACE VIEW private_document_catalog
WITH (security_barrier='true', security_invoker='false') AS
SELECT document.id AS document_id,
  'knowledge'::text AS document_kind,
  document.authority,
  document.representation,
  CASE WHEN page.archived_at IS NULL THEN 'active'::text ELSE 'archived'::text END
    AS lifecycle,
  page.current_version_id AS current_revision_id,
  revision.revision_number AS current_revision_number,
  version.title,
  version.summary,
  NULL::text AS filename,
  NULL::text AS content_type,
  revision.body_size_bytes::bigint AS size_bytes,
  revision.body_content_hash AS content_hash,
  NULL::integer AS width,
  NULL::integer AS height,
  NULL::numeric AS duration_seconds,
  NULL::text AS integration,
  NULL::bigint AS connection_instance_id,
  NULL::text AS connection_id,
  NULL::text AS source_model,
  NULL::text AS source_record_id,
  array_remove(ARRAY[
    CASE WHEN settings.global_guide_document_id=page.id
      THEN 'global_guide'::text END,
    CASE WHEN EXISTS (
      SELECT 1 FROM automation_registry registry
      WHERE registry.instructions_document_id=page.id
    ) THEN 'automation_instructions'::text END,
    CASE WHEN EXISTS (
      SELECT 1 FROM automation_registry registry
      WHERE registry.state_document_id=page.id
    ) THEN 'automation_state'::text END
  ],NULL::text) AS operational_roles,
  resource.public_id,
  contract.link_contract::text AS current_link_contract,
  revision.links_indexed_at,
  coalesce(search.revision_id=page.current_version_id,false) AS search_ready,
  document.created_at,
  document.updated_at,
  version.entity_type
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
LEFT JOIN knowledge_search search ON search.document_id=page.id
WHERE document.authority='knowledge' AND document.representation='markdown'
UNION ALL
SELECT document.id,
  'record'::text,
  document.authority,
  document.representation,
  CASE WHEN record.deleted_at IS NULL THEN 'active'::text ELSE 'deleted'::text END,
  record.current_revision_id,
  revision.revision_number,
  NULL::text,
  NULL::text,
  NULL::text,
  NULL::text,
  revision.body_size_bytes::bigint,
  revision.body_content_hash,
  NULL::integer,
  NULL::integer,
  NULL::numeric,
  record.integration,
  record.connection_instance_id,
  record.connection_id,
  record.model,
  record.source_record_id,
  '{}'::text[],
  NULL::uuid,
  NULL::text,
  revision.links_indexed_at,
  CASE WHEN record.current_revision_id IS NULL THEN record.deleted_at IS NOT NULL
    ELSE revision.id IS NOT NULL AND revision.links_indexed_at IS NOT NULL END,
  document.created_at,
  document.updated_at,
  NULL::knowledge_entity_type
FROM hypermedia_documents document
JOIN source_records record ON record.document_id=document.id
LEFT JOIN hypermedia_document_revisions revision
  ON revision.id=record.current_revision_id
 AND revision.document_id=record.document_id
WHERE document.authority='source' AND document.representation='markdown'
UNION ALL
SELECT document.id,
  'asset'::text,
  document.authority,
  document.representation,
  CASE WHEN asset.deleted_at IS NULL THEN 'active'::text ELSE 'deleted'::text END,
  NULL::uuid,
  NULL::integer,
  NULL::text,
  NULL::text,
  asset.filename,
  asset.content_type,
  asset.size_bytes,
  asset.content_hash,
  asset.width,
  asset.height,
  asset.duration_seconds,
  NULL::text,
  NULL::bigint,
  NULL::text,
  NULL::text,
  NULL::text,
  '{}'::text[],
  resource.public_id,
  NULL::text,
  NULL::timestamptz,
  true,
  document.created_at,
  document.updated_at,
  NULL::knowledge_entity_type
FROM hypermedia_documents document
JOIN assets asset ON asset.id=document.id
LEFT JOIN public_resources resource ON resource.document_id=asset.id
WHERE document.authority='knowledge' AND document.representation='asset';

CREATE FUNCTION search_private_document_catalog(
  p_query text,
  p_after_rank real,
  p_after_updated_at_epoch_micros bigint,
  p_after_document_id uuid,
  p_include_retired boolean,
  p_limit integer,
  p_authority hypermedia_document_authority,
  p_representation hypermedia_document_representation,
  p_document_kind private_document_kind,
  p_lifecycle private_document_lifecycle,
  p_integration text,
  p_operational_role private_document_operational_role,
  p_catalog_types text[],
  p_entity_types knowledge_entity_type[]
) RETURNS TABLE(
  document jsonb,
  search_rank real,
  search_updated_at_epoch_micros text,
  search_document_id uuid
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
BEGIN
  IF btrim(coalesce(p_query,''))='' OR octet_length(p_query)>2048 THEN
    RAISE EXCEPTION 'private document search query is invalid' USING ERRCODE='22023';
  END IF;
  IF p_limit IS NULL OR p_limit<1 OR p_limit>101 THEN
    RAISE EXCEPTION 'private document search limit is invalid' USING ERRCODE='22023';
  END IF;
  IF (p_after_document_id IS NULL)<>(p_after_rank IS NULL)
     OR (p_after_document_id IS NULL)<>(p_after_updated_at_epoch_micros IS NULL)
     OR (p_after_rank IS NOT NULL AND (
       p_after_rank<0 OR p_after_rank::text IN ('Infinity','-Infinity','NaN')
     )) THEN
    RAISE EXCEPTION 'private document search cursor is invalid' USING ERRCODE='22023';
  END IF;
  IF p_catalog_types IS NOT NULL AND (
    cardinality(p_catalog_types)<1
    OR cardinality(p_catalog_types)>5
    OR array_position(p_catalog_types,NULL) IS NOT NULL
    OR EXISTS (
      SELECT 1 FROM unnest(p_catalog_types) entry(value)
      WHERE entry.value<>ALL(ARRAY[
        'knowledge','record','asset','public','archived'
      ]::text[])
    )
    OR cardinality(p_catalog_types)<>(
      SELECT count(DISTINCT entry.value)
      FROM unnest(p_catalog_types) entry(value)
    )
  ) THEN
    RAISE EXCEPTION 'private document catalog types are invalid' USING ERRCODE='22023';
  END IF;
  IF p_entity_types IS NOT NULL AND (
    cardinality(p_entity_types)<1
    OR cardinality(p_entity_types)>5
    OR array_position(p_entity_types,NULL) IS NOT NULL
    OR cardinality(p_entity_types)<>(
      SELECT count(DISTINCT entry.value)
      FROM unnest(p_entity_types) entry(value)
    )
  ) THEN
    RAISE EXCEPTION 'knowledge entity types are invalid' USING ERRCODE='22023';
  END IF;
  IF p_entity_types IS NOT NULL AND (
    p_document_kind IS NOT NULL AND p_document_kind<>'knowledge'
    OR p_catalog_types IS NOT NULL AND EXISTS (
      SELECT 1 FROM unnest(p_catalog_types) entry(value)
      WHERE entry.value IN ('record','asset')
    )
  ) THEN
    RAISE EXCEPTION 'knowledge entity types apply only to pages' USING ERRCODE='22023';
  END IF;

  RETURN QUERY
  WITH query AS (
    SELECT plainto_tsquery('english',regexp_replace(
        p_query,'[[:punct:]]+',' ','g'
      )) AS english,
      plainto_tsquery('simple',regexp_replace(
        p_query,'[[:punct:]]+',' ','g'
      )) AS simple,
      tsvector_to_array(to_tsvector('simple',regexp_replace(
        p_query,'[[:punct:]]+',' ','g'
      ))) AS terms
  ), knowledge_base AS (
    SELECT catalog.document_id,coalesce(
      search.search_vector,
      document_search_vector(catalog.title,catalog.summary,'')
    ) AS search_vector
    FROM private_document_catalog catalog
    LEFT JOIN knowledge_search search
      ON search.document_id=catalog.document_id
     AND search.revision_id=catalog.current_revision_id
    WHERE catalog.document_kind='knowledge'
  ), knowledge_term_vectors AS (
    SELECT base.document_id,base.search_vector
    FROM knowledge_base base
    UNION ALL
    SELECT chunk.document_id,chunk.search_vector
    FROM knowledge_search_chunks chunk
    JOIN private_document_catalog catalog
      ON catalog.document_id=chunk.document_id
     AND catalog.current_revision_id=chunk.revision_id
     AND catalog.document_kind='knowledge'
  ), knowledge_candidate_scores AS (
    SELECT base.document_id,greatest(
      ts_rank(base.search_vector,query.english),
      ts_rank(base.search_vector,query.simple)
    ) AS rank
    FROM knowledge_base base
    CROSS JOIN query
    WHERE base.search_vector @@ query.english
       OR base.search_vector @@ query.simple
    UNION ALL
    SELECT chunk.document_id,max(greatest(
      ts_rank(chunk.search_vector,query.english),
      ts_rank(chunk.search_vector,query.simple)
    )) AS rank
    FROM knowledge_search_chunks chunk
    JOIN private_document_catalog catalog
      ON catalog.document_id=chunk.document_id
     AND catalog.current_revision_id=chunk.revision_id
     AND catalog.document_kind='knowledge'
    CROSS JOIN query
    WHERE chunk.search_vector @@ query.english
       OR chunk.search_vector @@ query.simple
    GROUP BY chunk.document_id
    UNION ALL
    SELECT vector.document_id,0::real AS rank
    FROM query
    CROSS JOIN LATERAL unnest(query.terms) expected(term)
    JOIN knowledge_term_vectors vector
      ON vector.search_vector @@ plainto_tsquery('english',expected.term)
      OR vector.search_vector @@ plainto_tsquery('simple',expected.term)
    WHERE cardinality(query.terms)>0
    GROUP BY vector.document_id
    HAVING count(DISTINCT expected.term)=(SELECT cardinality(terms) FROM query)
  ), knowledge_candidates AS (
    SELECT document_id,max(rank) AS rank
    FROM knowledge_candidate_scores
    GROUP BY document_id
  ), record_candidate_scores AS (
    SELECT source.document_id,
      ts_rank(source.search_vector,query.english) AS rank
    FROM source_records source
    CROSS JOIN query
    WHERE source.search_vector @@ query.english
    UNION ALL
    SELECT chunk.document_id,
      max(ts_rank(chunk.search_vector,query.english)) AS rank
    FROM source_record_search_chunks chunk
    CROSS JOIN query
    WHERE chunk.search_vector @@ query.english
    GROUP BY chunk.document_id
    UNION ALL
    SELECT chunk.document_id,0::real AS rank
    FROM query
    CROSS JOIN LATERAL unnest(query.terms) expected(term)
    JOIN source_record_search_chunks chunk
      ON chunk.search_vector @@ plainto_tsquery('english',expected.term)
    WHERE cardinality(query.terms)>0
    GROUP BY chunk.document_id
    HAVING count(DISTINCT expected.term)=(SELECT cardinality(terms) FROM query)
  ), record_candidates AS (
    SELECT document_id,max(rank) AS rank
    FROM record_candidate_scores
    GROUP BY document_id
  ), scored AS (
    SELECT catalog.document_id,catalog.updated_at,
      (extract(epoch FROM catalog.updated_at)*1000000)::bigint
        AS updated_at_epoch_micros,
      CASE catalog.document_kind
        WHEN 'knowledge' THEN (
          knowledge.rank * CASE WHEN catalog.entity_type IS NULL THEN 1.0 ELSE 1.2 END
        )::real
        WHEN 'record' THEN record.rank
        WHEN 'asset' THEN ts_rank(
          to_tsvector('simple',regexp_replace(concat_ws(' ',
            catalog.filename,catalog.content_type
          ),'[[:punct:]]+',' ','g')),
          query.simple
        )
      END AS rank
    FROM private_document_catalog catalog
    CROSS JOIN query
    LEFT JOIN knowledge_candidates knowledge
      ON knowledge.document_id=catalog.document_id
    LEFT JOIN record_candidates record ON record.document_id=catalog.document_id
    WHERE btrim(coalesce(p_query,''))<>''
      AND (
        p_catalog_types IS NULL AND (
          p_lifecycle IS NOT NULL AND catalog.lifecycle=p_lifecycle::text
          OR p_lifecycle IS NULL AND (p_include_retired OR catalog.lifecycle='active')
        )
        OR p_catalog_types IS NOT NULL AND (
          ('knowledge'=ANY(p_catalog_types)
            AND catalog.document_kind='knowledge' AND catalog.lifecycle='active')
          OR ('record'=ANY(p_catalog_types)
            AND catalog.document_kind='record' AND catalog.lifecycle='active')
          OR ('asset'=ANY(p_catalog_types)
            AND catalog.document_kind='asset' AND catalog.lifecycle='active')
          OR ('archived'=ANY(p_catalog_types) AND catalog.lifecycle='archived')
          OR ('public'=ANY(p_catalog_types)
            AND catalog.document_kind='knowledge' AND catalog.lifecycle='active'
            AND EXISTS (
              SELECT 1 FROM page_publications publication
              WHERE publication.public_id=catalog.public_id
            ))
        )
      )
      AND (p_authority IS NULL OR catalog.authority=p_authority)
      AND (p_representation IS NULL OR catalog.representation=p_representation)
      AND (p_document_kind IS NULL OR catalog.document_kind=p_document_kind::text)
      AND (p_entity_types IS NULL OR catalog.entity_type=ANY(p_entity_types))
      AND (p_integration IS NULL OR catalog.integration=p_integration)
      AND (
        p_operational_role IS NULL
        OR p_operational_role::text=ANY(catalog.operational_roles)
      )
      AND (
        (catalog.document_kind='knowledge' AND knowledge.document_id IS NOT NULL)
        OR (catalog.document_kind='record' AND record.document_id IS NOT NULL)
        OR (
          catalog.document_kind='asset'
          AND to_tsvector('simple',regexp_replace(concat_ws(' ',
            catalog.filename,catalog.content_type
          ),'[[:punct:]]+',' ','g')) @@ query.simple
        )
      )
  )
  SELECT to_jsonb(catalog) || jsonb_build_object(
      'size_bytes',CASE WHEN catalog.size_bytes IS NULL
        THEN NULL ELSE catalog.size_bytes::text END,
      'connection_instance_id',CASE WHEN catalog.connection_instance_id IS NULL
        THEN NULL ELSE catalog.connection_instance_id::text END,
      'duration_seconds',CASE WHEN catalog.duration_seconds IS NULL
        THEN NULL ELSE catalog.duration_seconds::text END
    ),scored.rank,
    scored.updated_at_epoch_micros::text,scored.document_id
  FROM scored
  JOIN private_document_catalog catalog USING (document_id)
  WHERE (
    p_after_document_id IS NULL
    OR (
      p_after_rank IS NOT NULL AND p_after_updated_at_epoch_micros IS NOT NULL
      AND scored.document_id<>p_after_document_id AND (
        scored.rank<p_after_rank
        OR (
          scored.rank=p_after_rank
          AND scored.updated_at_epoch_micros<p_after_updated_at_epoch_micros
        )
        OR (
          scored.rank=p_after_rank
          AND scored.updated_at_epoch_micros=p_after_updated_at_epoch_micros
          AND scored.document_id::text COLLATE "C"
            >p_after_document_id::text COLLATE "C"
        )
      )
    )
  )
  ORDER BY scored.rank DESC,scored.updated_at DESC,
    scored.document_id::text COLLATE "C"
  LIMIT p_limit;
END;
$$;

ALTER FUNCTION search_private_document_catalog(
  text,real,bigint,uuid,boolean,integer,
  hypermedia_document_authority,hypermedia_document_representation,
  private_document_kind,private_document_lifecycle,text,
  private_document_operational_role,text[],knowledge_entity_type[]
) OWNER TO context_use_projection_owner;
REVOKE ALL ON FUNCTION search_private_document_catalog(
  text,real,bigint,uuid,boolean,integer,
  hypermedia_document_authority,hypermedia_document_representation,
  private_document_kind,private_document_lifecycle,text,
  private_document_operational_role,text[],knowledge_entity_type[]
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION search_private_document_catalog(
  text,real,bigint,uuid,boolean,integer,
  hypermedia_document_authority,hypermedia_document_representation,
  private_document_kind,private_document_lifecycle,text,
  private_document_operational_role,text[],knowledge_entity_type[]
) TO context_use_dashboard,context_use_mcp;

DROP FUNCTION search_private_document_catalog(
  text,real,bigint,uuid,boolean,integer,
  hypermedia_document_authority,hypermedia_document_representation,
  private_document_kind,private_document_lifecycle,text,
  private_document_operational_role,text[]
);
