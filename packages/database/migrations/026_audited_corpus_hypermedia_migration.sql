-- Add the audited, resumable transition substrate used to turn the legacy
-- filesystem projection into ordinary hypermedia. The filesystem remains live
-- in this release: application code must finish and seal one inventory before
-- a later schema migration may remove any path columns or directory rows.

-- Corpus preparation is a privileged, deploy-time boundary, not a dashboard
-- capability. This login inherits ordinary dashboard reads/writes needed to
-- preserve owner knowledge, then receives only the additional audited ledger
-- and cutover procedures below. The long-lived dashboard role cannot forge a
-- migration plan or bind a public compatibility artifact.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='context_use_corpus') THEN
    CREATE ROLE context_use_corpus NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
      INHERIT NOBYPASSRLS;
  ELSE
    ALTER ROLE context_use_corpus NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
      INHERIT NOBYPASSRLS;
  END IF;
  ALTER ROLE context_use_corpus SET search_path=pg_catalog,public;
  EXECUTE format(
    'GRANT CONNECT ON DATABASE %I TO context_use_corpus',
    current_database()
  );
END;
$$;
GRANT context_use_dashboard TO context_use_corpus;
GRANT USAGE ON SCHEMA public TO context_use_corpus;

-- Legacy public directory indexes were implicit prefixes of published page
-- paths. Empty directory rows could legally have been deleted after a page
-- moved privately. A missing public prefix can also collide with a newly
-- created private page or asset at that path, so synthetic prefixes stay in a
-- dedicated staging table rather than claiming any private filesystem path.
-- The audited inventory unions them as neutral hub candidates and later binds
-- a permanent exact alias without exposing a mutable hidden directory.
CREATE TABLE legacy_public_directory_prefixes (
  directory_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_path text NOT NULL UNIQUE CHECK (
    legacy_path ~ '^[a-z0-9][a-z0-9/_-]*$'
    AND legacy_path !~ '//' AND right(legacy_path,1)<>'/'
    AND length(legacy_path)<=512
  ),
  title text NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 240),
  summary text NOT NULL CHECK (length(trim(summary)) BETWEEN 1 AND 320),
  created_at timestamptz NOT NULL DEFAULT now()
);

DO $$
DECLARE
  prefix record;
  neutral_title text;
  neutral_summary text := 'Published knowledge formerly available under this public collection.';
BEGIN
  FOR prefix IN
    WITH RECURSIVE published_path(path) AS (
      SELECT public_path
      FROM knowledge_pages
      WHERE archived_at IS NULL
        AND published_version_id IS NOT NULL
        AND public_path IS NOT NULL
    ), public_prefix(path) AS (
      SELECT regexp_replace(path,'/[^/]+$','')
      FROM published_path
      WHERE strpos(path,'/')>0
      UNION
      SELECT regexp_replace(path,'/[^/]+$','')
      FROM public_prefix
      WHERE strpos(path,'/')>0
    )
    SELECT path,depth
    FROM (
      SELECT DISTINCT path,array_length(string_to_array(path,'/'),1) AS depth
      FROM public_prefix WHERE path<>''
    ) paths
    ORDER BY depth,path COLLATE "C"
  LOOP
    neutral_title := left(coalesce(nullif(trim(regexp_replace(replace(replace(
      regexp_replace(prefix.path,'^.*/',''),'-',' '
    ),'_',' '),'[[:space:]]+',' ','g')),''),'Published knowledge'),240);
    IF NOT EXISTS (
      SELECT 1 FROM knowledge_directories WHERE current_path=prefix.path
    ) THEN
      INSERT INTO legacy_public_directory_prefixes(legacy_path,title,summary)
      VALUES (prefix.path,neutral_title,neutral_summary);
    END IF;
  END LOOP;
END;
$$;

CREATE TYPE corpus_migration_phase AS ENUM ('applying','ready','superseded');
CREATE TYPE corpus_migration_item_kind AS ENUM ('directory','page','asset','record');
CREATE TYPE corpus_directory_disposition AS ENUM (
  'root_entrypoint','operational','public_compatibility','hub','retired_template_scaffold'
);
CREATE TYPE corpus_migration_result_kind AS ENUM (
  'preserved','rewritten','hub','root_entrypoint','operational',
  'retired_template_scaffold'
);

CREATE TABLE corpus_migration_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inventory_token text NOT NULL CHECK (inventory_token ~ '^[a-f0-9]{64}$'),
  plan_token text NOT NULL CHECK (plan_token ~ '^[a-f0-9]{64}$'),
  settings_snapshot jsonb NOT NULL CHECK (jsonb_typeof(settings_snapshot)='object'),
  readable_document_ids uuid[] NOT NULL CHECK (
    array_position(readable_document_ids,NULL) IS NULL
  ),
  phase corpus_migration_phase NOT NULL DEFAULT 'applying',
  actor_subject text NOT NULL CHECK (length(trim(actor_subject)) BETWEEN 1 AND 512),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  ready_at timestamptz,
  superseded_at timestamptz,
  CONSTRAINT corpus_migration_runs_phase_timestamps CHECK (
    (phase='applying' AND ready_at IS NULL AND superseded_at IS NULL)
    OR (phase='ready' AND ready_at IS NOT NULL AND superseded_at IS NULL)
    OR (phase='superseded' AND superseded_at IS NOT NULL)
  )
);
CREATE UNIQUE INDEX corpus_migration_runs_one_current_idx
  ON corpus_migration_runs ((true)) WHERE phase IN ('applying','ready');

-- The JSON snapshot is deliberately immutable and run-scoped. It records the
-- exact operational filesystem state that the application hydrated from S3;
-- source_fingerprint lets every completion prove which snapshot it consumed.
CREATE TABLE corpus_migration_inventory (
  run_id uuid NOT NULL REFERENCES corpus_migration_runs(id) ON DELETE CASCADE,
  item_kind corpus_migration_item_kind NOT NULL,
  item_id uuid NOT NULL,
  legacy_path text NOT NULL,
  source_fingerprint text NOT NULL CHECK (source_fingerprint ~ '^[a-f0-9]{64}$'),
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id,item_kind,item_id)
);
CREATE INDEX corpus_migration_inventory_path_idx
  ON corpus_migration_inventory(run_id,legacy_path,item_kind,item_id);

CREATE TABLE corpus_directory_migration_plans (
  run_id uuid NOT NULL REFERENCES corpus_migration_runs(id) ON DELETE CASCADE,
  item_kind corpus_migration_item_kind NOT NULL DEFAULT 'directory'
    CHECK (item_kind='directory'),
  directory_id uuid NOT NULL,
  disposition corpus_directory_disposition NOT NULL,
  private_revision_mode text CHECK (
    private_revision_mode IN ('render','copy','existing')
  ),
  public_revision_mode text CHECK (public_revision_mode IN ('render','existing')),
  private_source_revision_id uuid REFERENCES hypermedia_document_revisions(id) ON DELETE RESTRICT,
  public_source_revision_id uuid REFERENCES hypermedia_document_revisions(id) ON DELETE RESTRICT,
  temporary_path text,
  private_revision_id uuid,
  private_revision_number integer CHECK (
    private_revision_number IS NULL OR private_revision_number>0
  ),
  public_revision_id uuid,
  public_revision_number integer CHECK (
    public_revision_number IS NULL OR public_revision_number>0
  ),
  public_id uuid,
  private_projection_fingerprint text CHECK (
    private_projection_fingerprint IS NULL
    OR private_projection_fingerprint ~ '^[a-f0-9]{64}$'
  ),
  public_projection_fingerprint text CHECK (
    public_projection_fingerprint IS NULL
    OR public_projection_fingerprint ~ '^[a-f0-9]{64}$'
  ),
  PRIMARY KEY (run_id,directory_id),
  FOREIGN KEY (run_id,item_kind,directory_id)
    REFERENCES corpus_migration_inventory(run_id,item_kind,item_id) ON DELETE CASCADE,
  CONSTRAINT corpus_directory_migration_plan_shape CHECK (
    (
      disposition IN ('hub','public_compatibility')
      AND private_revision_mode IS NOT NULL
      AND temporary_path IS NOT NULL
      AND private_revision_id IS NOT NULL
      AND private_revision_number IS NOT NULL
      AND private_projection_fingerprint IS NOT NULL
    ) OR (
      disposition NOT IN ('hub','public_compatibility')
      AND private_revision_mode IS NULL
      AND public_revision_mode IS NULL
      AND private_source_revision_id IS NULL
      AND public_source_revision_id IS NULL
      AND temporary_path IS NULL
      AND private_revision_id IS NULL
      AND private_revision_number IS NULL
      AND public_revision_id IS NULL
      AND public_revision_number IS NULL
      AND public_id IS NULL
      AND private_projection_fingerprint IS NULL
      AND public_projection_fingerprint IS NULL
    )
  ),
  CONSTRAINT corpus_directory_revision_mode_shape CHECK (
    (private_revision_mode='render' AND private_source_revision_id IS NULL)
    OR (private_revision_mode IN ('copy','existing')
      AND private_source_revision_id IS NOT NULL)
    OR private_revision_mode IS NULL
  ),
  CONSTRAINT corpus_directory_public_mode_shape CHECK (
    (public_revision_mode='render' AND public_source_revision_id IS NULL)
    OR (public_revision_mode='existing' AND public_source_revision_id IS NOT NULL)
    OR (public_revision_mode IS NULL AND public_source_revision_id IS NULL)
  ),
  CONSTRAINT corpus_directory_public_plan_shape CHECK (
    (public_revision_id IS NULL AND public_revision_number IS NULL AND public_revision_mode IS NULL)
    OR (public_revision_id IS NOT NULL AND public_revision_number IS NOT NULL
      AND public_revision_mode IS NOT NULL AND public_id IS NOT NULL)
  ),
  CONSTRAINT corpus_directory_temporary_path_format CHECK (
    temporary_path IS NULL OR (
      temporary_path ~ '^[a-z0-9][a-z0-9/_-]*$'
      AND temporary_path !~ '//'
      AND right(temporary_path,1)<>'/'
    )
  ),
  UNIQUE (run_id,temporary_path),
  UNIQUE (run_id,private_revision_id),
  UNIQUE (run_id,public_revision_id),
  UNIQUE (run_id,public_id)
);

CREATE TABLE corpus_page_migration_plans (
  run_id uuid NOT NULL REFERENCES corpus_migration_runs(id) ON DELETE CASCADE,
  item_kind corpus_migration_item_kind NOT NULL DEFAULT 'page'
    CHECK (item_kind='page'),
  document_id uuid NOT NULL,
  source_revision_id uuid NOT NULL,
  rewrite_revision_id uuid,
  rewrite_revision_number integer CHECK (
    rewrite_revision_number IS NULL OR rewrite_revision_number>0
  ),
  rewrite_object_key text,
  PRIMARY KEY (run_id,document_id),
  FOREIGN KEY (run_id,item_kind,document_id)
    REFERENCES corpus_migration_inventory(run_id,item_kind,item_id) ON DELETE CASCADE,
  CONSTRAINT corpus_page_rewrite_plan_shape CHECK (
    (rewrite_revision_id IS NULL AND rewrite_revision_number IS NULL AND rewrite_object_key IS NULL)
    OR (
      rewrite_revision_id IS NOT NULL
      AND rewrite_revision_number IS NOT NULL
      AND rewrite_object_key='documents/private/'||rewrite_revision_id::text||'.md'
    )
  ),
  UNIQUE (run_id,rewrite_revision_id),
  UNIQUE (run_id,rewrite_object_key)
);

CREATE TABLE corpus_migration_automation_plans (
  run_id uuid NOT NULL REFERENCES corpus_migration_runs(id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  key text NOT NULL CHECK (key ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 160),
  instructions_document_id uuid NOT NULL,
  state_document_id uuid,
  PRIMARY KEY (run_id,key),
  UNIQUE (run_id,id),
  UNIQUE (run_id,instructions_document_id),
  UNIQUE (run_id,state_document_id),
  CHECK (state_document_id IS NULL OR state_document_id<>instructions_document_id)
);

CREATE TABLE corpus_migration_completions (
  run_id uuid NOT NULL REFERENCES corpus_migration_runs(id) ON DELETE CASCADE,
  item_kind corpus_migration_item_kind NOT NULL,
  item_id uuid NOT NULL,
  source_fingerprint text NOT NULL CHECK (source_fingerprint ~ '^[a-f0-9]{64}$'),
  result_kind corpus_migration_result_kind NOT NULL,
  output_document_id uuid,
  output_revision_id uuid,
  verified_revision_ids uuid[] NOT NULL DEFAULT '{}'::uuid[] CHECK (
    array_position(verified_revision_ids,NULL) IS NULL
  ),
  verified_public_artifact_ids uuid[] NOT NULL DEFAULT '{}'::uuid[] CHECK (
    array_position(verified_public_artifact_ids,NULL) IS NULL
  ),
  actor_subject text NOT NULL CHECK (length(trim(actor_subject)) BETWEEN 1 AND 512),
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details)='object'),
  completed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id,item_kind,item_id),
  FOREIGN KEY (run_id,item_kind,item_id)
    REFERENCES corpus_migration_inventory(run_id,item_kind,item_id) ON DELETE CASCADE
);

-- This mapping survives the later directory-table removal. Reusing a
-- non-root directory UUID for its ordinary hub makes old directory references
-- deterministic without declaring the hub to be a special entity kind.
CREATE TABLE directory_hub_migrations (
  directory_id uuid PRIMARY KEY,
  document_id uuid NOT NULL UNIQUE
    REFERENCES hypermedia_documents(id) ON DELETE RESTRICT,
  migration_run_id uuid NOT NULL REFERENCES corpus_migration_runs(id) ON DELETE RESTRICT,
  legacy_path text NOT NULL UNIQUE,
  temporary_path text NOT NULL UNIQUE,
  private_revision_id uuid NOT NULL UNIQUE
    REFERENCES hypermedia_document_revisions(id) ON DELETE RESTRICT,
  public_revision_id uuid UNIQUE
    REFERENCES hypermedia_document_revisions(id) ON DELETE RESTRICT,
  public_id uuid UNIQUE REFERENCES public_resources(public_id) ON DELETE RESTRICT,
  private_projection_fingerprint text NOT NULL CHECK (
    private_projection_fingerprint ~ '^[a-f0-9]{64}$'
  ),
  public_projection_fingerprint text CHECK (
    public_projection_fingerprint IS NULL
    OR public_projection_fingerprint ~ '^[a-f0-9]{64}$'
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (directory_id=document_id),
  CHECK (public_revision_id IS NULL OR public_id IS NOT NULL)
);

-- Scheduling remains outside the knowledge graph. This registry says which
-- ordinary private documents are operational instructions/checkpoint state;
-- it contains neither runtime state nor filesystem placement semantics.
CREATE TABLE automation_registry (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL UNIQUE CHECK (key ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 160),
  instructions_document_id uuid NOT NULL UNIQUE
    REFERENCES hypermedia_documents(id) ON DELETE RESTRICT,
  state_document_id uuid UNIQUE
    REFERENCES hypermedia_documents(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz,
  CHECK (state_document_id IS NULL OR state_document_id<>instructions_document_id)
);
CREATE INDEX automation_registry_active_idx ON automation_registry(key) WHERE disabled_at IS NULL;

-- Owner-authored operational-looking pages are preserved as ordinary knowledge.
-- When a configured guide or registered instruction differs from the managed
-- contract, the application first writes a new opaque document object and then
-- uses this ledger to atomically retarget the operational ID. A replaced global
-- guide receives one byte-exact preservation revision at an opaque path so the
-- managed replacement can retain the legacy `agents` path for rollback clients;
-- every pinned source revision and public artifact remains untouched.
CREATE TYPE operational_document_replacement_kind AS ENUM (
  'global_guide','automation_instructions'
);
CREATE TYPE operational_document_replacement_phase AS ENUM (
  'planned','applied','superseded'
);
CREATE TABLE operational_document_replacements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_kind operational_document_replacement_kind NOT NULL,
  target_key text,
  source_document_id uuid NOT NULL,
  source_revision_id uuid NOT NULL,
  agents_occupant_document_id uuid,
  agents_occupant_source_revision_id uuid,
  agents_occupant_preservation_revision_id uuid UNIQUE,
  agents_occupant_preservation_revision_number integer CHECK (
    agents_occupant_preservation_revision_number IS NULL
    OR agents_occupant_preservation_revision_number>0
  ),
  agents_occupant_preservation_path text UNIQUE CHECK (
    agents_occupant_preservation_path IS NULL OR (
      agents_occupant_preservation_path ~ '^preserved-agents-page-[0-9a-f-]{36}$'
      AND length(agents_occupant_preservation_path)<=512
    )
  ),
  agents_occupant_preservation_title text CHECK (
    agents_occupant_preservation_title IS NULL
    OR length(trim(agents_occupant_preservation_title)) BETWEEN 1 AND 240
  ),
  agents_occupant_preservation_summary text CHECK (
    agents_occupant_preservation_summary IS NULL
    OR length(trim(agents_occupant_preservation_summary)) BETWEEN 1 AND 320
  ),
  agents_occupant_preservation_body_object_key text UNIQUE CHECK (
    agents_occupant_preservation_body_object_key IS NULL
    OR agents_occupant_preservation_body_object_key
      ~ '^documents/private/[0-9a-f-]{36}\.md$'
  ),
  agents_occupant_preservation_body_size_bytes integer CHECK (
    agents_occupant_preservation_body_size_bytes IS NULL
    OR agents_occupant_preservation_body_size_bytes BETWEEN 0 AND 4000000
  ),
  agents_occupant_preservation_body_content_hash text CHECK (
    agents_occupant_preservation_body_content_hash IS NULL
    OR agents_occupant_preservation_body_content_hash ~ '^[a-f0-9]{64}$'
  ),
  replacement_document_id uuid NOT NULL UNIQUE,
  replacement_revision_id uuid NOT NULL UNIQUE,
  replacement_path text NOT NULL UNIQUE CHECK (
    replacement_path ~ '^managed-operational-[0-9a-f-]{36}$'
    AND length(replacement_path)<=512
  ),
  replacement_title text NOT NULL CHECK (length(trim(replacement_title)) BETWEEN 1 AND 240),
  replacement_summary text NOT NULL CHECK (length(trim(replacement_summary)) BETWEEN 1 AND 320),
  body_object_key text NOT NULL UNIQUE CHECK (
    body_object_key ~ '^documents/private/[0-9a-f-]{36}\.md$'
  ),
  body_size_bytes integer NOT NULL CHECK (body_size_bytes BETWEEN 0 AND 4000000),
  body_content_hash text NOT NULL CHECK (body_content_hash ~ '^[a-f0-9]{64}$'),
  registration_id uuid,
  registration_was_present boolean,
  registration_name text,
  state_mode text CHECK (state_mode IN ('none','existing','clone')),
  state_source_document_id uuid,
  state_source_revision_id uuid,
  state_replacement_document_id uuid UNIQUE,
  state_replacement_revision_id uuid UNIQUE,
  state_replacement_path text UNIQUE CHECK (
    state_replacement_path IS NULL OR (
      state_replacement_path ~ '^managed-operational-[0-9a-f-]{36}$'
      AND length(state_replacement_path)<=512
    )
  ),
  state_title text CHECK (
    state_title IS NULL OR length(trim(state_title)) BETWEEN 1 AND 240
  ),
  state_summary text CHECK (
    state_summary IS NULL OR length(trim(state_summary)) BETWEEN 1 AND 320
  ),
  state_body_object_key text UNIQUE CHECK (
    state_body_object_key IS NULL
    OR state_body_object_key ~ '^documents/private/[0-9a-f-]{36}\.md$'
  ),
  state_body_size_bytes integer CHECK (
    state_body_size_bytes IS NULL OR state_body_size_bytes BETWEEN 0 AND 4000000
  ),
  state_body_content_hash text CHECK (
    state_body_content_hash IS NULL OR state_body_content_hash ~ '^[a-f0-9]{64}$'
  ),
  actor_subject text NOT NULL CHECK (length(trim(actor_subject)) BETWEEN 1 AND 512),
  phase operational_document_replacement_phase NOT NULL DEFAULT 'planned',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  applied_at timestamptz,
  superseded_at timestamptz,
  CHECK (
    (target_kind='global_guide' AND target_key IS NULL
      AND (
        (agents_occupant_document_id IS NULL
          AND agents_occupant_source_revision_id IS NULL
          AND agents_occupant_preservation_revision_id IS NULL
          AND agents_occupant_preservation_revision_number IS NULL
          AND agents_occupant_preservation_path IS NULL
          AND agents_occupant_preservation_title IS NULL
          AND agents_occupant_preservation_summary IS NULL
          AND agents_occupant_preservation_body_object_key IS NULL
          AND agents_occupant_preservation_body_size_bytes IS NULL
          AND agents_occupant_preservation_body_content_hash IS NULL)
        OR
        (agents_occupant_document_id IS NOT NULL
          AND agents_occupant_source_revision_id IS NOT NULL
          AND agents_occupant_preservation_revision_id IS NOT NULL
          AND agents_occupant_preservation_revision_number IS NOT NULL
          AND agents_occupant_preservation_path IS NOT NULL
          AND agents_occupant_preservation_title IS NOT NULL
          AND agents_occupant_preservation_summary IS NOT NULL
          AND agents_occupant_preservation_body_object_key IS NOT NULL
          AND agents_occupant_preservation_body_size_bytes IS NOT NULL
          AND agents_occupant_preservation_body_content_hash IS NOT NULL)
      )
      AND registration_id IS NULL AND registration_was_present IS NULL
      AND registration_name IS NULL AND state_mode IS NULL
      AND state_source_document_id IS NULL AND state_source_revision_id IS NULL
      AND state_replacement_document_id IS NULL AND state_replacement_revision_id IS NULL
      AND state_replacement_path IS NULL AND state_title IS NULL AND state_summary IS NULL
      AND state_body_object_key IS NULL AND state_body_size_bytes IS NULL
      AND state_body_content_hash IS NULL)
    OR
    (target_kind='automation_instructions'
      AND agents_occupant_document_id IS NULL
      AND agents_occupant_source_revision_id IS NULL
      AND agents_occupant_preservation_revision_id IS NULL
      AND agents_occupant_preservation_revision_number IS NULL
      AND agents_occupant_preservation_path IS NULL
      AND agents_occupant_preservation_title IS NULL
      AND agents_occupant_preservation_summary IS NULL
      AND agents_occupant_preservation_body_object_key IS NULL
      AND agents_occupant_preservation_body_size_bytes IS NULL
      AND agents_occupant_preservation_body_content_hash IS NULL
      AND target_key ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
      AND registration_id IS NOT NULL AND registration_was_present IS NOT NULL
      AND length(trim(registration_name)) BETWEEN 1 AND 160
      AND state_mode IS NOT NULL
      AND state_source_document_id IS DISTINCT FROM source_document_id
      AND (
        (state_mode='none' AND state_source_document_id IS NULL
          AND state_source_revision_id IS NULL
          AND state_replacement_document_id IS NULL
          AND state_replacement_revision_id IS NULL AND state_replacement_path IS NULL
          AND state_title IS NULL AND state_summary IS NULL
          AND state_body_object_key IS NULL AND state_body_size_bytes IS NULL
          AND state_body_content_hash IS NULL)
        OR
        (state_mode='existing' AND state_source_document_id IS NOT NULL
          AND state_source_revision_id IS NOT NULL
          AND state_replacement_document_id IS NULL
          AND state_replacement_revision_id IS NULL AND state_replacement_path IS NULL
          AND state_title IS NULL AND state_summary IS NULL
          AND state_body_object_key IS NULL AND state_body_size_bytes IS NULL
          AND state_body_content_hash IS NULL)
        OR
        (state_mode='clone' AND state_source_document_id IS NOT NULL
          AND state_source_revision_id IS NOT NULL
          AND state_replacement_document_id IS NOT NULL
          AND state_replacement_revision_id IS NOT NULL AND state_replacement_path IS NOT NULL
          AND state_title IS NOT NULL AND state_summary IS NOT NULL
          AND state_body_object_key IS NOT NULL AND state_body_size_bytes IS NOT NULL
          AND state_body_content_hash IS NOT NULL)
      ))
  ),
  CHECK (
    (phase='planned' AND applied_at IS NULL AND superseded_at IS NULL)
    OR (phase='applied' AND applied_at IS NOT NULL AND superseded_at IS NULL)
    OR (phase='superseded' AND applied_at IS NULL AND superseded_at IS NOT NULL)
  )
);
CREATE UNIQUE INDEX operational_document_replacements_one_planned_target_idx
  ON operational_document_replacements (
    target_kind,(coalesce(target_key,''))
  ) WHERE phase='planned';

-- The dashboard role intentionally has no write privilege on connector or
-- object metadata. A fixed definer boundary acquires the consistent SHARE
-- snapshot required by inventory/status/seal without broadening that role.
CREATE FUNCTION lock_corpus_migration_audit_tables()
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
    public_knowledge_settings,public_resources,public_route_aliases,
    public_projection_state,published_page_artifacts IN SHARE MODE;
END;
$$;

-- The first render of a legacy directory becomes ordinary owner-authored
-- knowledge immediately. Serialize that one-time membership snapshot against
-- every table that can move a child into or out of the generated projection;
-- otherwise an unlisted concurrent move could freeze a stale hub forever.
CREATE FUNCTION lock_corpus_migration_hub_apply_tables()
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
    public_knowledge_settings,public_resources,public_route_aliases,
    public_projection_state,published_page_artifacts IN SHARE ROW EXCLUSIVE MODE;
END;
$$;

CREATE FUNCTION corpus_published_artifact_matches(
  p_page_id uuid,
  p_version_id uuid,
  p_artifact_id uuid,
  p_body_object_key text,
  p_body_size_bytes bigint,
  p_body_content_hash text
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
BEGIN
  PERFORM 1
  FROM public_projection_state state
  JOIN published_page_artifacts artifact
    ON artifact.page_id=p_page_id AND artifact.version_id=p_version_id
   AND artifact.projection_generation=state.generation
  WHERE state.singleton
    AND artifact.artifact_id=p_artifact_id
    AND artifact.body_object_key=p_body_object_key
    AND artifact.body_size_bytes=p_body_size_bytes
    AND artifact.body_content_hash=p_body_content_hash
  FOR SHARE OF state,artifact;
  RETURN FOUND;
END;
$$;

CREATE FUNCTION lock_corpus_migration_item(
  p_item_kind corpus_migration_item_kind,
  p_item_id uuid
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
DECLARE
  item_found boolean := false;
BEGIN
  IF p_item_kind='page' THEN
    PERFORM 1 FROM knowledge_pages WHERE id=p_item_id FOR UPDATE;
    item_found := FOUND;
  ELSIF p_item_kind='asset' THEN
    PERFORM 1 FROM assets WHERE id=p_item_id FOR UPDATE;
    item_found := FOUND;
  ELSIF p_item_kind='record' THEN
    PERFORM 1 FROM source_records WHERE document_id=p_item_id FOR UPDATE;
    item_found := FOUND;
  ELSIF p_item_kind='directory' THEN
    PERFORM 1 FROM knowledge_directories WHERE id=p_item_id FOR UPDATE;
    item_found := FOUND;
    IF NOT item_found THEN
      PERFORM 1 FROM legacy_public_directory_prefixes
      WHERE directory_id=p_item_id FOR UPDATE;
      item_found := FOUND;
    END IF;
    PERFORM 1
    FROM directory_hub_migrations mapping
    JOIN knowledge_pages page ON page.id=mapping.document_id
    WHERE mapping.directory_id=p_item_id
    FOR UPDATE OF mapping,page;
  END IF;
  RETURN item_found;
END;
$$;

CREATE FUNCTION prevent_synthetic_public_prefix_collision()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM legacy_public_directory_prefixes
    WHERE legacy_path=NEW.current_path
  ) THEN
    RAISE EXCEPTION 'knowledge directory path is reserved by a legacy public prefix'
      USING ERRCODE='23505';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER knowledge_directories_reserve_synthetic_public_prefixes
BEFORE INSERT OR UPDATE OF current_path ON knowledge_directories
FOR EACH ROW EXECUTE FUNCTION prevent_synthetic_public_prefix_collision();

-- Generated hub bodies may only bind to targets whose lifecycle remains
-- stable through the projection write. SHARE row locks block archive/delete,
-- body advance and asset tombstoning until the applying transaction commits.
CREATE FUNCTION lock_corpus_migration_generated_targets(
  p_run_id uuid,
  p_target_ids uuid[]
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
DECLARE
  target_id uuid;
  matched boolean;
BEGIN
  IF p_target_ids IS NULL OR array_position(p_target_ids,NULL) IS NOT NULL
     OR cardinality(p_target_ids)>100000 THEN
    RAISE EXCEPTION 'generated target array is invalid' USING ERRCODE='22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM corpus_migration_runs
    WHERE id=p_run_id AND phase='applying'
  ) THEN
    RAISE EXCEPTION 'applying corpus migration run not found' USING ERRCODE='P0002';
  END IF;
  FOR target_id IN SELECT DISTINCT unnest(p_target_ids) id ORDER BY id
  LOOP
    matched := false;
    IF EXISTS (
      SELECT 1 FROM corpus_migration_runs
      WHERE id=p_run_id AND target_id=ANY(readable_document_ids)
    ) THEN
      PERFORM 1 FROM knowledge_pages
      WHERE id=target_id AND archived_at IS NULL FOR SHARE;
      matched := FOUND;
      IF NOT matched THEN
        PERFORM 1 FROM source_records WHERE document_id=target_id FOR SHARE;
        matched := FOUND;
      END IF;
      IF NOT matched THEN
        PERFORM 1 FROM assets
        WHERE id=target_id AND deleted_at IS NULL FOR SHARE;
        matched := FOUND;
      END IF;
    END IF;
    IF NOT matched THEN
      RAISE EXCEPTION 'generated hub target is no longer active: %',target_id
        USING ERRCODE='23514';
    END IF;
  END LOOP;
END;
$$;

-- The legacy configured guide may already be public. Preparation replaces its
-- operational role with a new private managed document while preserving the old
-- page and its public pin as ordinary knowledge. Every future configured target
-- is still required to be private by validate_global_knowledge_guide below.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM knowledge_settings settings
    LEFT JOIN knowledge_pages page ON page.id=settings.global_guide_document_id
    LEFT JOIN hypermedia_documents document ON document.id=page.id
    WHERE settings.singleton
      AND settings.global_guide_document_id IS NOT NULL
      AND (
        page.id IS NULL OR page.archived_at IS NOT NULL
        OR document.authority IS DISTINCT FROM 'knowledge'
        OR document.representation IS DISTINCT FROM 'markdown'
      )
  ) THEN
    RAISE EXCEPTION 'configured global guide must be active knowledge Markdown before migration 026'
      USING ERRCODE='23514';
  END IF;
END;
$$;

-- Operational control documents are always active private knowledge. Advisory
-- locks serialize registration/settings changes with publication and prevent a
-- check-then-publish race without retaining any path convention.
CREATE FUNCTION lock_operational_document(p_document_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
  SELECT pg_advisory_xact_lock(hashtextextended('operational-document:'||p_document_id::text,0));
$$;

-- Publication confirmation updates the page row directly through its definer
-- boundary. Take the same transition and document locks as ordinary page
-- writers before that row can be locked, so a concurrent operational retarget
-- cannot form a row/advisory deadlock.
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

  IF NOT FOUND THEN RAISE EXCEPTION 'publication intent not found' USING ERRCODE='P0002'; END IF;
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
    PERFORM pg_advisory_xact_lock_shared(
      hashtextextended('filesystem-hypermedia-corpus-transition',0)
    );
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

  IF NOT FOUND THEN RAISE EXCEPTION 'publication target not found' USING ERRCODE='P0002'; END IF;
  DELETE FROM publication_intents WHERE id=intent.id;
END;
$$;

CREATE FUNCTION validate_automation_registry_documents()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=pg_catalog,public
AS $$
DECLARE
  target_id uuid;
BEGIN
  FOR target_id IN
    SELECT id
    FROM unnest(array_remove(ARRAY[NEW.instructions_document_id,NEW.state_document_id],NULL)) id
    ORDER BY id
  LOOP
    PERFORM lock_operational_document(target_id);
    IF NOT EXISTS (
      SELECT 1
      FROM knowledge_pages page
      JOIN hypermedia_documents document ON document.id=page.id
      WHERE page.id=target_id
        AND page.archived_at IS NULL
        AND page.published_version_id IS NULL
        AND page.public_path IS NULL
        AND document.authority='knowledge'
        AND document.representation='markdown'
      FOR UPDATE OF page
    ) THEN
      RAISE EXCEPTION 'automation documents must be active, private knowledge Markdown'
        USING ERRCODE='23514';
    END IF;
  END LOOP;
  IF EXISTS (
    SELECT 1 FROM knowledge_settings settings
    WHERE settings.singleton
      AND settings.global_guide_document_id=ANY(array_remove(
        ARRAY[NEW.instructions_document_id,NEW.state_document_id],NULL
      ))
  ) THEN
    RAISE EXCEPTION 'the global knowledge guide cannot be an automation document'
      USING ERRCODE='23505';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER automation_registry_validate_documents
BEFORE INSERT OR UPDATE OF instructions_document_id,state_document_id ON automation_registry
FOR EACH ROW EXECUTE FUNCTION validate_automation_registry_documents();

CREATE FUNCTION prevent_automation_document_role_reuse()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
DECLARE
  target_id uuid;
BEGIN
  FOR target_id IN
    SELECT id
    FROM unnest(array_remove(ARRAY[NEW.instructions_document_id,NEW.state_document_id],NULL)) id
    ORDER BY id
  LOOP
    PERFORM lock_operational_document(target_id);
  END LOOP;
  IF EXISTS (
    SELECT 1 FROM automation_registry registry
    WHERE registry.id<>NEW.id
      AND (
        registry.instructions_document_id=ANY(array_remove(
          ARRAY[NEW.instructions_document_id,NEW.state_document_id],NULL
        ))
        OR registry.state_document_id=ANY(array_remove(
          ARRAY[NEW.instructions_document_id,NEW.state_document_id],NULL
        ))
      )
  ) THEN
    RAISE EXCEPTION 'an automation document cannot be reused in another registry role'
      USING ERRCODE='23505';
  END IF;
  IF EXISTS (
    SELECT 1 FROM operational_document_replacements replacement
    WHERE replacement.phase='planned'
      AND replacement.target_kind='global_guide'
      AND replacement.agents_occupant_document_id=ANY(array_remove(
        ARRAY[NEW.instructions_document_id,NEW.state_document_id],NULL
      ))
  ) THEN
    RAISE EXCEPTION 'the agents occupant is reserved by a managed guide handoff'
      USING ERRCODE='23505';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM corpus_migration_automation_plans plan
    JOIN corpus_migration_runs run ON run.id=plan.run_id
    WHERE run.phase='applying'
      AND (
        (
          plan.key=NEW.key
          AND (
            plan.id<>NEW.id
            OR
            plan.instructions_document_id<>NEW.instructions_document_id
            OR plan.state_document_id IS DISTINCT FROM NEW.state_document_id
          )
        )
        OR (
          plan.key<>NEW.key
          AND (
            plan.id=NEW.id
            OR
            plan.instructions_document_id=ANY(array_remove(
              ARRAY[NEW.instructions_document_id,NEW.state_document_id],NULL
            ))
            OR plan.state_document_id=ANY(array_remove(
              ARRAY[NEW.instructions_document_id,NEW.state_document_id],NULL
            ))
          )
        )
      )
  ) THEN
    RAISE EXCEPTION 'an automation document is reserved by the applying corpus plan'
      USING ERRCODE='23505';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER automation_registry_prevent_cross_role_reuse
BEFORE INSERT OR UPDATE OF instructions_document_id,state_document_id ON automation_registry
FOR EACH ROW EXECUTE FUNCTION prevent_automation_document_role_reuse();

CREATE FUNCTION prevent_planned_automation_document_role_reuse()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=pg_catalog,public
AS $$
DECLARE
  target_id uuid;
BEGIN
  FOR target_id IN
    SELECT id
    FROM unnest(array_remove(ARRAY[NEW.instructions_document_id,NEW.state_document_id],NULL)) id
    ORDER BY id
  LOOP
    PERFORM lock_operational_document(target_id);
    IF NOT EXISTS (
      SELECT 1
      FROM knowledge_pages page
      JOIN hypermedia_documents document ON document.id=page.id
      WHERE page.id=target_id
        AND page.archived_at IS NULL
        AND page.published_version_id IS NULL
        AND page.public_path IS NULL
        AND document.authority='knowledge'
        AND document.representation='markdown'
      FOR UPDATE OF page
    ) THEN
      RAISE EXCEPTION 'planned automation documents must be active, private knowledge Markdown'
        USING ERRCODE='23514';
    END IF;
  END LOOP;
  IF EXISTS (
    SELECT 1 FROM corpus_migration_automation_plans plan
    WHERE plan.run_id=NEW.run_id AND plan.key<>NEW.key
      AND (
        plan.instructions_document_id=ANY(array_remove(
          ARRAY[NEW.instructions_document_id,NEW.state_document_id],NULL
        ))
        OR plan.state_document_id=ANY(array_remove(
          ARRAY[NEW.instructions_document_id,NEW.state_document_id],NULL
        ))
      )
  ) THEN
    RAISE EXCEPTION 'a planned automation document cannot be reused in another role'
      USING ERRCODE='23505';
  END IF;
  IF EXISTS (
    SELECT 1 FROM automation_registry registry
    WHERE (
      registry.key=NEW.key
      AND (
        registry.id<>NEW.id
        OR
        registry.instructions_document_id<>NEW.instructions_document_id
        OR registry.state_document_id IS DISTINCT FROM NEW.state_document_id
      )
    ) OR (
      registry.key<>NEW.key
      AND (
        registry.id=NEW.id
        OR
        registry.instructions_document_id=ANY(array_remove(
          ARRAY[NEW.instructions_document_id,NEW.state_document_id],NULL
        ))
        OR registry.state_document_id=ANY(array_remove(
          ARRAY[NEW.instructions_document_id,NEW.state_document_id],NULL
        ))
      )
    )
  ) THEN
    RAISE EXCEPTION 'a planned automation document cannot reuse a registered automation role'
      USING ERRCODE='23505';
  END IF;
  IF EXISTS (
    SELECT 1 FROM knowledge_settings settings
    WHERE settings.singleton
      AND settings.global_guide_document_id=ANY(array_remove(
        ARRAY[NEW.instructions_document_id,NEW.state_document_id],NULL
      ))
  ) THEN
    RAISE EXCEPTION 'the global knowledge guide cannot be a planned automation document'
      USING ERRCODE='23505';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER corpus_automation_plans_prevent_cross_role_reuse
BEFORE INSERT OR UPDATE OF id,instructions_document_id,state_document_id
ON corpus_migration_automation_plans
FOR EACH ROW EXECUTE FUNCTION prevent_planned_automation_document_role_reuse();

-- Dashboard orchestration needs a phantom-safe registry snapshot while it
-- creates object-backed replacement documents. Keep the write-class table
-- lock behind this fixed boundary instead of widening dashboard table DML.
CREATE FUNCTION lock_automation_registry_for_operational_retarget()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
BEGIN
  LOCK TABLE automation_registry IN SHARE ROW EXCLUSIVE MODE;
END;
$$;

-- Operational pointer changes invalidate the corpus inventory. Acquire this
-- relation lock before any knowledge/settings row locks so status/seal (run
-- row first, audit tables second) cannot deadlock with replacement or reset.
CREATE FUNCTION lock_corpus_migration_runs_for_operational_change()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
BEGIN
  LOCK TABLE corpus_migration_runs IN EXCLUSIVE MODE;
END;
$$;

-- Extend the existing guide validator with the same unpublished invariant.
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
    ) OR EXISTS (
      SELECT 1
      FROM corpus_migration_automation_plans plan
      JOIN corpus_migration_runs run ON run.id=plan.run_id
      WHERE run.phase='applying'
        AND (
          plan.instructions_document_id=NEW.global_guide_document_id
          OR plan.state_document_id=NEW.global_guide_document_id
        )
    ) THEN
      RAISE EXCEPTION 'an automation document cannot be the global knowledge guide'
        USING ERRCODE='23505';
    END IF;
    PERFORM 1
    FROM knowledge_pages page
    JOIN hypermedia_documents document ON document.id=page.id
    WHERE page.id=NEW.global_guide_document_id
      AND page.archived_at IS NULL
      AND page.published_version_id IS NULL
      AND page.public_path IS NULL
      AND document.authority='knowledge'
      AND document.representation='markdown'
    FOR UPDATE OF page;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'global guide must be active, private knowledge Markdown'
        USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION prevent_operational_document_publication()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
BEGIN
  PERFORM lock_operational_document(NEW.id);
  IF NEW.published_version_id IS NOT NULL OR NEW.public_path IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM knowledge_settings
      WHERE singleton AND global_guide_document_id=NEW.id
    ) OR EXISTS (
      SELECT 1 FROM automation_registry
      WHERE instructions_document_id=NEW.id OR state_document_id=NEW.id
    ) OR EXISTS (
      SELECT 1
      FROM corpus_migration_automation_plans plan
      JOIN corpus_migration_runs run ON run.id=plan.run_id
      WHERE run.phase='applying'
        AND (plan.instructions_document_id=NEW.id OR plan.state_document_id=NEW.id)
    ) OR EXISTS (
      SELECT 1 FROM directory_hub_migrations
      WHERE document_id=NEW.id
    ) THEN
      RAISE EXCEPTION 'operational control documents cannot be published'
        USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER knowledge_pages_keep_operational_documents_private
BEFORE INSERT OR UPDATE OF published_version_id,public_path ON knowledge_pages
FOR EACH ROW EXECUTE FUNCTION prevent_operational_document_publication();

CREATE FUNCTION prevent_operational_publication_intent()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
BEGIN
  IF NEW.action='publish' AND NEW.target_kind='page' THEN
    PERFORM lock_operational_document(NEW.target_id);
    IF EXISTS (
      SELECT 1 FROM knowledge_settings
      WHERE singleton AND global_guide_document_id=NEW.target_id
    ) OR EXISTS (
      SELECT 1 FROM automation_registry
      WHERE instructions_document_id=NEW.target_id OR state_document_id=NEW.target_id
    ) OR EXISTS (
      SELECT 1
      FROM corpus_migration_automation_plans plan
      JOIN corpus_migration_runs run ON run.id=plan.run_id
      WHERE run.phase='applying'
        AND (
          plan.instructions_document_id=NEW.target_id
          OR plan.state_document_id=NEW.target_id
        )
    ) OR EXISTS (
      SELECT 1 FROM directory_hub_migrations
      WHERE document_id=NEW.target_id
    ) THEN
      RAISE EXCEPTION 'operational control documents cannot be published'
        USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER publication_intents_keep_operational_documents_private
BEFORE INSERT OR UPDATE OF action,target_kind,target_id ON publication_intents
FOR EACH ROW EXECUTE FUNCTION prevent_operational_publication_intent();

CREATE FUNCTION protect_registered_automation_documents()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    PERFORM lock_operational_document(OLD.id);
    IF EXISTS (
      SELECT 1 FROM automation_registry
      WHERE instructions_document_id=OLD.id OR state_document_id=OLD.id
    ) OR EXISTS (
      SELECT 1
      FROM corpus_migration_automation_plans plan
      JOIN corpus_migration_runs run ON run.id=plan.run_id
      WHERE run.phase='applying'
        AND (plan.instructions_document_id=OLD.id OR plan.state_document_id=OLD.id)
    ) THEN
      RAISE EXCEPTION 'registered automation documents cannot be archived or deleted'
        USING ERRCODE='23514';
    END IF;
    IF EXISTS (
      SELECT 1 FROM directory_hub_migrations
      WHERE document_id=OLD.id
    ) THEN
      RAISE EXCEPTION 'converted directory hubs cannot be archived or deleted before cutover'
        USING ERRCODE='23514';
    END IF;
    RETURN OLD;
  END IF;
  PERFORM lock_operational_document(OLD.id);
  IF NEW.archived_at IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM automation_registry
      WHERE instructions_document_id=OLD.id OR state_document_id=OLD.id
    ) OR EXISTS (
      SELECT 1
      FROM corpus_migration_automation_plans plan
      JOIN corpus_migration_runs run ON run.id=plan.run_id
      WHERE run.phase='applying'
        AND (plan.instructions_document_id=OLD.id OR plan.state_document_id=OLD.id)
    ) THEN
      RAISE EXCEPTION 'registered automation documents cannot be archived or deleted'
        USING ERRCODE='23514';
    END IF;
    IF EXISTS (
      SELECT 1 FROM directory_hub_migrations
      WHERE document_id=OLD.id
    ) THEN
      RAISE EXCEPTION 'converted directory hubs cannot be archived or deleted before cutover'
        USING ERRCODE='23514';
    END IF;
  END IF;
  IF NEW.current_path IS DISTINCT FROM OLD.current_path THEN
    IF EXISTS (
      SELECT 1 FROM automation_registry
      WHERE instructions_document_id=OLD.id OR state_document_id=OLD.id
    ) OR EXISTS (
      SELECT 1
      FROM corpus_migration_automation_plans plan
      JOIN corpus_migration_runs run ON run.id=plan.run_id
      WHERE run.phase='applying'
        AND (plan.instructions_document_id=OLD.id OR plan.state_document_id=OLD.id)
    ) THEN
      RAISE EXCEPTION 'registered automation documents cannot be moved before cutover'
        USING ERRCODE='23514';
    END IF;
    IF EXISTS (
      SELECT 1 FROM directory_hub_migrations WHERE document_id=OLD.id
    ) THEN
      RAISE EXCEPTION 'converted directory hubs cannot be moved before cutover'
        USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER knowledge_pages_protect_registered_automation_update
BEFORE UPDATE OF current_path,archived_at ON knowledge_pages
FOR EACH ROW EXECUTE FUNCTION protect_registered_automation_documents();
CREATE TRIGGER knowledge_pages_protect_registered_automation_delete
BEFORE DELETE ON knowledge_pages
FOR EACH ROW EXECUTE FUNCTION protect_registered_automation_documents();

-- Preserve rollback compatibility while replacing the path-scoped root guide.
-- The old-image MCP still discovers the root guide at `agents`, so the corpus
-- preparer may move that one exact occupant only as part of an audited atomic
-- handoff. All ordinary callers retain the baseline immovability guarantee.
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
     AND (NEW.current_path IS DISTINCT FROM 'agents' OR NEW.archived_at IS NOT NULL) THEN
    IF current_user='context_use_boundary_owner'
       AND (
         session_user='context_use_corpus'
         OR current_setting('role',true)='context_use_corpus'
       ) THEN
      IF EXISTS (
        SELECT 1
        FROM operational_document_replacements replacement
        WHERE replacement.id::text
          =current_setting('context_use.operational_guide_swap',true)
          AND replacement.phase='planned'
          AND replacement.target_kind='global_guide'
          AND replacement.agents_occupant_document_id=OLD.id
          AND replacement.agents_occupant_source_revision_id=OLD.current_version_id
          AND NEW.current_path=replacement.agents_occupant_preservation_path
          AND NEW.current_version_id
            =replacement.agents_occupant_preservation_revision_id
          AND NEW.archived_at IS NULL
      ) THEN
        RETURN NEW;
      END IF;
    END IF;
    RAISE EXCEPTION 'the root AGENTS.md page must remain active at agents'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

-- Finish one object-first managed replacement. The page/object rows are
-- inserted by the corpus preparer in the caller's transaction; this narrow
-- boundary verifies their exact planned identity, preserves any legacy page at
-- `agents` with an append-only byte-exact revision, invalidates any older corpus
-- audit and performs the path/pointer handoff atomically. Returning
-- `superseded` commits authoritative target drift without blessing staged rows.
CREATE FUNCTION retarget_managed_operational_document(
  p_replacement_id uuid,
  p_replacement_body_markdown text,
  p_replacement_target_ids uuid[]
)
RETURNS operational_document_replacement_phase
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
DECLARE
  replacement operational_document_replacements%ROWTYPE;
  current_registration record;
  target_id uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('filesystem-hypermedia-corpus-transition',0)
  );
  SELECT * INTO replacement
  FROM operational_document_replacements
  WHERE id=p_replacement_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'operational document replacement not found' USING ERRCODE='P0002';
  END IF;
  PERFORM lock_corpus_migration_runs_for_operational_change();
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'operational-replacement:'||CASE
      WHEN replacement.target_kind='global_guide' THEN 'global-guide'
      ELSE 'automation:'||replacement.target_key
    END,0
  ));
  FOR target_id IN
    SELECT DISTINCT id
    FROM unnest(array_remove(ARRAY[
      replacement.source_document_id,replacement.replacement_document_id,
      replacement.agents_occupant_document_id,
      replacement.state_source_document_id,replacement.state_replacement_document_id
    ],NULL)) id
    ORDER BY id
  LOOP
    PERFORM lock_operational_document(target_id);
  END LOOP;

  SELECT * INTO replacement
  FROM operational_document_replacements
  WHERE id=p_replacement_id
  FOR UPDATE;
  IF replacement.phase<>'planned' THEN
    RETURN replacement.phase;
  END IF;

  IF replacement.target_kind='global_guide' THEN
    IF p_replacement_body_markdown IS NULL
       OR octet_length(p_replacement_body_markdown)<>replacement.body_size_bytes
       OR encode(digest(convert_to(p_replacement_body_markdown,'UTF8'),'sha256'),'hex')
          <>replacement.body_content_hash
       OR p_replacement_target_ids IS NULL THEN
      RAISE EXCEPTION 'managed global guide body does not match its plan'
        USING ERRCODE='23514';
    END IF;
    IF NOT EXISTS (
      SELECT 1
      FROM hypermedia_documents document
      JOIN hypermedia_document_revisions revision
        ON revision.document_id=document.id
      WHERE document.id=replacement.replacement_document_id
        AND document.authority='knowledge' AND document.representation='markdown'
        AND revision.id=replacement.replacement_revision_id
        AND revision.revision_number=1
        AND revision.body_object_key=replacement.body_object_key
        AND revision.body_size_bytes=replacement.body_size_bytes
        AND revision.body_content_hash=replacement.body_content_hash
        AND NOT EXISTS (
          SELECT 1 FROM knowledge_pages
          WHERE id=replacement.replacement_document_id
        )
        AND NOT EXISTS (
          SELECT 1 FROM knowledge_page_versions
          WHERE id=replacement.replacement_revision_id
             OR page_id=replacement.replacement_document_id
        )
      FOR UPDATE OF revision
    ) THEN
      RAISE EXCEPTION 'managed global guide object does not match its plan'
        USING ERRCODE='23514';
    END IF;
  ELSIF NOT EXISTS (
    SELECT 1
    FROM knowledge_pages page
    JOIN hypermedia_documents document ON document.id=page.id
    JOIN hypermedia_document_revisions revision
      ON revision.id=page.current_version_id AND revision.document_id=page.id
    JOIN knowledge_page_versions version
      ON version.id=revision.id AND version.page_id=page.id
    WHERE page.id=replacement.replacement_document_id
      AND page.current_path=replacement.replacement_path
      AND page.current_version_id=replacement.replacement_revision_id
      AND page.archived_at IS NULL
      AND page.published_version_id IS NULL AND page.public_path IS NULL
      AND document.authority='knowledge' AND document.representation='markdown'
      AND revision.revision_number=1
      AND revision.body_object_key=replacement.body_object_key
      AND revision.body_size_bytes=replacement.body_size_bytes
      AND revision.body_content_hash=replacement.body_content_hash
      AND revision.links_indexed_at IS NOT NULL
      AND version.version_number=1 AND version.path=replacement.replacement_path
      AND version.title=replacement.replacement_title
      AND version.summary=replacement.replacement_summary
      AND version.actor_kind='dashboard'
      AND version.actor_subject=replacement.actor_subject
    FOR UPDATE OF page
  ) THEN
    RAISE EXCEPTION 'managed operational replacement page does not match its plan'
      USING ERRCODE='23514';
  END IF;

  IF replacement.state_mode='clone' AND NOT EXISTS (
    SELECT 1
    FROM knowledge_pages page
    JOIN hypermedia_documents document ON document.id=page.id
    JOIN hypermedia_document_revisions revision
      ON revision.id=page.current_version_id AND revision.document_id=page.id
    JOIN knowledge_page_versions version
      ON version.id=revision.id AND version.page_id=page.id
    WHERE page.id=replacement.state_replacement_document_id
      AND page.current_path=replacement.state_replacement_path
      AND page.current_version_id=replacement.state_replacement_revision_id
      AND page.archived_at IS NULL
      AND page.published_version_id IS NULL AND page.public_path IS NULL
      AND document.authority='knowledge' AND document.representation='markdown'
      AND revision.revision_number=1
      AND revision.body_object_key=replacement.state_body_object_key
      AND revision.body_size_bytes=replacement.state_body_size_bytes
      AND revision.body_content_hash=replacement.state_body_content_hash
      AND revision.links_indexed_at IS NOT NULL
      AND version.version_number=1 AND version.path=replacement.state_replacement_path
      AND version.title=replacement.state_title AND version.summary=replacement.state_summary
      AND version.actor_kind='dashboard' AND version.actor_subject=replacement.actor_subject
    FOR UPDATE OF page
  ) THEN
    RAISE EXCEPTION 'managed automation state clone does not match its plan'
      USING ERRCODE='23514';
  END IF;

  IF replacement.target_kind='global_guide'
     AND replacement.agents_occupant_document_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
       FROM knowledge_pages page
       JOIN knowledge_page_versions source_version
         ON source_version.id=page.current_version_id AND source_version.page_id=page.id
       JOIN hypermedia_document_revisions source_revision
         ON source_revision.id=source_version.id AND source_revision.document_id=page.id
       JOIN knowledge_page_versions preserved_version
         ON preserved_version.id=replacement.agents_occupant_preservation_revision_id
           AND preserved_version.page_id=page.id
       JOIN hypermedia_document_revisions preserved_revision
         ON preserved_revision.id=preserved_version.id
           AND preserved_revision.document_id=page.id
       WHERE page.id=replacement.agents_occupant_document_id
         AND page.current_path='agents'
         AND page.current_version_id=replacement.agents_occupant_source_revision_id
         AND page.archived_at IS NULL
         AND source_version.title=replacement.agents_occupant_preservation_title
         AND source_version.summary=replacement.agents_occupant_preservation_summary
         AND source_revision.body_size_bytes
           =replacement.agents_occupant_preservation_body_size_bytes
         AND source_revision.body_content_hash
           =replacement.agents_occupant_preservation_body_content_hash
         AND preserved_version.version_number
           =replacement.agents_occupant_preservation_revision_number
         AND preserved_version.path=replacement.agents_occupant_preservation_path
         AND preserved_version.title=replacement.agents_occupant_preservation_title
         AND preserved_version.summary=replacement.agents_occupant_preservation_summary
         AND preserved_version.actor_kind='dashboard'
         AND preserved_version.actor_subject=replacement.actor_subject
         AND preserved_revision.revision_number
           =replacement.agents_occupant_preservation_revision_number
         AND preserved_revision.body_object_key
           =replacement.agents_occupant_preservation_body_object_key
         AND preserved_revision.body_size_bytes
           =replacement.agents_occupant_preservation_body_size_bytes
         AND preserved_revision.body_content_hash
           =replacement.agents_occupant_preservation_body_content_hash
         AND preserved_revision.links_indexed_at IS NOT NULL
       FOR UPDATE OF page
     ) THEN
    RAISE EXCEPTION 'agents occupant preservation does not match its plan'
      USING ERRCODE='23514';
  END IF;
  IF replacement.target_kind='global_guide'
     AND replacement.agents_occupant_document_id IS NOT NULL
     AND (
       EXISTS (
         SELECT 1 FROM automation_registry
         WHERE instructions_document_id=replacement.agents_occupant_document_id
           OR state_document_id=replacement.agents_occupant_document_id
       )
       OR EXISTS (
         SELECT 1
         FROM corpus_migration_automation_plans plan
         JOIN corpus_migration_runs run ON run.id=plan.run_id
         WHERE run.phase='applying'
           AND (
             plan.instructions_document_id=replacement.agents_occupant_document_id
             OR plan.state_document_id=replacement.agents_occupant_document_id
           )
       )
       OR EXISTS (
         SELECT 1 FROM directory_hub_migrations
         WHERE document_id=replacement.agents_occupant_document_id
       )
     ) THEN
    RAISE EXCEPTION 'the agents occupant is reserved by another operational role'
      USING ERRCODE='23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM knowledge_pages page
    WHERE page.id=replacement.source_document_id
      AND page.current_version_id=replacement.source_revision_id
      AND page.archived_at IS NULL
    FOR UPDATE OF page
  ) THEN
    UPDATE operational_document_replacements
    SET phase='superseded',updated_at=now(),superseded_at=now()
    WHERE id=replacement.id;
    RETURN 'superseded';
  END IF;
  IF replacement.state_mode IN ('existing','clone') AND NOT EXISTS (
    SELECT 1 FROM knowledge_pages page
    WHERE page.id=replacement.state_source_document_id
      AND page.current_version_id=replacement.state_source_revision_id
      AND page.archived_at IS NULL
      AND (
        replacement.state_mode='clone'
        OR (page.published_version_id IS NULL AND page.public_path IS NULL)
      )
    FOR UPDATE OF page
  ) THEN
    UPDATE operational_document_replacements
    SET phase='superseded',updated_at=now(),superseded_at=now()
    WHERE id=replacement.id;
    RETURN 'superseded';
  END IF;

  IF replacement.target_kind='global_guide' THEN
    PERFORM 1 FROM knowledge_settings
    WHERE singleton AND global_guide_document_id=replacement.source_document_id
    FOR UPDATE;
    IF NOT FOUND THEN
      UPDATE operational_document_replacements
      SET phase='superseded',updated_at=now(),superseded_at=now()
      WHERE id=replacement.id;
      RETURN 'superseded';
    END IF;
    IF replacement.agents_occupant_document_id IS NULL THEN
      PERFORM 1 FROM knowledge_pages
      WHERE current_path='agents' AND archived_at IS NULL FOR UPDATE;
      IF FOUND THEN
        UPDATE operational_document_replacements
        SET phase='superseded',updated_at=now(),superseded_at=now()
        WHERE id=replacement.id;
        RETURN 'superseded';
      END IF;
    END IF;
    IF EXISTS (SELECT 1 FROM knowledge_directories WHERE current_path='agents')
       OR EXISTS (
         SELECT 1 FROM assets WHERE current_path='agents' AND deleted_at IS NULL
       ) THEN
      RAISE EXCEPTION 'the agents path is occupied by a non-page resource'
        USING ERRCODE='23505';
    END IF;
  ELSE
    SELECT id,key,instructions_document_id,state_document_id
    INTO current_registration
    FROM automation_registry
    WHERE key=replacement.target_key
    FOR UPDATE;
    IF replacement.registration_was_present THEN
      IF NOT FOUND
         OR current_registration.id<>replacement.registration_id
         OR current_registration.instructions_document_id<>replacement.source_document_id
         OR current_registration.state_document_id
              IS DISTINCT FROM replacement.state_source_document_id THEN
        UPDATE operational_document_replacements
        SET phase='superseded',updated_at=now(),superseded_at=now()
        WHERE id=replacement.id;
        RETURN 'superseded';
      END IF;
    ELSIF FOUND OR EXISTS (
      SELECT 1 FROM automation_registry WHERE id=replacement.registration_id
    ) THEN
      UPDATE operational_document_replacements
      SET phase='superseded',updated_at=now(),superseded_at=now()
      WHERE id=replacement.id;
      RETURN 'superseded';
    END IF;
  END IF;

  -- The inventory no longer describes the operational ID set. Supersede it
  -- before registry triggers examine applying automation reservations.
  UPDATE corpus_migration_runs
  SET phase='superseded',updated_at=now(),superseded_at=now()
  WHERE phase IN ('applying','ready');

  IF replacement.target_kind='global_guide' THEN
    PERFORM set_config(
      'context_use.operational_guide_swap',replacement.id::text,true
    );
    IF replacement.agents_occupant_document_id IS NOT NULL THEN
      UPDATE knowledge_pages
      SET current_path=replacement.agents_occupant_preservation_path,
          current_version_id=replacement.agents_occupant_preservation_revision_id,
          updated_at=now()
      WHERE id=replacement.agents_occupant_document_id
        AND current_path='agents'
        AND current_version_id=replacement.agents_occupant_source_revision_id
        AND archived_at IS NULL;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'agents occupant changed during managed replacement'
          USING ERRCODE='40001';
      END IF;
    END IF;
    INSERT INTO knowledge_pages(id,current_path,current_version_id,search_vector)
    VALUES (
      replacement.replacement_document_id,'agents',replacement.replacement_revision_id,
      page_search_vector(
        'agents',replacement.replacement_title,replacement.replacement_summary,
        p_replacement_body_markdown
      )
    );
    INSERT INTO knowledge_page_versions(
      id,page_id,version_number,path,title,summary,
      commit_message,actor_kind,actor_subject
    ) VALUES (
      replacement.replacement_revision_id,replacement.replacement_document_id,1,
      'agents',replacement.replacement_title,replacement.replacement_summary,
      'Install managed operational document','dashboard',replacement.actor_subject
    );
    PERFORM replace_knowledge_revision_projections(
      replacement.replacement_revision_id,p_replacement_target_ids
    );
    UPDATE knowledge_settings
    SET global_guide_document_id=replacement.replacement_document_id,updated_at=now()
    WHERE singleton AND global_guide_document_id=replacement.source_document_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'global guide changed during managed replacement'
        USING ERRCODE='40001';
    END IF;
  ELSIF replacement.registration_was_present THEN
    UPDATE automation_registry
    SET instructions_document_id=replacement.replacement_document_id,
        state_document_id=coalesce(
          replacement.state_replacement_document_id,replacement.state_source_document_id
        ),updated_at=now()
    WHERE id=replacement.registration_id AND key=replacement.target_key
      AND instructions_document_id=replacement.source_document_id
      AND state_document_id IS NOT DISTINCT FROM replacement.state_source_document_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'automation registration changed during managed replacement'
        USING ERRCODE='40001';
    END IF;
  ELSE
    INSERT INTO automation_registry(
      id,key,name,instructions_document_id,state_document_id
    ) VALUES (
      replacement.registration_id,replacement.target_key,replacement.registration_name,
      replacement.replacement_document_id,coalesce(
        replacement.state_replacement_document_id,replacement.state_source_document_id
      )
    );
  END IF;

  UPDATE operational_document_replacements
  SET phase='applied',updated_at=now(),applied_at=now()
  WHERE id=replacement.id;
  RETURN 'applied';
END;
$$;

-- Until path-independent publication replaces the legacy directory indexes,
-- every non-root prefix of an active published page must keep a concrete
-- directory row. Locking the same directory rows from both sides makes a page
-- publication race with a directory move/delete fail closed. Public assets do
-- not participate in `/p/.../` directory indexes.
CREATE FUNCTION validate_published_page_directory_ancestors()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
DECLARE
  ancestor_path text;
BEGIN
  IF NEW.archived_at IS NULL
     AND NEW.published_version_id IS NOT NULL
     AND NEW.public_path IS NOT NULL THEN
    FOR ancestor_path IN
      WITH RECURSIVE prefix(path) AS (
        SELECT regexp_replace(NEW.public_path,'/[^/]+$','')
        WHERE strpos(NEW.public_path,'/')>0
        UNION ALL
        SELECT regexp_replace(path,'/[^/]+$','')
        FROM prefix WHERE strpos(path,'/')>0
      )
      SELECT path FROM prefix WHERE path<>''
      ORDER BY array_length(string_to_array(path,'/'),1),path COLLATE "C"
    LOOP
      PERFORM 1 FROM knowledge_directories
      WHERE current_path=ancestor_path FOR KEY SHARE;
      IF NOT FOUND THEN
        PERFORM 1 FROM legacy_public_directory_prefixes
        WHERE legacy_path=ancestor_path FOR SHARE;
      END IF;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'published page directory ancestor is missing: %',ancestor_path
          USING ERRCODE='23514';
      END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION protect_published_page_directory_ancestors()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
DECLARE
  directory_path text := OLD.current_path;
BEGIN
  IF EXISTS (
    SELECT 1 FROM directory_hub_migrations WHERE directory_id=OLD.id
  ) THEN
    RAISE EXCEPTION 'a converted legacy directory cannot be moved or deleted before cutover'
      USING ERRCODE='23514';
  END IF;
  IF TG_OP='DELETE' THEN
    PERFORM 1
    FROM knowledge_pages page
    WHERE page.archived_at IS NULL
      AND page.published_version_id IS NOT NULL
      AND page.public_path IS NOT NULL
      AND (
        (directory_path='')
        OR (directory_path<>'' AND page.public_path LIKE directory_path||'/%')
      )
    FOR KEY SHARE OF page;
    IF FOUND THEN
      RAISE EXCEPTION 'a published page directory ancestor cannot be moved or deleted before cutover'
        USING ERRCODE='23514';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.current_path IS DISTINCT FROM OLD.current_path THEN
    PERFORM 1
    FROM knowledge_pages page
    WHERE page.archived_at IS NULL
      AND page.published_version_id IS NOT NULL
      AND page.public_path IS NOT NULL
      AND (
        (directory_path='')
        OR (directory_path<>'' AND page.public_path LIKE directory_path||'/%')
      )
    FOR KEY SHARE OF page;
    IF FOUND THEN
      RAISE EXCEPTION 'a published page directory ancestor cannot be moved or deleted before cutover'
        USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER knowledge_pages_validate_published_directory_ancestors
BEFORE INSERT OR UPDATE OF archived_at,published_version_id,public_path ON knowledge_pages
FOR EACH ROW EXECUTE FUNCTION validate_published_page_directory_ancestors();
CREATE TRIGGER knowledge_directories_protect_published_page_ancestors_update
BEFORE UPDATE OF current_path ON knowledge_directories
FOR EACH ROW EXECUTE FUNCTION protect_published_page_directory_ancestors();
CREATE TRIGGER knowledge_directories_protect_published_page_ancestors_delete
BEFORE DELETE ON knowledge_directories
FOR EACH ROW EXECUTE FUNCTION protect_published_page_directory_ancestors();

-- Reset is the sole privileged operation allowed to relocate the configured
-- guide. It retains that identity and rebuilds it as the pristine root guide;
-- every login role remains subject to the normal lifecycle guard.
CREATE OR REPLACE FUNCTION protect_configured_global_knowledge_guide()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=pg_catalog,public
AS $$
BEGIN
  IF current_user='context_use_reset_owner' THEN
    RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP='DELETE' THEN
    IF EXISTS (
      SELECT 1 FROM knowledge_settings
      WHERE singleton AND global_guide_document_id=OLD.id
    ) THEN
      RAISE EXCEPTION 'the configured global knowledge guide cannot be archived or deleted'
        USING ERRCODE='23514';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.current_path IS DISTINCT FROM OLD.current_path
     AND current_user='context_use_boundary_owner'
     AND (
       session_user='context_use_corpus'
       OR current_setting('role',true)='context_use_corpus'
     ) THEN
    IF EXISTS (
      SELECT 1
      FROM operational_document_replacements replacement
      WHERE replacement.id::text
         =current_setting('context_use.operational_guide_swap',true)
        AND replacement.phase='planned'
        AND replacement.target_kind='global_guide'
        AND (
          (
            replacement.replacement_document_id=OLD.id
            AND OLD.current_path=replacement.replacement_path
            AND NEW.current_path='agents'
            AND NEW.current_version_id=replacement.replacement_revision_id
          )
          OR
          (
            replacement.agents_occupant_document_id=OLD.id
            AND OLD.current_path='agents'
            AND NEW.current_path=replacement.agents_occupant_preservation_path
            AND NEW.current_version_id
              =replacement.agents_occupant_preservation_revision_id
          )
        )
    ) THEN
      RETURN NEW;
    END IF;
  END IF;
  IF (
    NEW.archived_at IS NOT NULL
    OR NEW.current_path IS DISTINCT FROM OLD.current_path
  ) AND EXISTS (
    SELECT 1 FROM knowledge_settings
    WHERE singleton AND global_guide_document_id=OLD.id
  ) THEN
    RAISE EXCEPTION 'the configured global knowledge guide cannot be moved, archived or deleted'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

-- Reset retains the configured guide by identity, not by its transitional
-- filesystem path. This remains valid after a managed replacement has moved
-- configuration to an opaque path and the old `agents` page is ordinary.
CREATE OR REPLACE FUNCTION clear_knowledge(
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
  guide_page_id uuid;
  removable_directory_id uuid;
  removed jsonb;
BEGIN
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

  SELECT
    id,owner_user_id,session_id,expires_at,confirmed_at,
    reset_requested,download_completed_at,reset_completed_at
  INTO intent
  FROM knowledge_export_intents
  WHERE id=p_intent_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'knowledge reset intent not found' USING ERRCODE='P0002';
  END IF;
  IF NOT intent.reset_requested THEN
    RAISE EXCEPTION 'knowledge export was not authorized to clear knowledge' USING ERRCODE='42501';
  END IF;
  IF intent.owner_user_id IS DISTINCT FROM p_owner_user_id
     OR intent.session_id IS DISTINCT FROM p_session_id THEN
    RAISE EXCEPTION 'knowledge reset principal mismatch' USING ERRCODE='42501';
  END IF;
  IF intent.confirmed_at IS NULL THEN
    RAISE EXCEPTION 'knowledge reset passkey confirmation required' USING ERRCODE='42501';
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
  PERFORM lock_corpus_migration_runs_for_operational_change();
  PERFORM pg_advisory_xact_lock(
    hashtextextended('operational-replacement:global-guide',0)
  );
  SELECT global_guide_document_id INTO guide_page_id
  FROM knowledge_settings WHERE singleton FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'configured knowledge reset guide is missing' USING ERRCODE='P0002';
  END IF;

  LOCK TABLE knowledge_directories,knowledge_pages,knowledge_page_versions,
    assets,knowledge_asset_links,knowledge_page_changes IN ACCESS EXCLUSIVE MODE;
  IF NOT EXISTS (
    SELECT 1 FROM knowledge_pages
    WHERE id=guide_page_id AND archived_at IS NULL
  ) THEN
    RAISE EXCEPTION 'configured knowledge reset guide is missing' USING ERRCODE='P0002';
  END IF;

  removed := jsonb_build_object(
    'directories',(SELECT count(*) FROM knowledge_directories),
    'pages',(SELECT count(*) FROM knowledge_pages),
    'page_versions',(SELECT count(*) FROM knowledge_page_versions),
    'assets',(SELECT count(*) FROM assets),
    'asset_links',(SELECT count(*) FROM knowledge_asset_links),
    'page_changes',(SELECT count(*) FROM knowledge_page_changes)
  );

  SET CONSTRAINTS ALL DEFERRED;
  DELETE FROM publication_intents;
  DELETE FROM page_deletion_intents;
  DELETE FROM knowledge_asset_links;
  DELETE FROM knowledge_page_versions;
  DELETE FROM knowledge_pages WHERE id<>guide_page_id;
  DELETE FROM assets;
  FOR removable_directory_id IN
    SELECT id FROM knowledge_directories
    WHERE current_path<>''
    ORDER BY length(current_path) DESC,current_path DESC
  LOOP
    DELETE FROM knowledge_directories WHERE id=removable_directory_id;
  END LOOP;

  UPDATE knowledge_directories
  SET version_number=1,
      title=p_root_title,
      summary=p_root_summary,
      search_vector=directory_search_vector('',p_root_title,p_root_summary,''),
      updated_at=now()
  WHERE current_path='';

  INSERT INTO hypermedia_document_revisions(
    id,document_id,revision_number,body_object_key,body_size_bytes,
    body_content_hash,created_at
  ) VALUES (
    p_guide_version_id,guide_page_id,1,p_guide_object_key,
    p_guide_size_bytes,p_guide_content_hash,now()
  );
  INSERT INTO knowledge_page_versions(
    id,page_id,version_number,path,title,summary,commit_message,
    actor_kind,actor_subject,created_at
  ) VALUES (
    p_guide_version_id,guide_page_id,1,'agents',p_guide_title,p_guide_summary,
    p_guide_commit_message,'dashboard',p_guide_actor_subject,now()
  );

  DELETE FROM knowledge_page_changes;
  PERFORM setval(pg_get_serial_sequence('knowledge_page_changes','change_sequence'),1,false);

  UPDATE knowledge_pages
  SET current_path='agents',
      current_version_id=p_guide_version_id,
      published_version_id=NULL,
      public_path=NULL,
      archived_at=NULL,
      created_at=now(),
      updated_at=now(),
      search_vector=p_guide_search_vector
  WHERE id=guide_page_id;

  UPDATE knowledge_export_intents SET reset_completed_at=now() WHERE id=intent.id;
  RETURN removed;
END;
$$;

-- The reset boundary intentionally clears authored knowledge while connector
-- mirrors remain. Its page-delete statement is the durable point at which the
-- operational registry is emptied and any in-flight filesystem audit becomes
-- unusable; synchronous template installation starts a fresh audit afterward.
CREATE FUNCTION reset_corpus_migration_operational_state()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=pg_catalog,public
AS $$
BEGIN
  IF current_user='context_use_reset_owner' THEN
    DELETE FROM operational_document_replacements;
    DELETE FROM automation_registry;
    DELETE FROM directory_hub_migrations;
    DELETE FROM legacy_public_directory_prefixes;
    -- Reset removes authored revision identities, so its old migration ledger
    -- cannot remain a truthful audit. Cascading the runs establishes an
    -- explicitly unprepared state for synchronous template reinstall.
    DELETE FROM corpus_migration_runs;
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER knowledge_pages_reset_corpus_migration_state
BEFORE DELETE ON knowledge_pages
FOR EACH STATEMENT EXECUTE FUNCTION reset_corpus_migration_operational_state();
CREATE TRIGGER knowledge_page_versions_reset_corpus_migration_state
BEFORE DELETE ON knowledge_page_versions
FOR EACH STATEMENT EXECUTE FUNCTION reset_corpus_migration_operational_state();

-- A connector revision is immutable evidence, never an authored semantic edge.
-- Clean legacy projections, authoritatively mark even zero-edge revisions, and
-- reject future attempts to attach graph meaning to source-controlled bytes.
DELETE FROM document_links link
USING hypermedia_document_revisions revision,hypermedia_documents document
WHERE link.source_revision_id=revision.id
  AND revision.document_id=document.id
  AND document.authority='source';
UPDATE hypermedia_document_revisions revision
SET links_indexed_at=coalesce(revision.links_indexed_at,now()),
    links_index_attempted_at=coalesce(revision.links_index_attempted_at,now())
FROM hypermedia_documents document
WHERE revision.document_id=document.id AND document.authority='source';

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
  IF source_authority='source' THEN
    -- Compatibility with the immediately preceding application release: its
    -- connector writer still submitted links extracted from source bytes. Raw
    -- evidence never defines semantic graph edges, so discard them rather than
    -- wedging ingestion during a rolling deploy or application rollback.
    p_target_document_ids := '{}'::uuid[];
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

-- The boundary-owned replacement function resolves only the revision's
-- authority; expose the join key, not any object location or content metadata.
GRANT SELECT (document_id) ON hypermedia_document_revisions
  TO context_use_boundary_owner;

-- Corpus preparation must repair both derived projections even when an
-- unchanged current revision was indexed by the legacy scanner. Keep DELETE
-- privilege inside this checked, knowledge-only boundary.
CREATE FUNCTION replace_knowledge_revision_projections(
  p_source_revision_id uuid,
  p_target_document_ids uuid[]
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
DECLARE
  source_authority hypermedia_document_authority;
  linked_count integer;
BEGIN
  SELECT document.authority INTO source_authority
  FROM hypermedia_document_revisions revision
  JOIN hypermedia_documents document ON document.id=revision.document_id
  WHERE revision.id=p_source_revision_id
  FOR UPDATE OF revision;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'source revision not found' USING ERRCODE='P0002';
  END IF;
  IF source_authority<>'knowledge' THEN
    RAISE EXCEPTION 'knowledge projection replacement requires a knowledge revision'
      USING ERRCODE='23514';
  END IF;

  DELETE FROM knowledge_asset_links WHERE source_version_id=p_source_revision_id;
  INSERT INTO knowledge_asset_links(source_version_id,target_asset_id)
  SELECT p_source_revision_id,asset.id
  FROM (SELECT DISTINCT unnest(p_target_document_ids) AS id) target
  JOIN assets asset ON asset.id=target.id AND asset.deleted_at IS NULL;
  SELECT replace_document_links(p_source_revision_id,p_target_document_ids)
    INTO linked_count;
  RETURN linked_count;
END;
$$;

REVOKE ALL ON FUNCTION replace_knowledge_revision_projections(uuid,uuid[]) FROM PUBLIC;
GRANT SELECT (id,deleted_at) ON assets TO context_use_boundary_owner;
GRANT SELECT,INSERT,DELETE ON knowledge_asset_links TO context_use_boundary_owner;
GRANT USAGE,CREATE ON SCHEMA public TO context_use_boundary_owner;
ALTER FUNCTION replace_knowledge_revision_projections(uuid,uuid[])
  OWNER TO context_use_boundary_owner;
REVOKE CREATE ON SCHEMA public FROM context_use_boundary_owner;
GRANT EXECUTE ON FUNCTION replace_knowledge_revision_projections(uuid,uuid[])
  TO context_use_corpus;

-- Only this checked boundary can bind a legacy trailing-slash alias to a hub.
-- It deliberately does not create `/p/path` or `/p/path.md`, so an existing
-- page and a legacy directory with the same visible stem retain distinct URLs.
-- Public-safe Markdown is rendered inside PostgreSQL from already-public path
-- slugs and the exact audited target identities. The dashboard may stage S3
-- bytes, but it cannot bless arbitrary prose as a future public revision.
CREATE FUNCTION corpus_public_path_title(p_path text)
RETURNS text
LANGUAGE sql
IMMUTABLE
RETURNS NULL ON NULL INPUT
SET search_path=pg_catalog,public
AS $$
  SELECT left(coalesce(nullif(trim(regexp_replace(replace(replace(
    regexp_replace(p_path,'^.*/',''),'-',' '
  ),'_',' '),'[[:space:]]+',' ','g')),''),'Published knowledge'),240)
$$;

CREATE FUNCTION render_corpus_public_directory_hub(
  p_run_id uuid,
  p_directory_id uuid
) RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
  WITH planned AS (
    SELECT plan.run_id,plan.directory_id,
      coalesce(directory.current_path,synthetic.legacy_path) AS legacy_path
    FROM corpus_directory_migration_plans plan
    JOIN corpus_migration_inventory inventory
      ON inventory.run_id=plan.run_id
     AND inventory.item_kind='directory'
     AND inventory.item_id=plan.directory_id
    JOIN corpus_migration_runs run ON run.id=plan.run_id
    LEFT JOIN knowledge_directories directory ON directory.id=plan.directory_id
    LEFT JOIN legacy_public_directory_prefixes synthetic
      ON synthetic.directory_id=plan.directory_id
    WHERE plan.run_id=p_run_id AND plan.directory_id=p_directory_id
      AND plan.disposition IN ('hub','public_compatibility')
      AND plan.public_revision_id IS NOT NULL
      AND run.phase IN ('applying','ready')
      AND (directory.id IS NOT NULL)<>(synthetic.directory_id IS NOT NULL)
      AND inventory.snapshot->>'path'=
        coalesce(directory.current_path,synthetic.legacy_path)
  ), operational_document AS (
    SELECT settings.global_guide_document_id AS id
    FROM knowledge_settings settings
    JOIN planned ON true
    WHERE settings.singleton AND settings.global_guide_document_id IS NOT NULL
    UNION
    SELECT registry.instructions_document_id
    FROM automation_registry registry
    JOIN planned ON true
    UNION
    SELECT registry.state_document_id
    FROM automation_registry registry
    JOIN planned ON true
    WHERE registry.state_document_id IS NOT NULL
    UNION
    SELECT automation.instructions_document_id
    FROM corpus_migration_automation_plans automation
    JOIN planned ON planned.run_id=automation.run_id
    UNION
    SELECT automation.state_document_id
    FROM corpus_migration_automation_plans automation
    JOIN planned ON planned.run_id=automation.run_id
    WHERE automation.state_document_id IS NOT NULL
  ), target AS (
    SELECT page.id AS document_id,page.public_path AS sort_path,
      corpus_public_path_title(page.public_path) AS label
    FROM knowledge_pages page
    JOIN planned ON true
    WHERE page.archived_at IS NULL
      AND page.published_version_id IS NOT NULL AND page.public_path IS NOT NULL
      AND CASE
        WHEN strpos(page.public_path,'/')=0 THEN ''
        ELSE regexp_replace(page.public_path,'/[^/]+$','')
      END=planned.legacy_path
      AND NOT EXISTS (
        SELECT 1 FROM operational_document
        WHERE operational_document.id=page.id
      )
    UNION ALL
    SELECT child.directory_id,coalesce(directory.current_path,synthetic.legacy_path),
      corpus_public_path_title(coalesce(directory.current_path,synthetic.legacy_path))
    FROM corpus_directory_migration_plans child
    JOIN corpus_migration_inventory child_inventory
      ON child_inventory.run_id=child.run_id
     AND child_inventory.item_kind='directory'
     AND child_inventory.item_id=child.directory_id
    JOIN planned ON planned.run_id=child.run_id
    LEFT JOIN knowledge_directories directory ON directory.id=child.directory_id
    LEFT JOIN legacy_public_directory_prefixes synthetic
      ON synthetic.directory_id=child.directory_id
    WHERE child.public_revision_id IS NOT NULL
      AND (directory.id IS NOT NULL)<>(synthetic.directory_id IS NOT NULL)
      AND child_inventory.snapshot->>'path'=
        coalesce(directory.current_path,synthetic.legacy_path)
      AND EXISTS (
        SELECT 1 FROM knowledge_pages descendant
        WHERE descendant.archived_at IS NULL
          AND descendant.published_version_id IS NOT NULL
          AND descendant.public_path IS NOT NULL
          AND left(
            descendant.public_path,
            length(coalesce(directory.current_path,synthetic.legacy_path))+1
          )=coalesce(directory.current_path,synthetic.legacy_path)||'/'
      )
      AND CASE
        WHEN strpos(coalesce(directory.current_path,synthetic.legacy_path),'/')=0 THEN ''
        ELSE regexp_replace(
          coalesce(directory.current_path,synthetic.legacy_path),'/[^/]+$',''
        )
      END=planned.legacy_path
  )
  SELECT '# '||corpus_public_path_title(planned.legacy_path)
    ||E'\n\nPublished knowledge formerly available under this public collection.'
    ||CASE WHEN EXISTS (SELECT 1 FROM target) THEN
      E'\n\n## Contents\n\n'||(
        SELECT string_agg(
          '- ['||target.label||'](context-use://document/'||target.document_id::text||')',
          E'\n' ORDER BY target.sort_path COLLATE "C",target.document_id
        ) FROM target
      )
    ELSE '' END||E'\n'
  FROM planned
$$;

CREATE FUNCTION register_directory_hub_migration(
  p_run_id uuid,
  p_directory_id uuid
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
DECLARE
  plan record;
  snapshot jsonb;
  resolved_public_id uuid;
  expected_public_body text;
  expected_public_title text;
  expected_public_summary text :=
    'Published knowledge formerly available under this public collection.';
  public_revision record;
  actual_legacy_path text;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('filesystem-hypermedia-corpus-transition',0)
  );
  PERFORM 1 FROM corpus_migration_runs
  WHERE id=p_run_id AND phase='applying' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active directory hub plan not found' USING ERRCODE='P0002';
  END IF;
  PERFORM lock_corpus_migration_hub_apply_tables();

  SELECT directory_plan.*,inventory.snapshot
  INTO plan
  FROM corpus_directory_migration_plans directory_plan
  JOIN corpus_migration_inventory inventory
    ON inventory.run_id=directory_plan.run_id
   AND inventory.item_kind='directory'
   AND inventory.item_id=directory_plan.directory_id
  JOIN corpus_migration_runs run ON run.id=directory_plan.run_id
  WHERE directory_plan.run_id=p_run_id
    AND directory_plan.directory_id=p_directory_id
    AND directory_plan.disposition IN ('hub','public_compatibility')
    AND run.phase='applying'
  FOR UPDATE OF directory_plan;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active directory hub plan not found' USING ERRCODE='P0002';
  END IF;
  snapshot := plan.snapshot;
  PERFORM lock_operational_document(plan.directory_id);

  SELECT coalesce(directory.current_path,synthetic.legacy_path)
  INTO actual_legacy_path
  FROM (SELECT plan.directory_id) identity
  LEFT JOIN knowledge_directories directory ON directory.id=identity.directory_id
  LEFT JOIN legacy_public_directory_prefixes synthetic
    ON synthetic.directory_id=identity.directory_id
  WHERE (directory.id IS NOT NULL)<>(synthetic.directory_id IS NOT NULL);
  IF actual_legacy_path IS NULL OR actual_legacy_path<>snapshot->>'path' THEN
    RAISE EXCEPTION 'legacy directory authority does not match its migration plan'
      USING ERRCODE='23514';
  END IF;

  IF p_directory_id<>plan.directory_id
     OR NOT EXISTS (
       SELECT 1 FROM knowledge_pages page
       WHERE page.id=plan.directory_id
         AND page.current_path=plan.temporary_path
         AND page.current_version_id=plan.private_revision_id
         AND page.archived_at IS NULL
         AND page.published_version_id IS NULL
         AND page.public_path IS NULL
     ) THEN
    RAISE EXCEPTION 'directory hub does not match its migration plan'
      USING ERRCODE='23514';
  END IF;

  IF plan.public_revision_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM knowledge_pages page
      WHERE page.archived_at IS NULL AND page.published_version_id IS NOT NULL
        AND page.public_path IS NOT NULL
        AND left(page.public_path,length(actual_legacy_path)+1)=actual_legacy_path||'/'
    ) THEN
      RAISE EXCEPTION 'public directory compatibility route is no longer reachable'
        USING ERRCODE='23514';
    END IF;
    IF EXISTS (
      SELECT 1
      FROM knowledge_pages page
      CROSS JOIN public_projection_state projection
      LEFT JOIN published_page_artifacts artifact
        ON artifact.page_id=page.id AND artifact.version_id=page.published_version_id
       AND artifact.projection_generation=projection.generation
      WHERE page.archived_at IS NULL AND page.published_version_id IS NOT NULL
        AND page.public_path IS NOT NULL
        AND CASE
          WHEN strpos(page.public_path,'/')=0 THEN ''
          ELSE regexp_replace(page.public_path,'/[^/]+$','')
        END=actual_legacy_path
        AND artifact.artifact_id IS NULL
    ) THEN
      RAISE EXCEPTION 'public directory page artifact is missing'
        USING ERRCODE='23514';
    END IF;
    IF EXISTS (
      SELECT 1
      FROM corpus_directory_migration_plans child
      LEFT JOIN knowledge_directories directory ON directory.id=child.directory_id
      LEFT JOIN legacy_public_directory_prefixes synthetic
        ON synthetic.directory_id=child.directory_id
      LEFT JOIN directory_hub_migrations mapping
        ON mapping.directory_id=child.directory_id
       AND mapping.public_revision_id=child.public_revision_id
      WHERE child.run_id=plan.run_id AND child.public_revision_id IS NOT NULL
        AND CASE
          WHEN strpos(coalesce(directory.current_path,synthetic.legacy_path),'/')=0 THEN ''
          ELSE regexp_replace(
            coalesce(directory.current_path,synthetic.legacy_path),'/[^/]+$',''
          )
        END=actual_legacy_path
        AND mapping.directory_id IS NULL
    ) THEN
      RAISE EXCEPTION 'public child directory compatibility mapping is incomplete'
        USING ERRCODE='23514';
    END IF;
    expected_public_body := render_corpus_public_directory_hub(
      plan.run_id,plan.directory_id
    );
    expected_public_title := corpus_public_path_title(snapshot->>'path');
    SELECT revision.body_size_bytes,revision.body_content_hash,
      version.path,version.title,version.summary
    INTO public_revision
    FROM hypermedia_document_revisions revision
    JOIN knowledge_page_versions version
      ON version.id=revision.id AND version.page_id=revision.document_id
    WHERE revision.id=plan.public_revision_id
      AND revision.document_id=plan.directory_id;
    IF NOT FOUND OR expected_public_body IS NULL
       OR public_revision.body_size_bytes<>octet_length(expected_public_body)
       OR public_revision.body_content_hash<>
          encode(digest(convert_to(expected_public_body,'UTF8'),'sha256'),'hex')
       OR public_revision.path<>plan.temporary_path
       OR public_revision.title<>expected_public_title
       OR public_revision.summary<>expected_public_summary THEN
      RAISE EXCEPTION 'public-safe directory hub revision failed deterministic proof'
        USING ERRCODE='23514';
    END IF;
    INSERT INTO public_resources(public_id,document_id,resource_kind)
    VALUES (plan.public_id,plan.directory_id,'page')
    ON CONFLICT (public_id) DO NOTHING;
    IF NOT EXISTS (
      SELECT 1 FROM public_resources
      WHERE public_id=plan.public_id AND document_id=plan.directory_id AND resource_kind='page'
    ) THEN
      RAISE EXCEPTION 'directory hub public identity is permanently assigned'
        USING ERRCODE='23505';
    END IF;
    INSERT INTO public_route_aliases(alias_path,route_kind,public_id)
    VALUES ('/p/'||(snapshot->>'path')||'/','directory',plan.public_id)
    ON CONFLICT (alias_path) DO NOTHING;
    IF NOT EXISTS (
      SELECT 1 FROM public_route_aliases
      WHERE alias_path='/p/'||(snapshot->>'path')||'/'
        AND route_kind='directory' AND public_id=plan.public_id
    ) THEN
      RAISE EXCEPTION 'legacy directory route alias is permanently assigned'
        USING ERRCODE='23505';
    END IF;
    resolved_public_id := plan.public_id;
  END IF;

  INSERT INTO directory_hub_migrations(
    directory_id,document_id,migration_run_id,legacy_path,temporary_path,
    private_revision_id,public_revision_id,public_id,
    private_projection_fingerprint,public_projection_fingerprint
  ) VALUES (
    plan.directory_id,plan.directory_id,plan.run_id,snapshot->>'path',plan.temporary_path,
    plan.private_revision_id,plan.public_revision_id,resolved_public_id,
    plan.private_projection_fingerprint,plan.public_projection_fingerprint
  ) ON CONFLICT (directory_id) DO UPDATE
    SET migration_run_id=excluded.migration_run_id,
        private_revision_id=excluded.private_revision_id,
        public_revision_id=excluded.public_revision_id,
        public_id=coalesce(excluded.public_id,directory_hub_migrations.public_id),
        private_projection_fingerprint=excluded.private_projection_fingerprint,
        public_projection_fingerprint=excluded.public_projection_fingerprint
    WHERE directory_hub_migrations.document_id=excluded.document_id
      AND directory_hub_migrations.legacy_path=excluded.legacy_path
      AND directory_hub_migrations.temporary_path=excluded.temporary_path
      AND (
        excluded.public_id IS NULL
        OR directory_hub_migrations.public_id IS NULL
        OR directory_hub_migrations.public_id=excluded.public_id
      );
  IF NOT EXISTS (
    SELECT 1 FROM directory_hub_migrations mapping
    WHERE mapping.directory_id=plan.directory_id
      AND mapping.document_id=plan.directory_id
      AND mapping.migration_run_id=plan.run_id
      AND mapping.private_revision_id=plan.private_revision_id
      AND mapping.public_revision_id IS NOT DISTINCT FROM plan.public_revision_id
      AND mapping.private_projection_fingerprint=plan.private_projection_fingerprint
      AND mapping.public_projection_fingerprint IS NOT DISTINCT FROM plan.public_projection_fingerprint
      AND (plan.public_id IS NULL OR mapping.public_id=plan.public_id)
  ) THEN
    RAISE EXCEPTION 'directory hub mapping conflicts with an earlier migration'
      USING ERRCODE='23505';
  END IF;
  SELECT public_id INTO resolved_public_id
  FROM directory_hub_migrations WHERE directory_id=plan.directory_id;
  RETURN resolved_public_id;
END;
$$;

REVOKE ALL ON FUNCTION lock_operational_document(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION lock_corpus_migration_audit_tables() FROM PUBLIC;
REVOKE ALL ON FUNCTION lock_corpus_migration_hub_apply_tables() FROM PUBLIC;
REVOKE ALL ON FUNCTION corpus_published_artifact_matches(uuid,uuid,uuid,text,bigint,text)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION lock_corpus_migration_item(corpus_migration_item_kind,uuid)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION prevent_synthetic_public_prefix_collision() FROM PUBLIC;
REVOKE ALL ON FUNCTION lock_corpus_migration_generated_targets(uuid,uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION validate_automation_registry_documents() FROM PUBLIC;
REVOKE ALL ON FUNCTION validate_global_knowledge_guide() FROM PUBLIC;
REVOKE ALL ON FUNCTION prevent_automation_document_role_reuse() FROM PUBLIC;
REVOKE ALL ON FUNCTION prevent_planned_automation_document_role_reuse() FROM PUBLIC;
REVOKE ALL ON FUNCTION lock_automation_registry_for_operational_retarget() FROM PUBLIC;
REVOKE ALL ON FUNCTION lock_corpus_migration_runs_for_operational_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION prevent_operational_document_publication() FROM PUBLIC;
REVOKE ALL ON FUNCTION prevent_operational_publication_intent() FROM PUBLIC;
REVOKE ALL ON FUNCTION protect_registered_automation_documents() FROM PUBLIC;
REVOKE ALL ON FUNCTION retarget_managed_operational_document(uuid,text,uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION validate_published_page_directory_ancestors() FROM PUBLIC;
REVOKE ALL ON FUNCTION protect_published_page_directory_ancestors() FROM PUBLIC;
REVOKE ALL ON FUNCTION reset_corpus_migration_operational_state() FROM PUBLIC;
REVOKE ALL ON FUNCTION corpus_public_path_title(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION render_corpus_public_directory_hub(uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION register_directory_hub_migration(uuid,uuid) FROM PUBLIC;

GRANT SELECT,INSERT,UPDATE,DELETE ON automation_registry TO context_use_boundary_owner;
GRANT SELECT,INSERT,UPDATE,DELETE ON operational_document_replacements
  TO context_use_boundary_owner;
GRANT SELECT,INSERT,UPDATE,DELETE ON directory_hub_migrations TO context_use_boundary_owner;
GRANT SELECT,UPDATE ON legacy_public_directory_prefixes TO context_use_boundary_owner;
GRANT SELECT,INSERT,UPDATE,DELETE ON corpus_migration_runs,
  corpus_migration_inventory,corpus_directory_migration_plans,
  corpus_page_migration_plans,corpus_migration_automation_plans,
  corpus_migration_completions TO context_use_boundary_owner;
GRANT UPDATE ON knowledge_directories,knowledge_pages,knowledge_page_versions,
  assets,source_records,hypermedia_document_revisions,document_links,
  knowledge_asset_links,automation_registry,knowledge_settings,
  public_knowledge_settings,public_resources,public_route_aliases,
  public_projection_state,published_page_artifacts TO context_use_boundary_owner;
GRANT INSERT ON knowledge_pages,knowledge_page_versions TO context_use_boundary_owner;
GRANT EXECUTE ON FUNCTION page_search_vector(text,text,text,text)
  TO context_use_boundary_owner;
GRANT SELECT (singleton,generation) ON public_projection_state
  TO context_use_boundary_owner;
GRANT SELECT (
  artifact_id,page_id,version_id,projection_generation,
  body_object_key,body_size_bytes,body_content_hash
) ON published_page_artifacts TO context_use_boundary_owner;
GRANT SELECT (id,current_path) ON knowledge_directories
  TO context_use_boundary_owner;
GRANT SELECT (id) ON assets TO context_use_boundary_owner;
GRANT SELECT (
  id,current_path,current_version_id,archived_at,published_version_id,public_path
)
  ON knowledge_pages TO context_use_boundary_owner;
GRANT SELECT (
  id,page_id,version_number,path,title,summary,actor_kind,actor_subject
) ON knowledge_page_versions TO context_use_boundary_owner;
GRANT SELECT (
  id,document_id,revision_number,body_object_key,body_size_bytes,
  body_content_hash,links_indexed_at
) ON hypermedia_document_revisions TO context_use_boundary_owner;
GRANT SELECT (document_id) ON source_records TO context_use_boundary_owner;
GRANT USAGE,CREATE ON SCHEMA public TO context_use_boundary_owner;
ALTER FUNCTION prevent_operational_document_publication() OWNER TO context_use_boundary_owner;
ALTER FUNCTION prevent_operational_publication_intent() OWNER TO context_use_boundary_owner;
ALTER FUNCTION prevent_automation_document_role_reuse()
  OWNER TO context_use_boundary_owner;
ALTER FUNCTION protect_registered_automation_documents() OWNER TO context_use_boundary_owner;
ALTER FUNCTION retarget_managed_operational_document(uuid,text,uuid[])
  OWNER TO context_use_boundary_owner;
ALTER FUNCTION validate_published_page_directory_ancestors()
  OWNER TO context_use_boundary_owner;
ALTER FUNCTION protect_published_page_directory_ancestors()
  OWNER TO context_use_boundary_owner;
ALTER FUNCTION reset_corpus_migration_operational_state() OWNER TO context_use_boundary_owner;
ALTER FUNCTION corpus_public_path_title(text) OWNER TO context_use_boundary_owner;
ALTER FUNCTION render_corpus_public_directory_hub(uuid,uuid)
  OWNER TO context_use_boundary_owner;
ALTER FUNCTION register_directory_hub_migration(uuid,uuid) OWNER TO context_use_boundary_owner;
ALTER FUNCTION lock_operational_document(uuid) OWNER TO context_use_boundary_owner;
ALTER FUNCTION lock_automation_registry_for_operational_retarget()
  OWNER TO context_use_boundary_owner;
ALTER FUNCTION lock_corpus_migration_runs_for_operational_change()
  OWNER TO context_use_boundary_owner;
ALTER FUNCTION validate_global_knowledge_guide() OWNER TO context_use_boundary_owner;
ALTER FUNCTION lock_corpus_migration_audit_tables() OWNER TO context_use_boundary_owner;
ALTER FUNCTION lock_corpus_migration_hub_apply_tables() OWNER TO context_use_boundary_owner;
ALTER FUNCTION corpus_published_artifact_matches(uuid,uuid,uuid,text,bigint,text)
  OWNER TO context_use_boundary_owner;
ALTER FUNCTION lock_corpus_migration_item(corpus_migration_item_kind,uuid)
  OWNER TO context_use_boundary_owner;
ALTER FUNCTION prevent_synthetic_public_prefix_collision()
  OWNER TO context_use_boundary_owner;
ALTER FUNCTION lock_corpus_migration_generated_targets(uuid,uuid[])
  OWNER TO context_use_boundary_owner;
REVOKE CREATE ON SCHEMA public FROM context_use_boundary_owner;

GRANT EXECUTE ON FUNCTION lock_operational_document(uuid)
  TO context_use_dashboard,context_use_mcp,context_use_boundary_owner;
GRANT EXECUTE ON FUNCTION lock_automation_registry_for_operational_retarget()
  TO context_use_corpus;
GRANT EXECUTE ON FUNCTION lock_corpus_migration_runs_for_operational_change()
  TO context_use_corpus,context_use_reset_owner;
GRANT EXECUTE ON FUNCTION lock_corpus_migration_audit_tables()
  TO context_use_corpus;
GRANT EXECUTE ON FUNCTION lock_corpus_migration_hub_apply_tables()
  TO context_use_corpus;
GRANT EXECUTE ON FUNCTION corpus_published_artifact_matches(uuid,uuid,uuid,text,bigint,text)
  TO context_use_corpus;
GRANT EXECUTE ON FUNCTION lock_corpus_migration_item(corpus_migration_item_kind,uuid)
  TO context_use_corpus;
GRANT EXECUTE ON FUNCTION lock_corpus_migration_generated_targets(uuid,uuid[])
  TO context_use_corpus;
GRANT EXECUTE ON FUNCTION render_corpus_public_directory_hub(uuid,uuid)
  TO context_use_corpus;
GRANT EXECUTE ON FUNCTION retarget_managed_operational_document(uuid,text,uuid[])
  TO context_use_corpus;

GRANT SELECT (singleton,generation) ON public_projection_state TO context_use_corpus;
GRANT SELECT (
  artifact_id,page_id,version_id,projection_generation,
  body_object_key,body_size_bytes,body_content_hash
) ON published_page_artifacts TO context_use_corpus;

GRANT DELETE ON automation_registry,directory_hub_migrations,
  legacy_public_directory_prefixes,operational_document_replacements
  TO context_use_reset_owner;
GRANT DELETE ON corpus_migration_runs TO context_use_reset_owner;
GRANT UPDATE (published_version_id,public_path,archived_at,updated_at)
  ON knowledge_pages TO context_use_reset_owner;
GRANT UPDATE (global_guide_document_id,updated_at)
  ON knowledge_settings TO context_use_reset_owner;

GRANT SELECT,INSERT ON corpus_migration_runs,corpus_migration_inventory,
  corpus_directory_migration_plans,corpus_page_migration_plans,
  corpus_migration_automation_plans,corpus_migration_completions
  TO context_use_corpus;
GRANT UPDATE (phase,updated_at,ready_at,superseded_at)
  ON corpus_migration_runs TO context_use_corpus;
GRANT SELECT ON directory_hub_migrations TO context_use_corpus;
GRANT SELECT ON legacy_public_directory_prefixes TO context_use_corpus;
GRANT EXECUTE ON FUNCTION register_directory_hub_migration(uuid,uuid)
  TO context_use_corpus;

GRANT SELECT,INSERT ON automation_registry TO context_use_dashboard;
GRANT UPDATE (name,updated_at,disabled_at) ON automation_registry TO context_use_dashboard;

GRANT SELECT,INSERT ON operational_document_replacements TO context_use_corpus;
GRANT UPDATE (phase,updated_at,superseded_at)
  ON operational_document_replacements TO context_use_corpus;

GRANT SELECT ON corpus_migration_runs,corpus_migration_inventory,
  corpus_directory_migration_plans,corpus_page_migration_plans,
  corpus_migration_automation_plans,corpus_migration_completions,
  directory_hub_migrations,legacy_public_directory_prefixes,automation_registry,
  operational_document_replacements
  TO context_use_backup;

-- MCP, public and storage credentials deliberately receive no migration or
-- automation-registry reads. In particular, public routing still exposes hubs
-- only after the later cutover changes its public-safe projection.
