-- Existing installations may retire the v0.1.82 cutover receipt only after it
-- proves that cutover completed. A database with no retained knowledge is a
-- pristine install and continues through the ordinary bootstrap boundary.

SELECT pg_advisory_xact_lock(
  hashtextextended('filesystem-hypermedia-corpus-transition',0)
);

DO $$
DECLARE cutover_finalized_at timestamptz;
BEGIN
  SELECT finalized_at INTO cutover_finalized_at
  FROM hypermedia_cutover_state WHERE singleton FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'hypermedia cutover state is missing' USING ERRCODE='55000';
  END IF;
  IF cutover_finalized_at IS NULL AND (
    EXISTS (SELECT 1 FROM hypermedia_bootstrap_allocations)
    OR EXISTS (SELECT 1 FROM hypermedia_documents)
    OR EXISTS (SELECT 1 FROM knowledge_pages)
    OR EXISTS (SELECT 1 FROM assets)
    OR EXISTS (SELECT 1 FROM automation_registry)
    OR EXISTS (SELECT 1 FROM public_resources)
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

-- Bootstrap allocations now own bootstrap lifecycle. This lock is scoped only
-- to concurrent bootstrap calls; ordinary knowledge writes no longer
-- participate in a retired migration transition.
CREATE OR REPLACE FUNCTION begin_hypermedia_bootstrap()
RETURNS TABLE(document_kind text,document_id uuid,revision_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('context-use:hypermedia-bootstrap',0)
  );
  IF EXISTS (
    SELECT 1 FROM hypermedia_bootstrap_allocations
    WHERE completed_at IS NOT NULL
  ) THEN
    IF (SELECT count(*) FROM hypermedia_bootstrap_allocations)<>5
       OR EXISTS (
         SELECT 1 FROM hypermedia_bootstrap_allocations
         WHERE completed_at IS NULL
       ) THEN
      RAISE EXCEPTION 'hypermedia bootstrap allocation state is inconsistent'
        USING ERRCODE='55000';
    END IF;
    RETURN;
  END IF;
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
      RAISE EXCEPTION 'hypermedia bootstrap requires an empty installation'
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

CREATE OR REPLACE FUNCTION complete_hypermedia_bootstrap()
RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
SET jit=off
AS $$
DECLARE
  bootstrap_completed_at timestamptz;
  guide_id uuid;
  activity_instructions_id uuid;
  activity_state_id uuid;
  diary_instructions_id uuid;
  diary_state_id uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('context-use:hypermedia-bootstrap',0)
  );
  IF (SELECT count(*) FROM hypermedia_bootstrap_allocations)<>5 THEN
    RAISE EXCEPTION 'hypermedia bootstrap allocation set is incomplete'
      USING ERRCODE='55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM hypermedia_bootstrap_allocations
    WHERE completed_at IS NULL
  ) THEN
    SELECT max(completed_at) INTO bootstrap_completed_at
    FROM hypermedia_bootstrap_allocations;
    RETURN bootstrap_completed_at;
  END IF;
  IF EXISTS (
    SELECT 1 FROM hypermedia_bootstrap_allocations
    WHERE completed_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'hypermedia bootstrap allocation state is inconsistent'
      USING ERRCODE='55000';
  END IF;

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
    SELECT 1 FROM hypermedia_bootstrap_allocations allocation
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

  UPDATE hypermedia_bootstrap_allocations
  SET completed_at=clock_timestamp()
  WHERE completed_at IS NULL;
  SELECT max(completed_at) INTO bootstrap_completed_at
  FROM hypermedia_bootstrap_allocations;
  RETURN bootstrap_completed_at;
END;
$$;

REVOKE ALL ON FUNCTION begin_hypermedia_bootstrap() FROM PUBLIC;
REVOKE ALL ON FUNCTION complete_hypermedia_bootstrap() FROM PUBLIC;
ALTER FUNCTION begin_hypermedia_bootstrap()
  OWNER TO context_use_boundary_owner;
ALTER FUNCTION complete_hypermedia_bootstrap()
  OWNER TO context_use_boundary_owner;
GRANT EXECUTE ON FUNCTION begin_hypermedia_bootstrap(),
  complete_hypermedia_bootstrap() TO context_use_corpus;

DROP FUNCTION finalize_hypermedia_cutover();
DROP FUNCTION assert_hypermedia_cutover_ready();
DROP FUNCTION list_hypermedia_cutover_blockers();
DROP TABLE hypermedia_cutover_state;
DROP FUNCTION guard_hypermedia_cutover_state();
