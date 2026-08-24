-- Provide a fresh-install bootstrap that creates only stable hypermedia
-- documents. Existing installations must have completed the v0.1.82 cutover;
-- this boundary never tries to reinterpret retained filesystem-era data.

SELECT pg_advisory_xact_lock(
  hashtextextended('filesystem-hypermedia-corpus-transition',0)
);

CREATE TABLE hypermedia_bootstrap_allocations (
  document_kind text PRIMARY KEY CHECK (document_kind IN (
    'global_guide',
    'activity_distiller_instructions','activity_distiller_state',
    'diary_composer_instructions','diary_composer_state'
  )),
  document_id uuid NOT NULL UNIQUE,
  revision_id uuid NOT NULL UNIQUE,
  allocated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CHECK (completed_at IS NULL OR completed_at>=allocated_at)
);

CREATE FUNCTION guard_hypermedia_bootstrap_allocations()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
BEGIN
  IF TG_OP='DELETE'
     OR NEW.document_kind IS DISTINCT FROM OLD.document_kind
     OR NEW.document_id IS DISTINCT FROM OLD.document_id
     OR NEW.revision_id IS DISTINCT FROM OLD.revision_id
     OR NEW.allocated_at IS DISTINCT FROM OLD.allocated_at
     OR OLD.completed_at IS NOT NULL
     OR NEW.completed_at IS NULL THEN
    RAISE EXCEPTION 'hypermedia bootstrap allocations are immutable'
      USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER hypermedia_bootstrap_040_keep_allocations
BEFORE UPDATE OR DELETE ON hypermedia_bootstrap_allocations
FOR EACH ROW EXECUTE FUNCTION guard_hypermedia_bootstrap_allocations();

CREATE FUNCTION begin_hypermedia_bootstrap()
RETURNS TABLE(document_kind text,document_id uuid,revision_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
DECLARE
  cutover_finalized_at timestamptz;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('filesystem-hypermedia-corpus-transition',0)
  );
  SELECT state.finalized_at INTO cutover_finalized_at
  FROM hypermedia_cutover_state state
  WHERE state.singleton
  FOR UPDATE;
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
       OR EXISTS (SELECT 1 FROM corpus_migration_runs)
       OR EXISTS (SELECT 1 FROM pathless_publication_adoptions)
       OR EXISTS (
         SELECT 1 FROM knowledge_settings
         WHERE global_guide_document_id IS NOT NULL
       )
       OR EXISTS (
         SELECT 1 FROM pathless_publication_settings
         WHERE updated_at IS NOT NULL
       ) THEN
      RAISE EXCEPTION
        'retained data requires a completed v0.1.82 hypermedia cutover'
        USING ERRCODE='55000';
    END IF;

    INSERT INTO hypermedia_bootstrap_allocations(
      document_kind,document_id,revision_id
    )
    SELECT kind,gen_random_uuid(),gen_random_uuid()
    FROM unnest(ARRAY[
      'global_guide',
      'activity_distiller_instructions','activity_distiller_state',
      'diary_composer_instructions','diary_composer_state'
    ]::text[]) AS kind;
  END IF;

  IF (SELECT count(*) FROM hypermedia_bootstrap_allocations)<>5 THEN
    RAISE EXCEPTION 'hypermedia bootstrap allocation set is incomplete'
      USING ERRCODE='55000';
  END IF;

  RETURN QUERY
  SELECT allocation.document_kind,allocation.document_id,allocation.revision_id
  FROM hypermedia_bootstrap_allocations allocation
  ORDER BY allocation.document_kind;
END;
$$;

CREATE FUNCTION complete_hypermedia_bootstrap()
RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
SET jit=off
AS $$
DECLARE
  cutover_completed_at timestamptz;
  guide_id uuid;
  activity_instructions_id uuid;
  activity_state_id uuid;
  diary_instructions_id uuid;
  diary_state_id uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('filesystem-hypermedia-corpus-transition',0)
  );
  SELECT state.finalized_at INTO cutover_completed_at
  FROM hypermedia_cutover_state state
  WHERE state.singleton
  FOR UPDATE;
  IF cutover_completed_at IS NOT NULL THEN RETURN cutover_completed_at; END IF;

  SELECT document_id INTO guide_id FROM hypermedia_bootstrap_allocations
  WHERE document_kind='global_guide';
  SELECT document_id INTO activity_instructions_id
  FROM hypermedia_bootstrap_allocations
  WHERE document_kind='activity_distiller_instructions';
  SELECT document_id INTO activity_state_id
  FROM hypermedia_bootstrap_allocations
  WHERE document_kind='activity_distiller_state';
  SELECT document_id INTO diary_instructions_id
  FROM hypermedia_bootstrap_allocations
  WHERE document_kind='diary_composer_instructions';
  SELECT document_id INTO diary_state_id
  FROM hypermedia_bootstrap_allocations
  WHERE document_kind='diary_composer_state';

  IF guide_id IS NULL OR activity_instructions_id IS NULL
     OR activity_state_id IS NULL OR diary_instructions_id IS NULL
     OR diary_state_id IS NULL THEN
    RAISE EXCEPTION 'hypermedia bootstrap allocation set is incomplete'
      USING ERRCODE='55000';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM hypermedia_bootstrap_allocations allocation
    LEFT JOIN knowledge_pages page
      ON page.id=allocation.document_id
     AND page.current_version_id=allocation.revision_id
     AND page.archived_at IS NULL
    LEFT JOIN hypermedia_documents document
      ON document.id=allocation.document_id
     AND document.authority='knowledge'
     AND document.representation='markdown'
    LEFT JOIN knowledge_revision_contracts contract
      ON contract.document_id=allocation.document_id
     AND contract.revision_id=allocation.revision_id
     AND contract.link_contract='generic_document_v1'
    LEFT JOIN pathless_knowledge_search search
      ON search.document_id=allocation.document_id
     AND search.revision_id=allocation.revision_id
    WHERE page.id IS NULL OR document.id IS NULL
      OR contract.revision_id IS NULL OR search.document_id IS NULL
  ) THEN
    RAISE EXCEPTION 'hypermedia bootstrap documents are incomplete'
      USING ERRCODE='55000';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM knowledge_settings
    WHERE singleton AND global_guide_document_id=guide_id
  ) OR NOT EXISTS (
    SELECT 1 FROM automation_registry
    WHERE key='activity-distiller' AND disabled_at IS NULL
      AND instructions_document_id=activity_instructions_id
      AND state_document_id=activity_state_id
  ) OR NOT EXISTS (
    SELECT 1 FROM automation_registry
    WHERE key='diary-composer' AND disabled_at IS NULL
      AND instructions_document_id=diary_instructions_id
      AND state_document_id=diary_state_id
  ) OR NOT EXISTS (
    SELECT 1 FROM pathless_publication_settings
    WHERE singleton AND updated_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'hypermedia bootstrap operational settings are incomplete'
      USING ERRCODE='55000';
  END IF;

  PERFORM assert_hypermedia_cutover_ready();
  UPDATE hypermedia_bootstrap_allocations allocation
  SET completed_at=clock_timestamp()
  WHERE allocation.completed_at IS NULL;
  RETURN finalize_hypermedia_cutover();
END;
$$;

-- Allocated private document and revision UUIDs are unavailable to every
-- public, artifact and UUID-shaped alias namespace even before their rows are
-- materialized.
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

REVOKE ALL ON FUNCTION guard_hypermedia_bootstrap_allocations() FROM PUBLIC;
REVOKE ALL ON FUNCTION begin_hypermedia_bootstrap() FROM PUBLIC;
REVOKE ALL ON FUNCTION complete_hypermedia_bootstrap() FROM PUBLIC;

GRANT SELECT,INSERT,UPDATE ON hypermedia_bootstrap_allocations
  TO context_use_boundary_owner;
GRANT USAGE,CREATE ON SCHEMA public TO context_use_boundary_owner;
ALTER FUNCTION guard_hypermedia_bootstrap_allocations()
  OWNER TO context_use_boundary_owner;
ALTER FUNCTION begin_hypermedia_bootstrap()
  OWNER TO context_use_boundary_owner;
ALTER FUNCTION complete_hypermedia_bootstrap()
  OWNER TO context_use_boundary_owner;
REVOKE CREATE ON SCHEMA public FROM context_use_boundary_owner;

GRANT EXECUTE ON FUNCTION begin_hypermedia_bootstrap(),
  complete_hypermedia_bootstrap() TO context_use_corpus;
GRANT SELECT (document_kind,document_id,revision_id)
  ON hypermedia_bootstrap_allocations TO context_use_corpus;
GRANT SELECT ON hypermedia_bootstrap_allocations TO context_use_backup;
