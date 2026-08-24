-- Make the hypermedia schema read as the only model that ever
-- existed. Retain immutable public evidence and URL aliases, but remove
-- compatibility terminology and runtime mirroring.
SELECT pg_advisory_xact_lock(hashtextextended('context-use:knowledge-lifecycle',0));

DO $$
DECLARE legacy_entrypoint uuid; mapped_public_id uuid;
BEGIN
  SELECT entrypoint_page_id INTO legacy_entrypoint
  FROM public_knowledge_settings WHERE singleton;
  IF EXISTS (SELECT 1 FROM pathless_publication_settings
    WHERE singleton AND updated_at IS NULL) THEN
    IF legacy_entrypoint IS NOT NULL THEN
      SELECT public_id INTO mapped_public_id FROM public_resources
      WHERE original_document_id=legacy_entrypoint
        AND document_id=legacy_entrypoint AND resource_kind='page';
      IF mapped_public_id IS NULL THEN
        RAISE EXCEPTION 'canonical publication entrypoint mapping is incomplete'
          USING ERRCODE='55000';
      END IF;
    END IF;
    UPDATE pathless_publication_settings
    SET entrypoint_public_id=mapped_public_id,updated_at=now()
    WHERE singleton AND updated_at IS NULL;
  END IF;
END;
$$;

DROP FUNCTION seed_pathless_publication_entrypoint();
DROP FUNCTION adopt_generic_knowledge_revision(
  uuid,uuid,text,uuid[],knowledge_revision_contract_provenance
);
DROP TABLE public_knowledge_settings;
ALTER TYPE knowledge_revision_contract_provenance
  RENAME VALUE 'corpus_migration' TO 'imported';

ALTER TYPE public_artifact_allocation_kind RENAME VALUE 'legacy_page' TO 'retained_page';
ALTER TYPE public_artifact_allocation_kind RENAME VALUE 'pathless_intent' TO 'publication_intent';
ALTER TYPE public_artifact_allocation_kind RENAME VALUE 'pathless_adoption' TO 'retained_publication';
ALTER TYPE public_artifact_origin RENAME VALUE 'legacy_adoption' TO 'retained';
ALTER TYPE public_artifact_origin RENAME VALUE 'directory_hub_promotion' TO 'alias_hub';
ALTER TYPE pathless_publication_adoption_kind RENAME TO retained_public_artifact_kind;
ALTER TYPE retained_public_artifact_kind RENAME VALUE 'legacy_page' TO 'page';
ALTER TYPE retained_public_artifact_kind RENAME VALUE 'legacy_asset' TO 'asset';
ALTER TYPE retained_public_artifact_kind RENAME VALUE 'directory_hub' TO 'alias_hub';
DROP TYPE pathless_publication_adoption_phase;
ALTER TYPE pathless_public_route_state RENAME TO public_route_state;

ALTER TABLE published_page_artifacts RENAME TO retained_page_artifacts;
ALTER TABLE public_page_artifacts
  DROP CONSTRAINT public_page_artifacts_source_adoption_id_key;
ALTER TABLE public_asset_artifacts
  DROP CONSTRAINT public_asset_artifacts_source_adoption_id_key;
ALTER TABLE public_page_artifacts
  RENAME COLUMN source_adoption_id TO retained_source_id;
ALTER TABLE public_page_artifacts
  RENAME COLUMN source_adoption_kind TO retained_source_kind;
ALTER TABLE public_page_artifacts
  RENAME COLUMN legacy_source_artifact_id TO retained_source_artifact_id;
ALTER TABLE public_page_artifacts
  RENAME COLUMN legacy_projection_generation TO retained_projection_generation;
ALTER TABLE public_asset_artifacts
  RENAME COLUMN source_adoption_id TO retained_source_id;
ALTER TABLE public_asset_artifacts
  RENAME COLUMN source_adoption_kind TO retained_source_kind;
ALTER TABLE public_page_artifacts
  ADD CONSTRAINT public_page_artifacts_retained_source_id_key
  UNIQUE (retained_source_id);
ALTER TABLE public_asset_artifacts
  ADD CONSTRAINT public_asset_artifacts_retained_source_id_key
  UNIQUE (retained_source_id);

ALTER TABLE pathless_knowledge_search RENAME TO knowledge_search;
ALTER TABLE pathless_knowledge_search_chunks RENAME TO knowledge_search_chunks;
ALTER TABLE pathless_publication_artifact_staging RENAME TO publication_artifact_staging;
ALTER TABLE pathless_publication_intents RENAME TO publication_intents;
ALTER TABLE pathless_publication_object_claims RENAME TO publication_object_claims;
ALTER TABLE pathless_publication_settings RENAME TO publication_settings;
ALTER VIEW pathless_public_pages RENAME TO public_pages;
ALTER VIEW pathless_public_assets RENAME TO public_assets;
ALTER VIEW private_document_catalog
  RENAME COLUMN pathless_search_ready TO search_ready;

ALTER ROLE context_use_pathless_storage_owner RENAME TO context_use_storage_owner;

DO $rename_routines$
DECLARE routine record; renamed text;
BEGIN
  FOR routine IN
    SELECT p.oid,p.proname
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname LIKE '%pathless%'
    ORDER BY p.oid
  LOOP
    renamed := replace(replace(replace(replace(replace(replace(
      routine.proname,
      'pathless_publication_','publication_'),
      'pathless_knowledge_','knowledge_'),
      'pathless_document_','document_'),
      'pathless_public_','public_'),
      'pathless_storage_','storage_'),
      'pathless_','');
    EXECUTE format('ALTER FUNCTION %s RENAME TO %I',routine.oid::regprocedure,renamed);
  END LOOP;
END;
$rename_routines$;

ALTER FUNCTION reserve_legacy_page_artifact_identity()
  RENAME TO reserve_retained_page_artifact_identity;

DO $rewrite_routines$
DECLARE routine regprocedure; definition text;
BEGIN
  FOR routine IN
    SELECT p.oid::regprocedure
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.prokind='f'
      AND p.proname<>'set_publication_entrypoint'
      AND (
        pg_get_functiondef(p.oid) ILIKE '%pathless%'
        OR pg_get_functiondef(p.oid) ILIKE '%source_adoption%'
        OR pg_get_functiondef(p.oid) ILIKE '%legacy_source_artifact%'
        OR pg_get_functiondef(p.oid) ILIKE '%legacy_projection_generation%'
        OR pg_get_functiondef(p.oid) ILIKE '%published_page_artifacts%'
        OR pg_get_functiondef(p.oid) ILIKE '%legacy public artifact%'
        OR pg_get_functiondef(p.oid) ILIKE '%legacy_page%'
        OR pg_get_functiondef(p.oid) ILIKE '%legacy_adoption%'
        OR pg_get_functiondef(p.oid) ILIKE '%directory_hub_promotion%'
        OR pg_get_functiondef(p.oid) ILIKE '%corpus_migration%'
      )
    ORDER BY p.oid
  LOOP
    SELECT pg_get_functiondef(routine) INTO definition;
    definition := replace(definition,'pathless_publication_adoption_kind',
      'retained_public_artifact_kind');
    definition := replace(definition,'pathless_intent','publication_intent');
    definition := replace(definition,'pathless_adoption','retained_publication');
    definition := replace(definition,'pathless_publication_','publication_');
    definition := replace(definition,'pathless_knowledge_','knowledge_');
    definition := replace(definition,'pathless_document_','document_');
    definition := replace(definition,'pathless_public_','public_');
    definition := replace(definition,'pathless_storage_','storage_');
    definition := replace(definition,'pathless_exists','publication_exists');
    definition := replace(definition,'pathless','canonical');
    definition := replace(definition,'source_adoption_id','retained_source_id');
    definition := replace(definition,'source_adoption_kind','retained_source_kind');
    definition := replace(definition,'legacy_source_artifact_id','retained_source_artifact_id');
    definition := replace(definition,'legacy_projection_generation','retained_projection_generation');
    definition := replace(definition,'published_page_artifacts','retained_page_artifacts');
    definition := replace(definition,'''legacy_page''','''retained_page''');
    definition := replace(definition,'''legacy_adoption''','''retained''');
    definition := replace(definition,'''directory_hub_promotion''','''alias_hub''');
    definition := replace(definition,'''corpus_migration''','''imported''');
    definition := replace(definition,'legacy public artifact','retained public artifact');
    EXECUTE definition;
  END LOOP;
END;
$rewrite_routines$;

CREATE OR REPLACE FUNCTION set_publication_entrypoint(p_public_id uuid)
RETURNS TABLE(public_id uuid,configured boolean,active boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE
  stored_public_id uuid;
  stored_updated_at timestamptz;
  selected_document_id uuid;
  selected_artifact_id uuid;
BEGIN
  PERFORM pg_advisory_xact_lock_shared(
    hashtextextended('context-use:knowledge-lifecycle',0)
  );
  SELECT settings.entrypoint_public_id,settings.updated_at
  INTO stored_public_id,stored_updated_at
  FROM publication_settings settings WHERE settings.singleton;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'publication settings are missing' USING ERRCODE='P0002';
  END IF;
  IF stored_updated_at IS NOT NULL
     AND stored_public_id IS NOT DISTINCT FROM p_public_id THEN
    SELECT settings.entrypoint_public_id,settings.updated_at
    INTO stored_public_id,stored_updated_at
    FROM publication_settings settings WHERE settings.singleton FOR UPDATE;
    IF stored_updated_at IS NOT NULL
       AND stored_public_id IS NOT DISTINCT FROM p_public_id THEN
      RETURN QUERY SELECT * FROM get_publication_entrypoint();
      RETURN;
    END IF;
    RAISE EXCEPTION 'entrypoint changed while replaying setter'
      USING ERRCODE='40001';
  END IF;
  IF p_public_id IS NOT NULL THEN
    SELECT resource.document_id INTO selected_document_id
    FROM public_resources resource
    WHERE resource.public_id=p_public_id
      AND resource.original_document_id=resource.document_id
      AND resource.resource_kind='page';
    IF NOT FOUND OR selected_document_id IS NULL THEN
      RAISE EXCEPTION 'entrypoint must be an exact active page'
        USING ERRCODE='23514';
    END IF;
    PERFORM lock_operational_document(selected_document_id);
    SELECT artifact.artifact_id
    INTO selected_artifact_id
    FROM public_resources resource
    JOIN knowledge_pages page
      ON page.id=resource.document_id AND page.archived_at IS NULL
    JOIN page_publications publication ON publication.public_id=resource.public_id
    JOIN public_page_artifacts artifact
      ON artifact.public_id=publication.public_id
     AND artifact.artifact_id=publication.artifact_id
    WHERE resource.public_id=p_public_id
      AND resource.original_document_id=resource.document_id
      AND resource.resource_kind='page'
      AND NOT EXISTS (
        SELECT 1 FROM blocking_public_namespace_conflicts conflict
        WHERE conflict.namespace_uuid IN (artifact.public_id,artifact.artifact_id)
           OR conflict.public_id=artifact.public_id
      )
    FOR SHARE OF resource,page,publication;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'entrypoint must be an exact active page'
        USING ERRCODE='23514';
    END IF;
  END IF;
  SELECT settings.entrypoint_public_id,settings.updated_at
  INTO stored_public_id,stored_updated_at
  FROM publication_settings settings WHERE settings.singleton FOR UPDATE;
  IF stored_updated_at IS NOT NULL
     AND stored_public_id IS NOT DISTINCT FROM p_public_id THEN
    RETURN QUERY SELECT * FROM get_publication_entrypoint();
    RETURN;
  END IF;
  IF p_public_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM blocking_public_namespace_conflicts conflict
    WHERE conflict.namespace_uuid IN (p_public_id,selected_artifact_id)
       OR conflict.public_id=p_public_id
  ) THEN
    RAISE EXCEPTION 'entrypoint candidate acquired a namespace conflict'
      USING ERRCODE='40001';
  END IF;
  UPDATE publication_settings settings
  SET entrypoint_public_id=p_public_id,updated_at=now()
  WHERE settings.singleton;
  RETURN QUERY SELECT * FROM get_publication_entrypoint();
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
    LEFT JOIN knowledge_search search
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
  ) THEN
    RAISE EXCEPTION 'hypermedia bootstrap operational settings are incomplete'
      USING ERRCODE='55000';
  END IF;

  UPDATE publication_settings
  SET updated_at=clock_timestamp()
  WHERE singleton AND updated_at IS NULL;
  IF NOT EXISTS (
    SELECT 1 FROM publication_settings
    WHERE singleton AND updated_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'hypermedia bootstrap publication settings are incomplete'
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

DO $rename_catalog$
DECLARE item record; renamed text;
BEGIN
  FOR item IN
    SELECT con.conrelid AS relation_id,con.conname AS name
    FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND (
      con.conname ILIKE '%pathless%' OR con.conname ILIKE '%published_page%'
      OR con.conname ILIKE '%source_adoption%'
      OR con.conname ILIKE '%legacy_source%'
      OR con.conname ILIKE '%legacy_projection%'
    ) ORDER BY con.oid
  LOOP
    renamed := replace(replace(replace(replace(replace(item.name,
      'pathless_',''),'published_page','retained_page'),
      'source_adoption','retained_source'),
      'legacy_source','retained_source'),
      'legacy_projection','retained_projection');
    EXECUTE format('ALTER TABLE %s RENAME CONSTRAINT %I TO %I',
      item.relation_id::regclass,item.name,renamed);
  END LOOP;

  FOR item IN
    SELECT t.tgrelid AS relation_id,t.tgname AS name
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND NOT t.tgisinternal AND (
      t.tgname ILIKE '%pathless%' OR t.tgname ILIKE '%published_page%'
      OR t.tgname ILIKE '%legacy_page%'
    ) ORDER BY t.oid
  LOOP
    renamed := replace(replace(replace(item.name,
      'pathless_',''),'published_page','retained_page'),
      'legacy_page','retained_page');
    EXECUTE format('ALTER TRIGGER %I ON %s RENAME TO %I',
      item.name,item.relation_id::regclass,renamed);
  END LOOP;

  FOR item IN
    SELECT c.oid AS relation_id,c.relname AS name
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    LEFT JOIN pg_constraint con ON con.conindid=c.oid
    WHERE n.nspname='public' AND c.relkind='i' AND con.oid IS NULL AND (
      c.relname ILIKE '%pathless%' OR c.relname ILIKE '%published_page%'
      OR c.relname ILIKE '%source_adoption%'
      OR c.relname ILIKE '%legacy_source%'
      OR c.relname ILIKE '%legacy_projection%'
    ) ORDER BY c.oid
  LOOP
    renamed := replace(replace(replace(replace(replace(item.name,
      'pathless_',''),'published_page','retained_page'),
      'source_adoption','retained_source'),
      'legacy_source','retained_source'),
      'legacy_projection','retained_projection');
    EXECUTE format('ALTER INDEX %s RENAME TO %I',item.relation_id::regclass,renamed);
  END LOOP;
END;
$rename_catalog$;

DO $audit$
DECLARE residual text;
BEGIN
  SELECT string_agg(kind||':'||name,', ' ORDER BY kind,name) INTO residual FROM (
    SELECT 'relation' AS kind,c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public'
    UNION ALL SELECT 'routine',p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public'
    UNION ALL SELECT 'type',t.typname FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
      WHERE n.nspname='public'
    UNION ALL SELECT 'column',a.attname FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND a.attnum>0 AND NOT a.attisdropped
    UNION ALL SELECT 'constraint',con.conname FROM pg_constraint con
      JOIN pg_class c ON c.oid=con.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public'
    UNION ALL SELECT 'trigger',t.tgname FROM pg_trigger t
      JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND NOT t.tgisinternal
  ) catalog WHERE name ILIKE '%pathless%'
    OR name ILIKE '%adoption%' OR name ILIKE '%legacy_source%'
    OR name ILIKE '%legacy_projection%' OR name ILIKE '%published_page_artifact%';
  IF residual IS NOT NULL THEN
    RAISE EXCEPTION 'canonical naming left compatibility catalog names: %',residual
      USING ERRCODE='55000';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.prokind='f' AND (
      pg_get_functiondef(p.oid) ILIKE '%pathless%'
      OR pg_get_functiondef(p.oid) ILIKE '%adoption%'
      OR pg_get_functiondef(p.oid) ILIKE '%corpus_migration%'
      OR pg_get_functiondef(p.oid) ILIKE '%public_knowledge_settings%'
    )
  ) OR EXISTS (
    SELECT 1 FROM pg_type t JOIN pg_enum e ON e.enumtypid=t.oid
    JOIN pg_namespace n ON n.oid=t.typnamespace
    WHERE n.nspname='public' AND (
      e.enumlabel ILIKE '%pathless%' OR e.enumlabel ILIKE '%adopt%'
      OR e.enumlabel ILIKE '%legacy%'
    )
  ) OR EXISTS (SELECT 1 FROM pg_roles WHERE rolname ILIKE '%pathless%') THEN
    RAISE EXCEPTION 'canonical naming left compatibility definitions or roles'
      USING ERRCODE='55000';
  END IF;
  IF to_regclass('public.public_knowledge_settings') IS NOT NULL
     OR to_regprocedure(
       'public.adopt_generic_knowledge_revision(uuid,uuid,text,uuid[],knowledge_revision_contract_provenance)'
     ) IS NOT NULL
     OR to_regprocedure('public.seed_publication_entrypoint()') IS NOT NULL THEN
    RAISE EXCEPTION 'canonical naming left compatibility runtime objects'
      USING ERRCODE='55000';
  END IF;
END;
$audit$;
