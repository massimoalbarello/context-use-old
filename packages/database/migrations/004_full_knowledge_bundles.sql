-- A Context Use knowledge bundle is a versioned logical snapshot. It is not a
-- PostgreSQL dump: these staging tables pin the logical records and immutable
-- object references independently of the physical schema used by later
-- releases.
CREATE TABLE knowledge_bundle_exports (
  intent_id uuid PRIMARY KEY REFERENCES knowledge_export_intents(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','snapshotting','processing','ready','failed')),
  phase text NOT NULL DEFAULT 'authorization',
  records_completed bigint NOT NULL DEFAULT 0 CHECK (records_completed>=0),
  records_total bigint NOT NULL DEFAULT 0 CHECK (records_total>=0),
  objects_completed bigint NOT NULL DEFAULT 0 CHECK (objects_completed>=0),
  objects_total bigint NOT NULL DEFAULT 0 CHECK (objects_total>=0),
  bytes_completed bigint NOT NULL DEFAULT 0 CHECK (bytes_completed>=0),
  bytes_total bigint NOT NULL DEFAULT 0 CHECK (bytes_total>=0),
  bundle_size_bytes bigint CHECK (bundle_size_bytes IS NULL OR bundle_size_bytes>0),
  bundle_sha256 text CHECK (bundle_sha256 IS NULL OR bundle_sha256 ~ '^[a-f0-9]{64}$'),
  error_code text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE knowledge_bundle_export_records (
  intent_id uuid NOT NULL REFERENCES knowledge_bundle_exports(intent_id) ON DELETE CASCADE,
  dataset text NOT NULL CHECK (dataset ~ '^[a-z][a-z0-9_]{0,79}$'),
  ordinal bigint NOT NULL CHECK (ordinal>0),
  record jsonb NOT NULL CHECK (jsonb_typeof(record)='object'),
  PRIMARY KEY (intent_id,dataset,ordinal)
);
CREATE INDEX knowledge_bundle_export_records_stream_idx
  ON knowledge_bundle_export_records(intent_id,dataset,ordinal);

CREATE TABLE knowledge_bundle_export_objects (
  intent_id uuid NOT NULL REFERENCES knowledge_bundle_exports(intent_id) ON DELETE CASCADE,
  ordinal bigint NOT NULL CHECK (ordinal>0),
  object_kind text NOT NULL CHECK (object_kind IN (
    'private_revision','asset','retained_page','public_page','public_asset'
  )),
  object_key text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes>=0),
  content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  content_type text NOT NULL CHECK (length(content_type) BETWEEN 1 AND 255),
  PRIMARY KEY (intent_id,ordinal),
  UNIQUE (intent_id,object_key)
);

CREATE TABLE knowledge_bundle_imports (
  id uuid PRIMARY KEY,
  owner_user_id text NOT NULL CHECK (owner_user_id='context-use-owner'),
  session_id text NOT NULL CHECK (length(session_id) BETWEEN 1 AND 512),
  filename text NOT NULL CHECK (length(filename) BETWEEN 1 AND 1024),
  total_bytes bigint NOT NULL CHECK (total_bytes>0),
  part_size integer NOT NULL CHECK (part_size BETWEEN 1048576 AND 67108864),
  total_parts integer NOT NULL CHECK (total_parts BETWEEN 1 AND 100000),
  status text NOT NULL DEFAULT 'uploading' CHECK (status IN (
    'uploading','validating','awaiting_confirmation','restoring','complete','failed'
  )),
  phase text NOT NULL DEFAULT 'upload',
  parts_completed integer NOT NULL DEFAULT 0 CHECK (parts_completed>=0),
  records_completed bigint NOT NULL DEFAULT 0 CHECK (records_completed>=0),
  records_total bigint NOT NULL DEFAULT 0 CHECK (records_total>=0),
  objects_completed bigint NOT NULL DEFAULT 0 CHECK (objects_completed>=0),
  objects_total bigint NOT NULL DEFAULT 0 CHECK (objects_total>=0),
  bytes_completed bigint NOT NULL DEFAULT 0 CHECK (bytes_completed>=0),
  bytes_total bigint NOT NULL DEFAULT 0 CHECK (bytes_total>=0),
  manifest jsonb CHECK (manifest IS NULL OR jsonb_typeof(manifest)='object'),
  error_code text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now()+interval '7 days',
  confirmed_at timestamptz,
  consumed_at timestamptz,
  CHECK (expires_at>created_at),
  CHECK (consumed_at IS NULL OR confirmed_at IS NOT NULL)
);
CREATE INDEX knowledge_bundle_imports_expiry_idx
  ON knowledge_bundle_imports(expires_at);

CREATE TABLE knowledge_bundle_import_parts (
  import_id uuid NOT NULL REFERENCES knowledge_bundle_imports(id) ON DELETE CASCADE,
  part_number integer NOT NULL CHECK (part_number>=0),
  object_key text NOT NULL UNIQUE,
  size_bytes integer NOT NULL CHECK (size_bytes>0),
  content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (import_id,part_number)
);

CREATE TABLE knowledge_bundle_import_records (
  import_id uuid NOT NULL REFERENCES knowledge_bundle_imports(id) ON DELETE CASCADE,
  dataset text NOT NULL CHECK (dataset ~ '^[a-z][a-z0-9_]{0,79}$'),
  ordinal bigint NOT NULL CHECK (ordinal>0),
  record jsonb NOT NULL CHECK (jsonb_typeof(record)='object'),
  PRIMARY KEY (import_id,dataset,ordinal)
);

CREATE TABLE knowledge_bundle_import_objects (
  import_id uuid NOT NULL REFERENCES knowledge_bundle_imports(id) ON DELETE CASCADE,
  ordinal bigint NOT NULL CHECK (ordinal>0),
  object_kind text NOT NULL CHECK (object_kind IN (
    'private_revision','asset','retained_page','public_page','public_asset'
  )),
  object_key text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes>=0),
  content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  content_type text NOT NULL CHECK (length(content_type) BETWEEN 1 AND 255),
  materialized_at timestamptz,
  PRIMARY KEY (import_id,ordinal),
  UNIQUE (import_id,object_key)
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='context_use_import_owner') THEN
    CREATE ROLE context_use_import_owner NOLOGIN NOINHERIT;
  END IF;
END;
$$;
ALTER ROLE context_use_import_owner NOLOGIN NOINHERIT;

-- Capture one repeatable logical snapshot into durable rows. Immutable object
-- bytes are streamed later, after this short transaction releases its locks.
CREATE FUNCTION capture_full_knowledge_bundle(
  p_intent_id uuid,p_owner_user_id text,p_session_id text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET jit=off AS $$
DECLARE intent record; record_count bigint; object_count bigint; byte_count bigint;
BEGIN
  PERFORM pg_advisory_xact_lock_shared(
    hashtextextended('context-use:knowledge-lifecycle',0)
  );
  SELECT export_intent.id,export_intent.owner_user_id,export_intent.session_id,
    export_intent.expires_at,export_intent.confirmed_at
  INTO intent
  FROM knowledge_export_intents export_intent
  JOIN knowledge_bundle_exports bundle ON bundle.intent_id=export_intent.id
  WHERE export_intent.id=p_intent_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'full knowledge export intent not found' USING ERRCODE='P0002';
  END IF;
  IF intent.owner_user_id IS DISTINCT FROM p_owner_user_id
     OR intent.session_id IS DISTINCT FROM p_session_id THEN
    RAISE EXCEPTION 'full knowledge export principal mismatch' USING ERRCODE='42501';
  END IF;
  IF intent.confirmed_at IS NULL OR intent.expires_at<=now() THEN
    RAISE EXCEPTION 'full knowledge export confirmation required' USING ERRCODE='42501';
  END IF;

  INSERT INTO knowledge_bundle_exports(intent_id,status,phase)
  VALUES (p_intent_id,'snapshotting','catalog')
  ON CONFLICT (intent_id) DO UPDATE SET
    status='snapshotting',phase='catalog',error_code=NULL,error_message=NULL,
    records_completed=0,objects_completed=0,bytes_completed=0,updated_at=now();
  DELETE FROM knowledge_bundle_export_records WHERE intent_id=p_intent_id;
  DELETE FROM knowledge_bundle_export_objects WHERE intent_id=p_intent_id;

  INSERT INTO knowledge_bundle_export_records(intent_id,dataset,ordinal,record)
  SELECT p_intent_id,dataset,row_number() OVER (PARTITION BY dataset ORDER BY sort_key),record
  FROM (
    SELECT 'hypermedia_documents' dataset,id::text sort_key,to_jsonb(row) record FROM hypermedia_documents row
    UNION ALL SELECT 'knowledge_pages',id::text,to_jsonb(row) FROM knowledge_pages row
    UNION ALL SELECT 'assets',id::text,to_jsonb(row) FROM assets row
    UNION ALL SELECT 'hypermedia_document_revisions',id::text,to_jsonb(row) FROM hypermedia_document_revisions row
    UNION ALL SELECT 'knowledge_page_versions',id::text,to_jsonb(row) FROM knowledge_page_versions row
    UNION ALL SELECT 'source_records',document_id::text,to_jsonb(row) FROM source_records row
    UNION ALL SELECT 'knowledge_page_changes',lpad(change_sequence::text,24,'0'),to_jsonb(row) FROM knowledge_page_changes row
    UNION ALL SELECT 'knowledge_revision_contracts',revision_id::text,to_jsonb(row) FROM knowledge_revision_contracts row
    UNION ALL SELECT 'document_links',source_revision_id::text||':'||target_document_id::text,to_jsonb(row) FROM document_links row
    UNION ALL SELECT 'knowledge_asset_links',source_version_id::text||':'||target_asset_id::text,to_jsonb(row) FROM knowledge_asset_links row
    UNION ALL SELECT 'knowledge_search',document_id::text,to_jsonb(row) FROM knowledge_search row
    UNION ALL SELECT 'knowledge_search_chunks',document_id::text||':'||lpad(chunk_number::text,12,'0'),to_jsonb(row) FROM knowledge_search_chunks row
    UNION ALL SELECT 'source_record_search_chunks',document_id::text||':'||lpad(chunk_number::text,12,'0'),to_jsonb(row) FROM source_record_search_chunks row
    UNION ALL SELECT 'knowledge_settings',singleton::text,to_jsonb(row) FROM knowledge_settings row
    UNION ALL SELECT 'automation_registry',id::text,to_jsonb(row) FROM automation_registry row
    UNION ALL SELECT 'hypermedia_bootstrap_allocations',document_kind::text,to_jsonb(row) FROM hypermedia_bootstrap_allocations row
    UNION ALL SELECT 'publication_intent_id_reservations',intent_id::text,to_jsonb(row) FROM publication_intent_id_reservations row
    UNION ALL SELECT 'public_artifact_id_reservations',artifact_id::text,to_jsonb(row) FROM public_artifact_id_reservations row
    UNION ALL SELECT 'public_representation_token_reservations',representation_token,to_jsonb(row) FROM public_representation_token_reservations row
    UNION ALL SELECT 'publication_intents',id::text,to_jsonb(row) FROM publication_intents row
    UNION ALL SELECT 'publication_artifact_staging',intent_id::text,to_jsonb(row) FROM publication_artifact_staging row
    UNION ALL SELECT 'publication_object_claims',claim_token::text,to_jsonb(row) FROM publication_object_claims row
    UNION ALL SELECT 'public_resources',public_id::text,to_jsonb(row) FROM public_resources row
    UNION ALL SELECT 'retained_page_artifacts',page_id::text||':'||version_id::text||':'||projection_generation::text,to_jsonb(row) FROM retained_page_artifacts row
    UNION ALL SELECT 'public_page_artifacts',artifact_id::text,to_jsonb(row) FROM public_page_artifacts row
    UNION ALL SELECT 'public_asset_artifacts',artifact_id::text,to_jsonb(row) FROM public_asset_artifacts row
    UNION ALL SELECT 'page_publications',public_id::text,to_jsonb(row) FROM page_publications row
    UNION ALL SELECT 'asset_publications',public_id::text,to_jsonb(row) FROM asset_publications row
    UNION ALL SELECT 'public_route_aliases',alias_path,to_jsonb(row) FROM public_route_aliases row
    UNION ALL SELECT 'public_visibility_generations',public_id::text,to_jsonb(row) FROM public_visibility_generations row
    UNION ALL SELECT 'publication_target_generations',target_kind::text||':'||target_document_id::text,to_jsonb(row) FROM publication_target_generations row
    UNION ALL SELECT 'public_namespace_conflicts',namespace_uuid::text,to_jsonb(row) FROM public_namespace_conflicts row
    UNION ALL SELECT 'publication_settings',singleton::text,to_jsonb(row) FROM publication_settings row
  ) snapshot;

  INSERT INTO knowledge_bundle_export_objects(
    intent_id,ordinal,object_kind,object_key,size_bytes,content_hash,content_type
  )
  SELECT p_intent_id,row_number() OVER (ORDER BY object_key),object_kind,
    object_key,size_bytes,content_hash,content_type
  FROM (
    SELECT DISTINCT ON (object_key) object_kind,object_key,size_bytes,content_hash,content_type
    FROM (
      SELECT 'private_revision'::text object_kind,body_object_key object_key,
        body_size_bytes::bigint size_bytes,body_content_hash content_hash,
        'text/markdown; charset=utf-8'::text content_type
      FROM hypermedia_document_revisions
      UNION ALL SELECT 'asset',s3_object_key,size_bytes,content_hash,content_type
        FROM assets WHERE deleted_at IS NULL
      UNION ALL SELECT 'retained_page',body_object_key,body_size_bytes,body_content_hash,
        'text/markdown; charset=utf-8' FROM retained_page_artifacts
      UNION ALL SELECT 'public_page',body_object_key,body_size_bytes,body_content_hash,
        'text/markdown; charset=utf-8' FROM public_page_artifacts
      UNION ALL SELECT 'public_asset',body_object_key,body_size_bytes,body_content_hash,
        public_content_type FROM public_asset_artifacts
    ) referenced_objects
    ORDER BY object_key,object_kind
  ) objects;

  SELECT count(*),coalesce(sum(octet_length(record::text)),0)
  INTO record_count,byte_count FROM knowledge_bundle_export_records
  WHERE intent_id=p_intent_id;
  SELECT count(*),byte_count+coalesce(sum(size_bytes),0)
  INTO object_count,byte_count FROM knowledge_bundle_export_objects
  WHERE intent_id=p_intent_id;
  UPDATE knowledge_bundle_exports SET status='processing',phase='bundle',
    records_total=record_count,objects_total=object_count,bytes_total=byte_count,
    updated_at=now() WHERE intent_id=p_intent_id;
  RETURN jsonb_build_object('records',record_count,'objects',object_count,'bytes',byte_count);
END;
$$;

CREATE FUNCTION issue_knowledge_bundle_import_challenge(
  p_import_id uuid,p_challenge text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE job record;
BEGIN
  IF p_challenge IS NULL OR p_challenge !~ '^[A-Za-z0-9_-]{43,128}$' THEN
    RAISE EXCEPTION 'valid confirmation challenge required' USING ERRCODE='22023';
  END IF;
  SELECT id,status,expires_at,confirmed_at INTO job
  FROM knowledge_bundle_imports WHERE id=p_import_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'knowledge import not found' USING ERRCODE='P0002'; END IF;
  IF job.status<>'awaiting_confirmation' OR job.confirmed_at IS NOT NULL
     OR job.expires_at<=now() THEN
    RAISE EXCEPTION 'knowledge import is inactive' USING ERRCODE='22023';
  END IF;
  DELETE FROM confirmation_challenges
  WHERE intent_kind='knowledge_import' AND intent_id=p_import_id;
  INSERT INTO confirmation_challenges(intent_kind,intent_id,challenge)
  VALUES ('knowledge_import',p_import_id,p_challenge);
END;
$$;

CREATE FUNCTION confirm_knowledge_bundle_import(
  p_import_id uuid,p_owner_user_id text,p_session_id text,p_credential_id text,
  p_expected_counter integer,p_new_counter integer
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE job record; stored_challenge text;
BEGIN
  SELECT * INTO job FROM knowledge_bundle_imports WHERE id=p_import_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'knowledge import not found' USING ERRCODE='P0002'; END IF;
  IF job.owner_user_id IS DISTINCT FROM p_owner_user_id
     OR job.session_id IS DISTINCT FROM p_session_id THEN
    RAISE EXCEPTION 'knowledge import principal mismatch' USING ERRCODE='42501';
  END IF;
  IF job.status<>'awaiting_confirmation' OR job.confirmed_at IS NOT NULL
     OR job.expires_at<=now() THEN
    RAISE EXCEPTION 'knowledge import is inactive' USING ERRCODE='22023';
  END IF;
  SELECT challenge INTO stored_challenge FROM confirmation_challenges
  WHERE intent_kind='knowledge_import' AND intent_id=p_import_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'knowledge import challenge not issued' USING ERRCODE='42501'; END IF;
  PERFORM consume_confirmation_challenge(
    'knowledge_import',p_import_id,stored_challenge,p_owner_user_id,
    p_credential_id,p_expected_counter,p_new_counter
  );
  UPDATE knowledge_bundle_imports SET confirmed_at=now(),status='restoring',
    phase='objects',bytes_completed=0,records_completed=0,objects_completed=0,
    updated_at=now(),expires_at=now()+interval '24 hours'
  WHERE id=p_import_id;
END;
$$;

-- This is an empty-instance restore boundary. Authentication and connection
-- secrets remain local. All knowledge/publication tables are replaced in one
-- transaction, and every UUID/value comes from the versioned logical catalog.
CREATE FUNCTION restore_full_knowledge_bundle(
  p_import_id uuid,p_owner_user_id text,p_session_id text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET jit=off AS $$
DECLARE job record; mapping record; constraint_row record; dangling boolean;
  restored_records bigint:=0; maximum_change_sequence bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('context-use:knowledge-lifecycle',0));
  SELECT * INTO job FROM knowledge_bundle_imports WHERE id=p_import_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'knowledge import not found' USING ERRCODE='P0002'; END IF;
  IF job.owner_user_id IS DISTINCT FROM p_owner_user_id
     OR job.session_id IS DISTINCT FROM p_session_id THEN
    RAISE EXCEPTION 'knowledge import principal mismatch' USING ERRCODE='42501';
  END IF;
  IF job.confirmed_at IS NULL OR job.status<>'restoring' OR job.expires_at<=now() THEN
    RAISE EXCEPTION 'confirmed knowledge import required' USING ERRCODE='42501';
  END IF;
  IF EXISTS (SELECT 1 FROM knowledge_bundle_import_objects
    WHERE import_id=p_import_id AND materialized_at IS NULL) THEN
    RAISE EXCEPTION 'knowledge import objects are incomplete' USING ERRCODE='55000';
  END IF;
  IF EXISTS (SELECT 1 FROM source_records) OR EXISTS (SELECT 1 FROM assets)
     OR EXISTS (SELECT 1 FROM public_resources)
     OR EXISTS (
       SELECT 1 FROM hypermedia_documents document
       WHERE NOT EXISTS (SELECT 1 FROM hypermedia_bootstrap_allocations allocation
         WHERE allocation.document_id=document.id)
     ) THEN
    RAISE EXCEPTION 'full knowledge imports require a fresh Context Use instance'
      USING ERRCODE='55000';
  END IF;

  PERFORM set_config('session_replication_role','replica',true);
  TRUNCATE TABLE
    page_deletion_intents,
    page_publications,asset_publications,public_page_artifacts,public_asset_artifacts,
    public_representation_token_reservations,publication_object_claims,
    publication_artifact_staging,publication_intents,publication_intent_id_reservations,
    public_artifact_id_reservations,hypermedia_bootstrap_allocations,publication_settings,
    public_visibility_generations,publication_target_generations,public_namespace_conflicts,
    knowledge_search_chunks,knowledge_search,knowledge_revision_contracts,
    automation_registry,retained_page_artifacts,public_route_aliases,public_resources,
    knowledge_settings,document_links,source_record_search_chunks,source_records,
    hypermedia_document_revisions,hypermedia_documents,knowledge_asset_links,
    knowledge_page_changes,knowledge_page_versions,knowledge_pages,assets;

  FOR mapping IN SELECT * FROM (VALUES
    (1,'hypermedia_documents'),(2,'knowledge_pages'),(3,'assets'),
    (4,'hypermedia_document_revisions'),(5,'knowledge_page_versions'),
    (6,'source_records'),(7,'knowledge_page_changes'),
    (8,'knowledge_revision_contracts'),(9,'document_links'),
    (10,'knowledge_asset_links'),(11,'knowledge_search'),
    (12,'knowledge_search_chunks'),(13,'source_record_search_chunks'),
    (14,'knowledge_settings'),(15,'automation_registry'),
    (16,'hypermedia_bootstrap_allocations'),
    (17,'publication_intent_id_reservations'),
    (18,'public_artifact_id_reservations'),
    (19,'public_representation_token_reservations'),(20,'publication_intents'),
    (21,'publication_artifact_staging'),(22,'publication_object_claims'),
    (23,'public_resources'),(24,'retained_page_artifacts'),
    (25,'public_page_artifacts'),(26,'public_asset_artifacts'),
    (27,'page_publications'),(28,'asset_publications'),
    (29,'public_route_aliases'),(30,'public_visibility_generations'),
    (31,'publication_target_generations'),(32,'public_namespace_conflicts'),
    (33,'publication_settings')
  ) AS ordered(position,dataset) ORDER BY position
  LOOP
    EXECUTE format(
      'INSERT INTO %I OVERRIDING SYSTEM VALUE SELECT (jsonb_populate_record(NULL::%I,record)).* '
      'FROM knowledge_bundle_import_records WHERE import_id=$1 AND dataset=$2 ORDER BY ordinal',
      mapping.dataset,mapping.dataset
    ) USING p_import_id,mapping.dataset;
    restored_records:=restored_records+(
      SELECT count(*) FROM knowledge_bundle_import_records
      WHERE import_id=p_import_id AND dataset=mapping.dataset
    );
  END LOOP;
  PERFORM set_config('session_replication_role','origin',true);

  -- Validate every current foreign key after the replica-mode bulk load. This
  -- is generic so future physical FK additions cannot silently weaken restore.
  FOR constraint_row IN
    SELECT con.oid,con.conrelid::regclass child,con.confrelid::regclass parent,
      array_agg(child_attribute.attname ORDER BY key.position) child_columns,
      array_agg(parent_attribute.attname ORDER BY key.position) parent_columns
    FROM pg_constraint con
    CROSS JOIN LATERAL unnest(con.conkey,con.confkey) WITH ORDINALITY
      AS key(child_number,parent_number,position)
    JOIN pg_attribute child_attribute
      ON child_attribute.attrelid=con.conrelid AND child_attribute.attnum=key.child_number
    JOIN pg_attribute parent_attribute
      ON parent_attribute.attrelid=con.confrelid AND parent_attribute.attnum=key.parent_number
    WHERE con.contype='f' AND con.connamespace='public'::regnamespace
      AND con.conrelid::regclass::text IN (
        SELECT DISTINCT dataset FROM knowledge_bundle_import_records
        WHERE import_id=p_import_id
      )
    GROUP BY con.oid,con.conrelid,con.confrelid
  LOOP
    EXECUTE format(
      'SELECT EXISTS (SELECT 1 FROM %s child WHERE (%s) IS NOT NULL AND NOT EXISTS '
      '(SELECT 1 FROM %s parent WHERE %s))',
      constraint_row.child,
      array_to_string(ARRAY(SELECT format('child.%I',name)
        FROM unnest(constraint_row.child_columns) name),','),
      constraint_row.parent,
      array_to_string(ARRAY(SELECT format('child.%I IS NOT DISTINCT FROM parent.%I',
        constraint_row.child_columns[index],constraint_row.parent_columns[index])
        FROM generate_subscripts(constraint_row.child_columns,1) index),' AND ')
    ) INTO dangling;
    IF dangling THEN
      RAISE EXCEPTION 'knowledge bundle contains a dangling relationship in %',
        constraint_row.child USING ERRCODE='23503';
    END IF;
  END LOOP;

  SELECT max(change_sequence) INTO maximum_change_sequence FROM knowledge_page_changes;
  IF maximum_change_sequence IS NOT NULL THEN
    PERFORM setval(pg_get_serial_sequence('knowledge_page_changes','change_sequence'),
      maximum_change_sequence,true);
  END IF;
  UPDATE knowledge_bundle_imports SET status='complete',phase='complete',
    consumed_at=now(),records_completed=records_total,objects_completed=objects_total,
    bytes_completed=bytes_total,updated_at=now() WHERE id=p_import_id;
  RETURN jsonb_build_object('records',restored_records,'objects',job.objects_total);
END;
$$;

ALTER FUNCTION capture_full_knowledge_bundle(uuid,text,text)
  OWNER TO context_use_import_owner;
ALTER FUNCTION issue_knowledge_bundle_import_challenge(uuid,text)
  OWNER TO context_use_boundary_owner;
ALTER FUNCTION confirm_knowledge_bundle_import(uuid,text,text,text,integer,integer)
  OWNER TO context_use_boundary_owner;
ALTER FUNCTION restore_full_knowledge_bundle(uuid,text,text)
  OWNER TO context_use_import_owner;
REVOKE ALL ON FUNCTION capture_full_knowledge_bundle(uuid,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION issue_knowledge_bundle_import_challenge(uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION confirm_knowledge_bundle_import(uuid,text,text,text,integer,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION restore_full_knowledge_bundle(uuid,text,text) FROM PUBLIC;

GRANT USAGE ON SCHEMA public TO context_use_import_owner;
GRANT SELECT,TRUNCATE,INSERT ON
  page_deletion_intents,
  page_publications,asset_publications,public_page_artifacts,public_asset_artifacts,
  public_representation_token_reservations,publication_object_claims,
  publication_artifact_staging,publication_intents,publication_intent_id_reservations,
  public_artifact_id_reservations,hypermedia_bootstrap_allocations,publication_settings,
  public_visibility_generations,publication_target_generations,public_namespace_conflicts,
  knowledge_search_chunks,knowledge_search,knowledge_revision_contracts,
  automation_registry,retained_page_artifacts,public_route_aliases,public_resources,
  knowledge_settings,document_links,source_record_search_chunks,source_records,
  hypermedia_document_revisions,hypermedia_documents,knowledge_asset_links,
  knowledge_page_changes,knowledge_page_versions,knowledge_pages,assets,
  knowledge_export_intents,knowledge_bundle_exports,knowledge_bundle_export_records,
  knowledge_bundle_export_objects,knowledge_bundle_imports,knowledge_bundle_import_parts,
  knowledge_bundle_import_records,knowledge_bundle_import_objects
  TO context_use_import_owner;
GRANT SELECT,INSERT,UPDATE,DELETE ON knowledge_bundle_exports,
  knowledge_bundle_export_records,knowledge_bundle_export_objects,
  knowledge_bundle_imports,knowledge_bundle_import_parts,
  knowledge_bundle_import_records,knowledge_bundle_import_objects
  TO context_use_import_owner;
GRANT USAGE,SELECT,UPDATE ON ALL SEQUENCES IN SCHEMA public TO context_use_import_owner;
GRANT SET ON PARAMETER session_replication_role TO context_use_import_owner;

GRANT SELECT,INSERT,DELETE ON knowledge_bundle_exports,
  knowledge_bundle_export_records,knowledge_bundle_export_objects,
  knowledge_bundle_import_parts,
  knowledge_bundle_import_records,knowledge_bundle_import_objects
  TO context_use_dashboard;
GRANT SELECT,DELETE ON knowledge_bundle_imports TO context_use_dashboard;
GRANT INSERT (
  id,owner_user_id,session_id,filename,total_bytes,part_size,total_parts,bytes_total
) ON knowledge_bundle_imports TO context_use_dashboard;
GRANT UPDATE (
  status,phase,records_completed,records_total,objects_completed,objects_total,
  bytes_completed,bytes_total,bundle_size_bytes,bundle_sha256,error_code,
  error_message,updated_at
) ON knowledge_bundle_exports TO context_use_dashboard;
GRANT UPDATE (
  status,phase,parts_completed,records_completed,records_total,objects_completed,
  objects_total,bytes_completed,bytes_total,manifest,error_code,error_message,
  updated_at,expires_at
) ON knowledge_bundle_imports TO context_use_dashboard;
GRANT UPDATE (materialized_at) ON knowledge_bundle_import_objects TO context_use_dashboard;
GRANT EXECUTE ON FUNCTION capture_full_knowledge_bundle(uuid,text,text)
  TO context_use_dashboard;
GRANT EXECUTE ON FUNCTION restore_full_knowledge_bundle(uuid,text,text)
  TO context_use_dashboard;
GRANT EXECUTE ON FUNCTION issue_knowledge_bundle_import_challenge(uuid,text)
  TO context_use_confirmation;
GRANT EXECUTE ON FUNCTION confirm_knowledge_bundle_import(uuid,text,text,text,integer,integer)
  TO context_use_confirmation;
GRANT SELECT,UPDATE ON knowledge_bundle_imports TO context_use_boundary_owner;
GRANT SELECT (id,owner_user_id,session_id,status,expires_at,confirmed_at)
  ON knowledge_bundle_imports TO context_use_confirmation;
GRANT SELECT (id,status,confirmed_at,expires_at) ON knowledge_bundle_imports
  TO context_use_storage;
GRANT SELECT (import_id,object_key,size_bytes,content_hash,content_type,materialized_at)
  ON knowledge_bundle_import_objects TO context_use_storage;
GRANT SELECT ON knowledge_bundle_exports,knowledge_bundle_export_records,
  knowledge_bundle_export_objects,knowledge_bundle_imports,
  knowledge_bundle_import_parts,knowledge_bundle_import_records,
  knowledge_bundle_import_objects TO context_use_backup;
