-- Add the pathless authored-document contract alongside the legacy filesystem
-- projection. Paths remain required compatibility labels until a separately
-- ordered contraction; no existing table, column, view or writer is removed.

CREATE TYPE knowledge_revision_link_contract AS ENUM ('generic_document_v1');
CREATE TYPE knowledge_revision_contract_provenance AS ENUM (
  'authored','corpus_migration'
);
CREATE TYPE private_document_kind AS ENUM ('knowledge','record','asset');
CREATE TYPE private_document_lifecycle AS ENUM ('active','archived','deleted');
CREATE TYPE private_document_operational_role AS ENUM (
  'global_guide','automation_instructions','automation_state','directory_hub'
);

-- The receipt is the application/parser-attested target set, including
-- dangling UUIDs. This additive private-write contract proves current body
-- integrity and canonicalizes the submitted set; it is not a cutover or
-- publication security attestation. document_links remains the readable/extant
-- projection, so a missing target never makes authored text impossible to
-- retain.
CREATE TABLE knowledge_revision_contracts (
  revision_id uuid PRIMARY KEY,
  document_id uuid NOT NULL,
  link_contract knowledge_revision_link_contract NOT NULL
    DEFAULT 'generic_document_v1',
  provenance knowledge_revision_contract_provenance NOT NULL,
  body_content_hash text NOT NULL CHECK (body_content_hash ~ '^[a-f0-9]{64}$'),
  target_document_ids uuid[] NOT NULL DEFAULT '{}'::uuid[] CHECK (
    cardinality(target_document_ids)<=100000
    AND array_position(target_document_ids,NULL) IS NULL
  ),
  registered_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (revision_id,document_id)
    REFERENCES hypermedia_document_revisions(id,document_id) ON DELETE CASCADE
);
CREATE INDEX knowledge_revision_contracts_document_idx
  ON knowledge_revision_contracts(document_id,revision_id);

-- These indexes deliberately exclude knowledge_page_versions.path. Existing
-- vectors remain untouched for rollback. The base vector contains bounded
-- title/summary metadata; hydrated bodies use bounded chunks so a diverse legal
-- Markdown body cannot exceed PostgreSQL's tsvector size limit.
CREATE TABLE pathless_knowledge_search (
  document_id uuid PRIMARY KEY REFERENCES hypermedia_documents(id) ON DELETE CASCADE,
  revision_id uuid NOT NULL UNIQUE,
  search_vector tsvector NOT NULL,
  indexed_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (revision_id,document_id)
    REFERENCES hypermedia_document_revisions(id,document_id) ON DELETE CASCADE
);
CREATE INDEX pathless_knowledge_search_vector_idx
  ON pathless_knowledge_search USING gin(search_vector);

CREATE TABLE pathless_knowledge_search_chunks (
  document_id uuid NOT NULL REFERENCES hypermedia_documents(id) ON DELETE CASCADE,
  revision_id uuid NOT NULL,
  chunk_number integer NOT NULL CHECK (chunk_number>=0),
  search_vector tsvector NOT NULL,
  PRIMARY KEY (document_id,revision_id,chunk_number),
  FOREIGN KEY (revision_id,document_id)
    REFERENCES hypermedia_document_revisions(id,document_id) ON DELETE CASCADE
);
CREATE INDEX pathless_knowledge_search_chunks_vector_idx
  ON pathless_knowledge_search_chunks USING gin(search_vector);

CREATE FUNCTION pathless_document_search_vector(
  p_title text,p_summary text,p_body_markdown text
) RETURNS tsvector
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path=pg_catalog
RETURN (
  setweight(to_tsvector('simple',coalesce(p_title,'')),'A')
  || setweight(to_tsvector('english',coalesce(p_summary,'')),'A')
  || setweight(to_tsvector('english',coalesce(p_body_markdown,'')),'B')
);

-- Checked adoption is shared by new pathless writes and the deploy-time corpus
-- hydrator. It proves the supplied bytes are the exact current immutable
-- knowledge revision and records the caller's parser receipt. Generic graph
-- edges resolve every extant hypermedia identity (including archived pages,
-- tombstoned records and deleted asset tombstones); knowledge_asset_links alone
-- retains active asset bytes. Source revisions can never use this boundary.
CREATE FUNCTION record_generic_knowledge_revision(
  p_expected_document_id uuid,
  p_revision_id uuid,
  p_body_markdown text,
  p_target_document_ids uuid[],
  p_provenance knowledge_revision_contract_provenance DEFAULT 'authored'
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
DECLARE
  resolved_document_id uuid;
  expected_size integer;
  expected_hash text;
  page_title text;
  page_summary text;
  canonical_receipt uuid[];
  linked_count integer;
BEGIN
  IF p_revision_id IS NULL OR p_body_markdown IS NULL
     OR p_target_document_ids IS NULL OR p_provenance IS NULL THEN
    RAISE EXCEPTION 'revision, Markdown, targets and provenance are required'
      USING ERRCODE='22023';
  END IF;
  IF octet_length(p_body_markdown)>4000000
     OR cardinality(p_target_document_ids)>100000
     OR array_position(p_target_document_ids,NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'generic knowledge revision receipt is invalid'
      USING ERRCODE='22023';
  END IF;

  -- Match the global maintenance lock order used by every ordinary writer:
  -- transition lock, stable document advisory, then page/revision rows.
  PERFORM pg_advisory_xact_lock_shared(
    hashtextextended('filesystem-hypermedia-corpus-transition',0)
  );
  SELECT revision.document_id INTO resolved_document_id
  FROM hypermedia_document_revisions revision
  WHERE revision.id=p_revision_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'knowledge revision not found' USING ERRCODE='P0002';
  END IF;
  IF p_expected_document_id IS NOT NULL
     AND resolved_document_id<>p_expected_document_id THEN
    RAISE EXCEPTION 'knowledge revision does not belong to the expected document'
      USING ERRCODE='23514';
  END IF;
  PERFORM lock_operational_document(resolved_document_id);

  SELECT revision.body_size_bytes,revision.body_content_hash,
    version.title,version.summary
  INTO expected_size,expected_hash,page_title,page_summary
  FROM hypermedia_document_revisions revision
  JOIN hypermedia_documents document
    ON document.id=revision.document_id
   AND document.authority='knowledge'
   AND document.representation='markdown'
  JOIN knowledge_page_versions version
    ON version.id=revision.id AND version.page_id=revision.document_id
  JOIN knowledge_pages page
    ON page.id=revision.document_id
   AND page.current_version_id=revision.id
   AND (page.archived_at IS NULL OR p_provenance='corpus_migration')
  WHERE revision.id=p_revision_id
  FOR UPDATE OF page,revision;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'generic contract requires an active current knowledge revision'
      USING ERRCODE='23514';
  END IF;
  IF expected_size IS DISTINCT FROM octet_length(p_body_markdown)
     OR expected_hash IS DISTINCT FROM encode(
       digest(convert_to(p_body_markdown,'UTF8'),'sha256'),'hex'
     ) THEN
    RAISE EXCEPTION 'generic knowledge revision body failed integrity verification'
      USING ERRCODE='23514';
  END IF;

  SELECT coalesce(array_agg(id ORDER BY id),'{}'::uuid[])
  INTO canonical_receipt
  FROM (SELECT DISTINCT unnest(p_target_document_ids) AS id) receipt;

  -- Lock every extant asset tombstone in canonical order. If the asset is
  -- active, this pins its retention status through knowledge_asset_links;
  -- if already deleted, its generic document identity still remains readable.
  PERFORM asset.id
  FROM assets asset
  WHERE asset.id=ANY(canonical_receipt)
  ORDER BY asset.id
  FOR SHARE;

  SELECT replace_knowledge_revision_projections(p_revision_id,canonical_receipt)
  INTO linked_count;

  INSERT INTO knowledge_revision_contracts(
    revision_id,document_id,link_contract,provenance,
    body_content_hash,target_document_ids
  ) VALUES (
    p_revision_id,resolved_document_id,'generic_document_v1',p_provenance,
    expected_hash,canonical_receipt
  )
  ON CONFLICT (revision_id) DO NOTHING;
  IF NOT EXISTS (
    SELECT 1 FROM knowledge_revision_contracts contract
    WHERE contract.revision_id=p_revision_id
      AND contract.document_id=resolved_document_id
      AND contract.link_contract='generic_document_v1'
      AND contract.provenance=p_provenance
      AND contract.body_content_hash=expected_hash
      AND contract.target_document_ids=canonical_receipt
  ) THEN
    RAISE EXCEPTION 'knowledge revision contract conflicts with its immutable receipt'
      USING ERRCODE='23505';
  END IF;

  INSERT INTO pathless_knowledge_search(
    document_id,revision_id,search_vector,indexed_at
  ) VALUES (
    resolved_document_id,p_revision_id,
    pathless_document_search_vector(page_title,page_summary,''),now()
  )
  ON CONFLICT (document_id) DO UPDATE
  SET revision_id=excluded.revision_id,
      search_vector=excluded.search_vector,
      indexed_at=excluded.indexed_at;

  DELETE FROM pathless_knowledge_search_chunks
  WHERE document_id=resolved_document_id;
  INSERT INTO pathless_knowledge_search_chunks(
    document_id,revision_id,chunk_number,search_vector
  )
  SELECT resolved_document_id,p_revision_id,(chunk.ordinality-1)::integer,
    setweight(to_tsvector('english',substring(
      p_body_markdown
      -- PostgreSQL text offsets are characters, not bytes. A 16,384-codepoint
      -- window is at most 64 KiB in UTF-8; the 4,096-codepoint overlap is at
      -- least the 4 KiB overlap used by the source-record byte chunker.
      FROM (((chunk.ordinality-1)*12288)+1)::integer FOR 16384
    )),'B')
  FROM generate_series(
    1,ceil(char_length(p_body_markdown)/12288.0)::integer
  ) WITH ORDINALITY chunk(_value,ordinality);

  RETURN linked_count;
END;
$$;

CREATE FUNCTION register_generic_knowledge_revision(
  p_revision_id uuid,
  p_body_markdown text,
  p_target_document_ids uuid[]
) RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
  SELECT record_generic_knowledge_revision(
    NULL,p_revision_id,p_body_markdown,p_target_document_ids,'authored'
  )
$$;

CREATE FUNCTION adopt_generic_knowledge_revision(
  p_document_id uuid,
  p_revision_id uuid,
  p_body_markdown text,
  p_target_document_ids uuid[],
  p_provenance knowledge_revision_contract_provenance
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
BEGIN
  IF p_provenance<>'corpus_migration' THEN
    RAISE EXCEPTION 'corpus adoption provenance is invalid' USING ERRCODE='22023';
  END IF;
  IF p_document_id IS NULL THEN
    RAISE EXCEPTION 'document is required' USING ERRCODE='22023';
  END IF;
  RETURN record_generic_knowledge_revision(
    p_document_id,p_revision_id,p_body_markdown,p_target_document_ids,p_provenance
  );
END;
$$;

-- A private, pathless catalog. Compatibility paths and object locations are
-- intentionally absent. Operational roles are flags, not a separate document
-- kind: guides, automation documents and directory hubs remain ordinary
-- knowledge identities with narrower lifecycle/publication rules.
CREATE VIEW private_document_catalog
WITH (security_barrier=true,security_invoker=false)
AS
SELECT
  document.id AS document_id,
  'knowledge'::text AS document_kind,
  document.authority,
  document.representation,
  CASE WHEN page.archived_at IS NULL THEN 'active' ELSE 'archived' END::text
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
  ARRAY_REMOVE(ARRAY[
    CASE WHEN settings.global_guide_document_id=page.id THEN 'global_guide' END,
    CASE WHEN EXISTS (
      SELECT 1 FROM automation_registry registry
      WHERE registry.instructions_document_id=page.id
    ) OR EXISTS (
      SELECT 1
      FROM corpus_migration_automation_plans plan
      JOIN corpus_migration_runs run ON run.id=plan.run_id
      WHERE run.phase='applying' AND plan.instructions_document_id=page.id
    ) THEN 'automation_instructions' END,
    CASE WHEN EXISTS (
      SELECT 1 FROM automation_registry registry
      WHERE registry.state_document_id=page.id
    ) OR EXISTS (
      SELECT 1
      FROM corpus_migration_automation_plans plan
      JOIN corpus_migration_runs run ON run.id=plan.run_id
      WHERE run.phase='applying' AND plan.state_document_id=page.id
    ) THEN 'automation_state' END,
    CASE WHEN EXISTS (
      SELECT 1 FROM directory_hub_migrations hub
      WHERE hub.document_id=page.id
    ) THEN 'directory_hub' END
  ],NULL)::text[] AS operational_roles,
  resource.public_id,
  (page.published_version_id IS NOT NULL AND page.public_path IS NOT NULL)
    AS legacy_published,
  contract.link_contract::text AS current_link_contract,
  revision.links_indexed_at,
  coalesce(search.revision_id=page.current_version_id,false) AS pathless_search_ready,
  document.created_at,
  document.updated_at
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
SELECT
  document.id,
  'record',document.authority,document.representation,
  CASE WHEN record.deleted_at IS NULL THEN 'active' ELSE 'deleted' END,
  record.current_revision_id,revision.revision_number,
  NULL,NULL,NULL,NULL,
  revision.body_size_bytes::bigint,revision.body_content_hash,
  NULL::integer,NULL::integer,NULL::numeric,
  record.integration,record.connection_instance_id,record.connection_id,
  record.model,record.source_record_id,
  '{}'::text[],NULL::uuid,false,NULL::text,revision.links_indexed_at,
  CASE
    WHEN record.current_revision_id IS NULL THEN record.deleted_at IS NOT NULL
    ELSE revision.id IS NOT NULL AND revision.links_indexed_at IS NOT NULL
  END,
  document.created_at,document.updated_at
FROM hypermedia_documents document
JOIN source_records record ON record.document_id=document.id
LEFT JOIN hypermedia_document_revisions revision
  ON revision.id=record.current_revision_id AND revision.document_id=record.document_id
WHERE document.authority='source' AND document.representation='markdown'
UNION ALL
SELECT
  document.id,
  'asset',document.authority,document.representation,
  CASE WHEN asset.deleted_at IS NULL THEN 'active' ELSE 'deleted' END,
  NULL::uuid,NULL::integer,NULL::text,NULL::text,
  asset.filename,asset.content_type,asset.size_bytes,asset.content_hash,
  asset.width,asset.height,asset.duration_seconds,
  NULL::text,NULL::bigint,NULL::text,NULL::text,NULL::text,
  '{}'::text[],resource.public_id,
  asset.public_path IS NOT NULL,NULL::text,NULL::timestamptz,true,
  document.created_at,document.updated_at
FROM hypermedia_documents document
JOIN assets asset ON asset.id=document.id
LEFT JOIN public_resources resource ON resource.document_id=asset.id
WHERE document.authority='knowledge' AND document.representation='asset';

-- Search remains a narrow query boundary instead of granting application
-- roles direct access to connector search vectors or chunk lexemes.
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
  p_operational_role private_document_operational_role
) RETURNS TABLE (
  document jsonb,
  search_rank real,
  search_updated_at_epoch_micros text,
  search_document_id uuid
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
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

  RETURN QUERY
  WITH query AS (
    SELECT plainto_tsquery('english',regexp_replace(
        p_query,'[[:punct:]]+',' ','g'
      )) AS english,
      plainto_tsquery('simple',regexp_replace(
        p_query,'[[:punct:]]+',' ','g'
      )) AS simple,
      -- Keep the unstemmed query terms so the all-terms fallback can match a
      -- simple-config title term and an English-config body term on the same
      -- document even when neither vector contains the whole query.
      tsvector_to_array(to_tsvector('simple',regexp_replace(
        p_query,'[[:punct:]]+',' ','g'
      ))) AS terms
  ), knowledge_base AS (
    SELECT catalog.document_id,coalesce(
      search.search_vector,
      pathless_document_search_vector(catalog.title,catalog.summary,'')
    ) AS search_vector
    FROM private_document_catalog catalog
    LEFT JOIN pathless_knowledge_search search
      ON search.document_id=catalog.document_id
     AND search.revision_id=catalog.current_revision_id
    WHERE catalog.document_kind='knowledge'
  ), knowledge_term_vectors AS (
    SELECT base.document_id,base.search_vector
    FROM knowledge_base base
    UNION ALL
    SELECT chunk.document_id,chunk.search_vector
    FROM pathless_knowledge_search_chunks chunk
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
    FROM pathless_knowledge_search_chunks chunk
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
        WHEN 'knowledge' THEN knowledge.rank
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
        p_lifecycle IS NOT NULL AND catalog.lifecycle=p_lifecycle::text
        OR p_lifecycle IS NULL AND (p_include_retired OR catalog.lifecycle='active')
      )
      AND (p_authority IS NULL OR catalog.authority=p_authority)
      AND (p_representation IS NULL OR catalog.representation=p_representation)
      AND (p_document_kind IS NULL OR catalog.document_kind=p_document_kind::text)
      AND (p_integration IS NULL OR catalog.integration=p_integration)
      AND (
        p_operational_role IS NULL
        OR p_operational_role::text=ANY(catalog.operational_roles)
      )
      AND (
        (
          catalog.document_kind='knowledge'
          AND knowledge.document_id IS NOT NULL
        )
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

-- The view owner may resolve private joins but exposes only the catalog shape.
GRANT SELECT (
  id,authority,representation,created_at,updated_at
) ON hypermedia_documents TO context_use_projection_owner;
GRANT SELECT (
  id,current_version_id,published_version_id,public_path,archived_at
) ON knowledge_pages TO context_use_projection_owner;
GRANT SELECT (id,page_id,version_number,title,summary) ON knowledge_page_versions
  TO context_use_projection_owner;
GRANT SELECT (
  id,document_id,revision_number,body_size_bytes,body_content_hash,links_indexed_at
) ON hypermedia_document_revisions TO context_use_projection_owner;
GRANT SELECT (
  document_id,current_revision_id,integration,connection_instance_id,connection_id,
  model,source_record_id,deleted_at,search_vector
) ON source_records TO context_use_projection_owner;
GRANT SELECT (document_id,search_vector) ON source_record_search_chunks
  TO context_use_projection_owner;
GRANT SELECT (
  id,filename,content_type,size_bytes,content_hash,width,height,duration_seconds,
  deleted_at,public_path
) ON assets TO context_use_projection_owner;
GRANT SELECT (singleton,global_guide_document_id) ON knowledge_settings
  TO context_use_projection_owner;
GRANT SELECT (instructions_document_id,state_document_id) ON automation_registry
  TO context_use_projection_owner;
GRANT SELECT (run_id,instructions_document_id,state_document_id)
  ON corpus_migration_automation_plans TO context_use_projection_owner;
GRANT SELECT (id,phase) ON corpus_migration_runs TO context_use_projection_owner;
GRANT SELECT (document_id) ON directory_hub_migrations
  TO context_use_projection_owner;
GRANT SELECT (public_id,document_id) ON public_resources
  TO context_use_projection_owner;
GRANT SELECT ON knowledge_revision_contracts,pathless_knowledge_search,
  pathless_knowledge_search_chunks
  TO context_use_projection_owner;
GRANT EXECUTE ON FUNCTION pathless_document_search_vector(text,text,text)
  TO context_use_projection_owner;
GRANT CREATE ON SCHEMA public TO context_use_projection_owner;
ALTER VIEW private_document_catalog OWNER TO context_use_projection_owner;
ALTER FUNCTION search_private_document_catalog(
  text,real,bigint,uuid,boolean,integer,hypermedia_document_authority,
  hypermedia_document_representation,private_document_kind,
  private_document_lifecycle,text,private_document_operational_role
)
  OWNER TO context_use_projection_owner;
REVOKE CREATE ON SCHEMA public FROM context_use_projection_owner;

REVOKE ALL ON FUNCTION pathless_document_search_vector(text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION record_generic_knowledge_revision(
  uuid,uuid,text,uuid[],knowledge_revision_contract_provenance
) FROM PUBLIC;
REVOKE ALL ON FUNCTION register_generic_knowledge_revision(uuid,text,uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION adopt_generic_knowledge_revision(
  uuid,uuid,text,uuid[],knowledge_revision_contract_provenance
) FROM PUBLIC;
REVOKE ALL ON FUNCTION search_private_document_catalog(
  text,real,bigint,uuid,boolean,integer,hypermedia_document_authority,
  hypermedia_document_representation,private_document_kind,
  private_document_lifecycle,text,private_document_operational_role
)
  FROM PUBLIC;

GRANT SELECT,INSERT ON knowledge_revision_contracts TO context_use_boundary_owner;
GRANT SELECT,INSERT,UPDATE ON pathless_knowledge_search
  TO context_use_boundary_owner;
GRANT SELECT,INSERT,DELETE ON pathless_knowledge_search_chunks
  TO context_use_boundary_owner;
GRANT SELECT (id,authority,representation) ON hypermedia_documents
  TO context_use_boundary_owner;
GRANT SELECT (id,current_version_id,archived_at) ON knowledge_pages
  TO context_use_boundary_owner;
GRANT SELECT (id,page_id,title,summary) ON knowledge_page_versions
  TO context_use_boundary_owner;
GRANT SELECT (
  id,document_id,body_size_bytes,body_content_hash
) ON hypermedia_document_revisions TO context_use_boundary_owner;
GRANT SELECT (document_id) ON source_records TO context_use_boundary_owner;
GRANT EXECUTE ON FUNCTION pathless_document_search_vector(text,text,text)
  TO context_use_boundary_owner;
GRANT USAGE,CREATE ON SCHEMA public TO context_use_boundary_owner;
ALTER FUNCTION record_generic_knowledge_revision(
  uuid,uuid,text,uuid[],knowledge_revision_contract_provenance
) OWNER TO context_use_boundary_owner;
ALTER FUNCTION register_generic_knowledge_revision(uuid,text,uuid[])
  OWNER TO context_use_boundary_owner;
ALTER FUNCTION adopt_generic_knowledge_revision(
  uuid,uuid,text,uuid[],knowledge_revision_contract_provenance
) OWNER TO context_use_boundary_owner;
REVOKE CREATE ON SCHEMA public FROM context_use_boundary_owner;

GRANT EXECUTE ON FUNCTION register_generic_knowledge_revision(uuid,text,uuid[])
  TO context_use_dashboard,context_use_mcp;
GRANT EXECUTE ON FUNCTION adopt_generic_knowledge_revision(
  uuid,uuid,text,uuid[],knowledge_revision_contract_provenance
) TO context_use_corpus;
GRANT SELECT ON knowledge_revision_contracts,pathless_knowledge_search,
  private_document_catalog TO context_use_dashboard,context_use_mcp;
GRANT EXECUTE ON FUNCTION search_private_document_catalog(
  text,real,bigint,uuid,boolean,integer,hypermedia_document_authority,
  hypermedia_document_representation,private_document_kind,
  private_document_lifecycle,text,private_document_operational_role
)
  TO context_use_dashboard,context_use_mcp;
GRANT SELECT ON knowledge_revision_contracts,pathless_knowledge_search,
  pathless_knowledge_search_chunks,
  private_document_catalog TO context_use_backup;
