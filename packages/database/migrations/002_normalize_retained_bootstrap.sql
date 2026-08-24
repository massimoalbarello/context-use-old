-- Normalize the one retained installation whose operational bootstrap documents
-- were complete before allocation rows became part of the canonical contract.
-- This migration is intentionally data-only: the rescued documents and their
-- object-backed revisions are immutable inputs, not migration-owned artifacts.

DO $normalize_retained_bootstrap$
DECLARE
  expected_kinds constant text[] := ARRAY[
    'global_guide',
    'activity_distiller_instructions',
    'activity_distiller_state',
    'diary_composer_instructions',
    'diary_composer_state'
  ]::text[];
  operational_evidence boolean;
  normalized_at timestamptz;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('context-use:hypermedia-bootstrap',0)
  );

  SELECT
    settings.global_guide_document_id IS NOT NULL
    OR EXISTS (
      SELECT 1 FROM automation_registry
      WHERE key IN ('activity-distiller','diary-composer')
    )
    OR EXISTS (
      SELECT 1 FROM publication_settings
      WHERE singleton AND updated_at IS NOT NULL
    )
  INTO operational_evidence
  FROM knowledge_settings settings
  WHERE settings.singleton;

  IF operational_evidence IS NULL THEN
    RAISE EXCEPTION 'retained hypermedia bootstrap knowledge settings are missing'
      USING ERRCODE='55000';
  END IF;

  -- A pristine baseline has no operational evidence and no allocations. Leave
  -- it for the ordinary bootstrap command.
  IF NOT operational_evidence
     AND NOT EXISTS (SELECT 1 FROM hypermedia_bootstrap_allocations) THEN
    RETURN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM hypermedia_bootstrap_allocations) THEN
    IF NOT EXISTS (
      SELECT 1 FROM knowledge_settings
      WHERE singleton AND global_guide_document_id IS NOT NULL
    ) OR NOT EXISTS (
      SELECT 1 FROM automation_registry
      WHERE key='activity-distiller' AND disabled_at IS NULL
        AND state_document_id IS NOT NULL
    ) OR NOT EXISTS (
      SELECT 1 FROM automation_registry
      WHERE key='diary-composer' AND disabled_at IS NULL
        AND state_document_id IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'retained hypermedia bootstrap operational state is partial'
        USING ERRCODE='55000';
    END IF;

    normalized_at := clock_timestamp();
    INSERT INTO hypermedia_bootstrap_allocations(
      document_kind,document_id,revision_id,allocated_at,completed_at
    )
    SELECT role.document_kind,role.document_id,page.current_version_id,
      normalized_at,normalized_at
    FROM (
      SELECT 'global_guide'::text AS document_kind,
        settings.global_guide_document_id AS document_id
      FROM knowledge_settings settings WHERE settings.singleton
      UNION ALL
      SELECT 'activity_distiller_instructions',registry.instructions_document_id
      FROM automation_registry registry
      WHERE registry.key='activity-distiller' AND registry.disabled_at IS NULL
      UNION ALL
      SELECT 'activity_distiller_state',registry.state_document_id
      FROM automation_registry registry
      WHERE registry.key='activity-distiller' AND registry.disabled_at IS NULL
      UNION ALL
      SELECT 'diary_composer_instructions',registry.instructions_document_id
      FROM automation_registry registry
      WHERE registry.key='diary-composer' AND registry.disabled_at IS NULL
      UNION ALL
      SELECT 'diary_composer_state',registry.state_document_id
      FROM automation_registry registry
      WHERE registry.key='diary-composer' AND registry.disabled_at IS NULL
    ) role
    JOIN knowledge_pages page ON page.id=role.document_id;
  END IF;

  IF (SELECT count(*) FROM hypermedia_bootstrap_allocations)<>5
     OR EXISTS (
       SELECT expected.document_kind
       FROM unnest(expected_kinds) expected(document_kind)
       WHERE NOT EXISTS (
         SELECT 1 FROM hypermedia_bootstrap_allocations allocation
         WHERE allocation.document_kind=expected.document_kind
       )
     )
     OR EXISTS (
       SELECT 1 FROM hypermedia_bootstrap_allocations
       WHERE completed_at IS NULL
     )
     OR (SELECT count(DISTINCT document_id) FROM hypermedia_bootstrap_allocations)<>5
     OR (SELECT count(DISTINCT revision_id) FROM hypermedia_bootstrap_allocations)<>5 THEN
    RAISE EXCEPTION 'retained hypermedia bootstrap allocation state is inconsistent'
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
    LEFT JOIN hypermedia_document_revisions revision
      ON revision.id=allocation.revision_id
     AND revision.document_id=allocation.document_id
    LEFT JOIN knowledge_page_versions version
      ON version.id=allocation.revision_id
     AND version.page_id=allocation.document_id
    LEFT JOIN knowledge_revision_contracts contract
      ON contract.document_id=allocation.document_id
     AND contract.revision_id=allocation.revision_id
     AND contract.link_contract='generic_document_v1'
     AND contract.body_content_hash=revision.body_content_hash
    LEFT JOIN knowledge_search search
      ON search.document_id=allocation.document_id
     AND search.revision_id=allocation.revision_id
    WHERE page.id IS NULL OR document.id IS NULL OR revision.id IS NULL
      OR version.id IS NULL OR contract.revision_id IS NULL
      OR search.document_id IS NULL
  ) THEN
    RAISE EXCEPTION 'retained hypermedia bootstrap documents are incomplete or conflicting'
      USING ERRCODE='55000';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM hypermedia_bootstrap_allocations allocation
    JOIN knowledge_settings settings
      ON settings.singleton
     AND settings.global_guide_document_id=allocation.document_id
    WHERE allocation.document_kind='global_guide'
  ) OR NOT EXISTS (
    SELECT 1
    FROM automation_registry registry
    JOIN hypermedia_bootstrap_allocations instructions
      ON instructions.document_kind='activity_distiller_instructions'
     AND instructions.document_id=registry.instructions_document_id
    JOIN hypermedia_bootstrap_allocations state
      ON state.document_kind='activity_distiller_state'
     AND state.document_id=registry.state_document_id
    WHERE registry.key='activity-distiller' AND registry.disabled_at IS NULL
  ) OR NOT EXISTS (
    SELECT 1
    FROM automation_registry registry
    JOIN hypermedia_bootstrap_allocations instructions
      ON instructions.document_kind='diary_composer_instructions'
     AND instructions.document_id=registry.instructions_document_id
    JOIN hypermedia_bootstrap_allocations state
      ON state.document_kind='diary_composer_state'
     AND state.document_id=registry.state_document_id
    WHERE registry.key='diary-composer' AND registry.disabled_at IS NULL
  ) THEN
    RAISE EXCEPTION 'retained hypermedia bootstrap operational state conflicts with allocations'
      USING ERRCODE='55000';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM publication_settings
    WHERE singleton AND updated_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'retained hypermedia bootstrap publication settings are not latched'
      USING ERRCODE='55000';
  END IF;
END;
$normalize_retained_bootstrap$;
