-- v0.1.84 is the rollback boundary. Preserve canonical documents, immutable
-- publication artifacts, and public aliases; remove directory/path metadata.
SELECT pg_advisory_xact_lock(hashtextextended('context-use:remove-filesystem-schema',0));

DO $$
DECLARE missing bigint;
BEGIN
  SELECT count(*) INTO missing
  FROM knowledge_directories directory
  LEFT JOIN hypermedia_documents document
    ON document.id=directory.id AND document.authority='knowledge'
   AND document.representation='markdown'
  LEFT JOIN knowledge_pages page ON page.id=directory.id
  WHERE (document.id IS NULL OR page.id IS NULL)
    AND NOT (
      directory.current_path IN ('','automations','skills')
      AND NOT EXISTS (
        SELECT 1 FROM knowledge_pages child
        WHERE child.current_path=directory.current_path
           OR child.current_path LIKE CASE WHEN directory.current_path=''
             THEN '%' ELSE directory.current_path||'/%' END
      )
      AND NOT EXISTS (
        SELECT 1 FROM assets child
        WHERE child.current_path=directory.current_path
           OR child.current_path LIKE CASE WHEN directory.current_path=''
             THEN '%' ELSE directory.current_path||'/%' END
      )
    );
  IF missing<>0 THEN RAISE EXCEPTION
    'filesystem schema removal blocked: % directories lack canonical hypermedia documents',missing
    USING ERRCODE='55000'; END IF;

  SELECT count(*) INTO missing
  FROM legacy_public_directory_prefixes prefix
  LEFT JOIN public_resources resource
    ON resource.public_id=prefix.directory_id
   AND resource.original_document_id=prefix.directory_id
   AND resource.resource_kind='page'
  LEFT JOIN public_route_aliases alias
    ON alias.alias_path=CASE WHEN prefix.legacy_path=''
      THEN '/p/' ELSE '/p/'||prefix.legacy_path||'/' END
   AND alias.route_kind='directory' AND alias.public_id=prefix.directory_id
  WHERE resource.public_id IS NULL OR alias.alias_path IS NULL OR NOT EXISTS (
    SELECT 1 FROM public_page_artifacts artifact
    WHERE artifact.public_id=prefix.directory_id
      AND artifact.source_document_id=prefix.directory_id
  );
  IF missing<>0 THEN RAISE EXCEPTION
    'filesystem schema removal blocked: % public directories lack immutable publication evidence',missing
    USING ERRCODE='55000'; END IF;

  SELECT count(*) INTO missing
  FROM knowledge_pages page
  LEFT JOIN public_resources resource
    ON resource.original_document_id=page.id AND resource.resource_kind='page'
  WHERE page.public_path IS NOT NULL AND (
    resource.public_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM public_page_artifacts artifact
      WHERE artifact.public_id=resource.public_id
        AND artifact.source_document_id=page.id
        AND (page.published_version_id IS NULL
          OR artifact.source_revision_id=page.published_version_id)
    ) OR NOT EXISTS (
      SELECT 1 FROM public_route_aliases alias
      WHERE alias.alias_path='/p/'||page.public_path
        AND alias.route_kind='page' AND alias.public_id=resource.public_id
    ) OR NOT EXISTS (
      SELECT 1 FROM public_route_aliases alias
      WHERE alias.alias_path='/p/'||page.public_path||'.md'
        AND alias.route_kind='markdown' AND alias.public_id=resource.public_id
    )
  );
  IF missing<>0 THEN RAISE EXCEPTION
    'filesystem schema removal blocked: % public pages lack immutable publication evidence',missing
    USING ERRCODE='55000'; END IF;

  SELECT count(*) INTO missing
  FROM assets asset
  LEFT JOIN public_resources resource
    ON resource.original_document_id=asset.id AND resource.resource_kind='asset'
  WHERE asset.public_path IS NOT NULL AND (
    resource.public_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM public_asset_artifacts artifact
      WHERE artifact.public_id=resource.public_id
        AND artifact.source_document_id=asset.id
    ) OR NOT EXISTS (
      SELECT 1 FROM public_route_aliases alias
      WHERE alias.alias_path='/a/'||asset.public_path
        AND alias.route_kind='asset' AND alias.public_id=resource.public_id
    )
  );
  IF missing<>0 THEN RAISE EXCEPTION
    'filesystem schema removal blocked: % public assets lack immutable publication evidence',missing
    USING ERRCODE='55000'; END IF;
END;
$$;

-- Publication intents are short-lived authorization state. The old table can
-- contain no canonical documents or immutable artifacts, so retire it and
-- collapse UUID reservations to the sole remaining intent store.
DROP TRIGGER publication_intent_ids_029_keep_immutable
  ON publication_intent_id_reservations;
DELETE FROM publication_intent_id_reservations WHERE intent_store='legacy';
ALTER TABLE publication_intent_id_reservations
  DROP CONSTRAINT publication_intent_id_reservations_intent_id_intent_store_key,
  DROP COLUMN intent_store;
CREATE TRIGGER publication_intent_ids_029_keep_immutable
BEFORE UPDATE OR DELETE ON publication_intent_id_reservations
FOR EACH ROW EXECUTE FUNCTION guard_publication_intent_id_reservation();

DROP TABLE publication_intents;

DROP FUNCTION reserve_publication_intent_id(uuid,publication_intent_store);
CREATE FUNCTION reserve_publication_intent_id(p_intent_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF p_intent_id IS NULL THEN
    RAISE EXCEPTION 'publication intent identity is required' USING ERRCODE='22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'publication-intent-uuid:'||p_intent_id::text,0
  ));
  IF EXISTS (SELECT 1 FROM publication_intent_id_reservations
    WHERE intent_id=p_intent_id) THEN
    IF NOT EXISTS (SELECT 1 FROM pathless_publication_intents
      WHERE id=p_intent_id) THEN
      RAISE EXCEPTION 'publication intent UUID cannot be reused'
        USING ERRCODE='23505';
    END IF;
    RETURN;
  END IF;
  INSERT INTO publication_intent_id_reservations(intent_id) VALUES (p_intent_id);
END;
$$;
REVOKE ALL ON FUNCTION reserve_publication_intent_id(uuid) FROM PUBLIC;
ALTER FUNCTION reserve_publication_intent_id(uuid)
  OWNER TO context_use_boundary_owner;

CREATE OR REPLACE FUNCTION reserve_publication_intent_id_from_row()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  PERFORM reserve_publication_intent_id(NEW.id);
  RETURN NEW;
END;
$$;

DROP VIEW private_document_catalog;
DROP VIEW live_public_namespace_conflicts;
DROP VIEW published_route_aliases;
DROP VIEW published_public_resources;
DROP VIEW published_page_sources;

DROP TRIGGER knowledge_pages_current_version_path ON knowledge_pages;
DROP TRIGGER knowledge_pages_path_collision ON knowledge_pages;
DROP TRIGGER knowledge_pages_keep_root_guide ON knowledge_pages;
DROP TRIGGER knowledge_pages_prevent_root_guide_deletion ON knowledge_pages;
DROP TRIGGER knowledge_pages_register_bootstrap_global_guide ON knowledge_pages;
DROP TRIGGER knowledge_pages_keep_operational_documents_private ON knowledge_pages;
DROP TRIGGER knowledge_pages_validate_published_directory_ancestors ON knowledge_pages;
DROP TRIGGER knowledge_pages_register_public_routes ON knowledge_pages;
DROP TRIGGER knowledge_pages_advance_public_projection ON knowledge_pages;
DROP TRIGGER knowledge_pages_028_invalidate_publication_on_legacy_drift ON knowledge_pages;
DROP TRIGGER knowledge_pages_zz029_bump_public_visibility ON knowledge_pages;
DROP TRIGGER knowledge_pages_zz029_bump_publication_target ON knowledge_pages;
DROP TRIGGER knowledge_pages_lock_settings_before_guide_update ON knowledge_pages;
DROP TRIGGER knowledge_pages_protect_configured_global_guide_update ON knowledge_pages;
DROP TRIGGER knowledge_pages_protect_registered_automation_update ON knowledge_pages;
DROP TRIGGER assets_serialize_directory_deletion ON assets;
DROP TRIGGER assets_register_public_routes ON assets;
DROP TRIGGER assets_advance_public_projection ON assets;
DROP TRIGGER assets_028_invalidate_publication_on_legacy_drift ON assets;
DROP TRIGGER assets_zz029_bump_public_visibility ON assets;
DROP TRIGGER assets_zz029_bump_publication_target ON assets;

ALTER TABLE knowledge_pages DROP COLUMN parent_path;
DROP TABLE knowledge_directories;
DROP TABLE legacy_public_directory_prefixes;
ALTER TABLE knowledge_pages DROP COLUMN current_path,
  DROP COLUMN published_version_id,DROP COLUMN public_path;
ALTER TABLE knowledge_page_versions DROP COLUMN path;
ALTER TABLE knowledge_page_changes DROP COLUMN path;
ALTER TABLE assets DROP COLUMN current_path,DROP COLUMN public_path;
DROP TABLE public_projection_state;

DROP FUNCTION directory_search_vector(text,text,text,text);
DROP FUNCTION prevent_knowledge_path_collision();
DROP FUNCTION delete_empty_knowledge_directory(uuid,integer);
DROP FUNCTION serialize_asset_directory_changes();
DROP FUNCTION enforce_current_page_version_path();
DROP FUNCTION protect_root_knowledge_guide();
DROP FUNCTION register_bootstrap_global_knowledge_guide();
DROP FUNCTION prevent_synthetic_public_prefix_collision();
DROP FUNCTION validate_published_page_directory_ancestors();
DROP FUNCTION protect_published_page_directory_ancestors();
DROP FUNCTION register_published_page_routes();
DROP FUNCTION register_published_asset_routes();
DROP FUNCTION advance_public_projection_generation();
DROP FUNCTION bump_legacy_page_public_visibility();
DROP FUNCTION bump_legacy_asset_public_visibility();
DROP FUNCTION invalidate_pathless_page_publication_on_legacy_drift();
DROP FUNCTION invalidate_pathless_asset_publication_on_legacy_drift();
DROP FUNCTION prevent_operational_document_publication();
DROP FUNCTION project_public_markdown(text);

CREATE OR REPLACE FUNCTION pathless_publication_source_fingerprint(
  p_target_kind publication_target,p_target_document_id uuid,p_expected_revision_id uuid
)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public SET timezone='UTC' AS $$
DECLARE source_snapshot jsonb;
BEGIN
  IF p_target_kind='page' THEN
    SELECT jsonb_build_object(
      'target_kind','page','document_id',page.id,
      'document_authority',document.authority,
      'document_representation',document.representation,
      'current_revision_id',page.current_version_id,'archived_at',page.archived_at,
      'revision_id',revision.id,'revision_number',revision.revision_number,
      'source_body_object_key',revision.body_object_key,
      'source_body_size_bytes',revision.body_size_bytes,
      'source_body_content_hash',revision.body_content_hash,
      'title',version.title,'summary',version.summary,
      'last_edited_at',version.created_at,'link_contract',contract.link_contract,
      'contract_provenance',contract.provenance,
      'contract_body_content_hash',contract.body_content_hash,
      'target_document_ids',contract.target_document_ids
    ) INTO source_snapshot
    FROM knowledge_pages page
    JOIN hypermedia_documents document ON document.id=page.id
    JOIN hypermedia_document_revisions revision
      ON revision.id=p_expected_revision_id AND revision.document_id=page.id
    JOIN knowledge_page_versions version
      ON version.id=revision.id AND version.page_id=page.id
    JOIN knowledge_revision_contracts contract
      ON contract.revision_id=revision.id AND contract.document_id=page.id
    WHERE page.id=p_target_document_id;
  ELSIF p_target_kind='asset' THEN
    IF p_expected_revision_id IS NOT NULL THEN RETURN NULL; END IF;
    SELECT jsonb_build_object(
      'target_kind','asset','document_id',asset.id,'filename',asset.filename,
      'content_type',asset.content_type,'size_bytes',asset.size_bytes,
      'content_hash',asset.content_hash,'source_body_object_key',asset.s3_object_key,
      'width',asset.width,'height',asset.height,
      'duration_seconds',asset.duration_seconds,'created_at',asset.created_at,
      'deleted_at',asset.deleted_at
    ) INTO source_snapshot FROM assets asset WHERE asset.id=p_target_document_id;
  END IF;
  IF source_snapshot IS NULL THEN RETURN NULL; END IF;
  RETURN encode(digest(convert_to(source_snapshot::text,'UTF8'),'sha256'),'hex');
END;
$$;

CREATE OR REPLACE FUNCTION pathless_publication_visibility_state_hash(
  p_target_kind publication_target,p_target_document_id uuid,p_public_id uuid
)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT encode(digest(convert_to(jsonb_build_object(
    'target_kind',p_target_kind,'target_document_id',p_target_document_id,
    'public_id',p_public_id,'resource',(
      SELECT jsonb_build_object('public_id',resource.public_id,
        'document_id',resource.document_id,
        'original_document_id',resource.original_document_id,
        'resource_kind',resource.resource_kind)
      FROM public_resources resource WHERE resource.public_id=p_public_id
    ),'publication_artifact',CASE
      WHEN p_target_kind='page' THEN (SELECT publication.artifact_id
        FROM page_publications publication WHERE publication.public_id=p_public_id)
      WHEN p_target_kind='asset' THEN (SELECT publication.artifact_id
        FROM asset_publications publication WHERE publication.public_id=p_public_id)
    END
  )::text,'UTF8'),'sha256'),'hex');
$$;

CREATE OR REPLACE FUNCTION confirm_page_deletion_intent(
  p_intent_id uuid,p_owner_user_id text,p_session_id text,p_credential_id text,
  p_expected_counter integer,p_new_counter integer
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE preliminary_page_id uuid; intent record; intent_challenge text; target record;
BEGIN
  IF p_intent_id IS NULL OR p_owner_user_id IS NULL OR p_session_id IS NULL
     OR p_credential_id IS NULL OR length(trim(p_credential_id))<1
     OR p_expected_counter IS NULL OR p_new_counter IS NULL THEN
    RAISE EXCEPTION 'verified page deletion principal required' USING ERRCODE='42501';
  END IF;
  SELECT deletion.page_id INTO preliminary_page_id
  FROM page_deletion_intents deletion WHERE deletion.id=p_intent_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'page deletion intent not found' USING ERRCODE='P0002'; END IF;
  PERFORM lock_operational_document(preliminary_page_id);
  SELECT page.id,page.current_version_id,page.archived_at INTO target
  FROM knowledge_pages page WHERE page.id=preliminary_page_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'page not found' USING ERRCODE='P0002'; END IF;
  SELECT deletion.id,deletion.page_id,deletion.expected_version_id,
    deletion.owner_user_id,deletion.session_id,deletion.expires_at INTO intent
  FROM page_deletion_intents deletion WHERE deletion.id=p_intent_id FOR UPDATE;
  IF NOT FOUND OR intent.page_id IS DISTINCT FROM preliminary_page_id THEN
    RAISE EXCEPTION 'page deletion intent changed while locking' USING ERRCODE='40001';
  END IF;
  IF intent.expires_at<=now() THEN RAISE EXCEPTION 'page deletion intent expired' USING ERRCODE='22023'; END IF;
  IF intent.owner_user_id IS DISTINCT FROM p_owner_user_id
     OR intent.session_id IS DISTINCT FROM p_session_id THEN
    RAISE EXCEPTION 'page deletion intent principal mismatch' USING ERRCODE='42501';
  END IF;
  IF target.archived_at IS NULL
     OR target.current_version_id IS DISTINCT FROM intent.expected_version_id
     OR EXISTS (SELECT 1 FROM public_resources resource
       JOIN page_publications publication ON publication.public_id=resource.public_id
       WHERE resource.original_document_id=target.id) THEN
    RAISE EXCEPTION 'page is no longer eligible for permanent deletion' USING ERRCODE='22023';
  END IF;
  SELECT challenge.challenge INTO intent_challenge FROM confirmation_challenges challenge
  WHERE challenge.intent_kind='page_deletion' AND challenge.intent_id=intent.id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'page deletion challenge not issued' USING ERRCODE='42501'; END IF;
  PERFORM consume_confirmation_challenge('page_deletion',intent.id,intent_challenge,
    intent.owner_user_id,p_credential_id,p_expected_counter,p_new_counter);
  DELETE FROM knowledge_page_versions WHERE page_id=target.id;
  DELETE FROM knowledge_pages WHERE id=target.id;
END;
$$;

CREATE OR REPLACE FUNCTION validate_automation_registry_documents()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE target_id uuid;
BEGIN
  FOR target_id IN SELECT id FROM unnest(array_remove(
    ARRAY[NEW.instructions_document_id,NEW.state_document_id],NULL)) id ORDER BY id
  LOOP
    PERFORM lock_operational_document(target_id);
    IF NOT EXISTS (SELECT 1 FROM knowledge_pages page
      JOIN hypermedia_documents document ON document.id=page.id
      WHERE page.id=target_id AND page.archived_at IS NULL
        AND document.authority='knowledge' AND document.representation='markdown'
        AND NOT EXISTS (SELECT 1 FROM public_resources resource
          JOIN page_publications publication ON publication.public_id=resource.public_id
          WHERE resource.original_document_id=page.id)
      FOR UPDATE OF page) THEN
      RAISE EXCEPTION 'automation documents must be active, private knowledge Markdown'
        USING ERRCODE='23514';
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM knowledge_settings settings WHERE settings.singleton
    AND settings.global_guide_document_id=ANY(array_remove(
      ARRAY[NEW.instructions_document_id,NEW.state_document_id],NULL))) THEN
    RAISE EXCEPTION 'the global knowledge guide cannot be an automation document'
      USING ERRCODE='23505';
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION validate_automation_registry_documents()
  OWNER TO context_use_boundary_owner;
REVOKE ALL ON FUNCTION validate_automation_registry_documents() FROM PUBLIC;

DO $rewrite$
DECLARE definition text;
BEGIN
  SELECT pg_get_functiondef('begin_pathless_publication_intent(uuid,publication_action,publication_target,uuid,uuid,text,text)'::regprocedure)
  INTO definition;
  definition := replace(definition,
$old$      (p_target_kind='page' AND (
        EXISTS (
          SELECT 1 FROM page_publications publication
          WHERE publication.public_id=mapped_public_id
        ) OR EXISTS (
          SELECT 1 FROM knowledge_pages page
          WHERE page.id=p_target_document_id
            AND page.published_version_id IS NOT NULL
            AND page.public_path IS NOT NULL
        )
      )) OR
      (p_target_kind='asset' AND (
        EXISTS (
          SELECT 1 FROM asset_publications publication
          WHERE publication.public_id=mapped_public_id
        ) OR EXISTS (
          SELECT 1 FROM assets asset
          WHERE asset.id=p_target_document_id AND asset.public_path IS NOT NULL
        )
      ))$old$,
$new$      (p_target_kind='page' AND EXISTS (
        SELECT 1 FROM page_publications publication
        WHERE publication.public_id=mapped_public_id
      )) OR
      (p_target_kind='asset' AND EXISTS (
        SELECT 1 FROM asset_publications publication
        WHERE publication.public_id=mapped_public_id
      ))$new$);
  IF definition ILIKE '%published_version_id%' OR definition ILIKE '%public_path%' THEN
    RAISE EXCEPTION 'failed to contract publication intent planner' USING ERRCODE='55000';
  END IF;
  definition := replace(definition,'filesystem-hypermedia-corpus-transition',
    'context-use:knowledge-lifecycle');
  EXECUTE definition;

  SELECT pg_get_functiondef('confirm_publication_intent(uuid,text,text,text,integer,integer)'::regprocedure)
  INTO definition;
  definition := replace(definition,
    '  publication_family publication_intent_store;'||E'\n', '');
  definition := replace(definition,'  legacy_exists boolean;'||E'\n', '');
  definition := replace(definition,'  legacy_intent record;'||E'\n', '');
  definition := replace(definition,'  locked_target_id uuid;'||E'\n', '');
  definition := replace(definition,'  locked_target_revision_id uuid;'||E'\n', '');
  definition := replace(definition,'  locked_target_path text;'||E'\n', '');
  definition := replace(definition,'  locked_target_inactive_at timestamptz;'||E'\n', '');
  definition := replace(definition,
$old$  SELECT reservation.intent_store INTO publication_family
  FROM publication_intent_id_reservations reservation
  WHERE reservation.intent_id=p_intent_id;
  SELECT EXISTS (
    SELECT 1 FROM publication_intents intent WHERE intent.id=p_intent_id
  ),EXISTS (
    SELECT 1 FROM pathless_publication_intents intent WHERE intent.id=p_intent_id
  ) INTO legacy_exists,pathless_exists;
  IF publication_family IS NULL OR legacy_exists=pathless_exists
     OR (publication_family='legacy' AND NOT legacy_exists)
     OR (publication_family='pathless' AND NOT pathless_exists) THEN
    RAISE EXCEPTION 'publication intent UUID family is missing or ambiguous'
      USING ERRCODE='23505';
  END IF;

  IF publication_family='pathless' THEN$old$,
$new$  SELECT EXISTS (
    SELECT 1 FROM publication_intent_id_reservations reservation
    JOIN pathless_publication_intents intent
      ON intent.id=reservation.intent_id
    WHERE reservation.intent_id=p_intent_id
  ) INTO pathless_exists;
  IF NOT pathless_exists THEN
    RAISE EXCEPTION 'publication intent not found' USING ERRCODE='P0002';
  END IF;

  IF pathless_exists THEN$new$);
  definition := replace(definition,
$$      IF pathless_intent.target_kind='page' THEN
        DELETE FROM page_publications WHERE public_id=mapped_public_id;
        UPDATE knowledge_pages
        SET published_version_id=NULL,public_path=NULL,updated_at=now()
        WHERE id=pathless_intent.target_document_id
          AND (published_version_id IS NOT NULL OR public_path IS NOT NULL);
      ELSE
        DELETE FROM asset_publications WHERE public_id=mapped_public_id;
        UPDATE assets SET public_path=NULL
        WHERE id=pathless_intent.target_document_id AND public_path IS NOT NULL;
      END IF;$$,
$$      IF pathless_intent.target_kind='page' THEN
        DELETE FROM page_publications WHERE public_id=mapped_public_id;
      ELSE
        DELETE FROM asset_publications WHERE public_id=mapped_public_id;
      END IF;$$);
  definition := replace(definition,
    '-- Legacy route-registration reaches this namespace only after consuming'||E'\n'
      ||'      -- its passkey, so pathless confirmation follows the same suffix order.',
    '-- Confirmation locks every UUID namespace in deterministic order.');
  definition := regexp_replace(definition,
    E'\n  SELECT intent\\.id,intent\\.action,intent\\.target_kind,intent\\.target_id,\n    intent\\.version_id,intent\\.public_path.*\n  DELETE FROM publication_intents WHERE id=legacy_intent\\.id;',
    E'\n  RAISE EXCEPTION \'publication intent not found\' USING ERRCODE=\'P0002\';',
    's');
  definition := replace(definition,'filesystem-hypermedia-corpus-transition',
    'context-use:knowledge-lifecycle');
  IF definition LIKE '%FROM publication_intents%'
     OR definition LIKE '%publication_intent_store%'
     OR definition LIKE '%legacy_intent%'
     OR definition LIKE '%current_path%'
     OR definition LIKE '%public_path%'
     OR definition LIKE '%published_version_id%' THEN
    RAISE EXCEPTION 'failed to remove legacy publication confirmation'
      USING ERRCODE='55000';
  END IF;
  EXECUTE definition;

  SELECT pg_get_functiondef('issue_confirmation_challenge(confirmation_intent_kind,uuid,text)'::regprocedure)
  INTO definition;
  definition := replace(definition,
    '  publication_family publication_intent_store;'||E'\n', '');
  definition := replace(definition,'  legacy_exists boolean;'||E'\n', '');
  definition := replace(definition,'  legacy_intent record;'||E'\n', '');
  definition := replace(definition,
$old$    SELECT reservation.intent_store INTO publication_family
    FROM publication_intent_id_reservations reservation
    WHERE reservation.intent_id=p_intent_id;
    SELECT EXISTS (
      SELECT 1 FROM publication_intents intent WHERE intent.id=p_intent_id
    ),EXISTS (
      SELECT 1 FROM pathless_publication_intents intent WHERE intent.id=p_intent_id
    ) INTO legacy_exists,pathless_exists;
    IF publication_family IS NULL OR legacy_exists=pathless_exists
       OR (publication_family='legacy' AND NOT legacy_exists)
       OR (publication_family='pathless' AND NOT pathless_exists) THEN
      RAISE EXCEPTION 'publication intent UUID family is missing or ambiguous'
        USING ERRCODE='23505';
    END IF;

    IF publication_family='pathless' THEN$old$,
$new$    SELECT EXISTS (
      SELECT 1 FROM publication_intent_id_reservations reservation
      JOIN pathless_publication_intents intent
        ON intent.id=reservation.intent_id
      WHERE reservation.intent_id=p_intent_id
    ) INTO pathless_exists;
    IF NOT pathless_exists THEN
      RAISE EXCEPTION 'publication intent not found' USING ERRCODE='P0002';
    END IF;

    IF pathless_exists THEN$new$);
  definition := regexp_replace(definition,
    E'\n    ELSE\n      SELECT intent\\.target_kind,intent\\.target_id,intent\\.version_id.*\n      intent_inactive := false;',
    '', 's');
  definition := replace(definition,
    'SELECT page.id,page.current_version_id,page.published_version_id,'||E'\n      page.archived_at',
    'SELECT page.id,page.current_version_id,page.archived_at');
  definition := replace(definition,
    '       OR deletion_target.published_version_id IS NOT NULL'||E'\n', '');
  definition := replace(definition,'filesystem-hypermedia-corpus-transition',
    'context-use:knowledge-lifecycle');
  IF definition LIKE '%FROM publication_intents%'
     OR definition LIKE '%publication_intent_store%'
     OR definition LIKE '%legacy_intent%'
     OR definition LIKE '%current_path%'
     OR definition LIKE '%public_path%'
     OR definition LIKE '%published_version_id%' THEN
    RAISE EXCEPTION 'failed to remove legacy confirmation challenge issuance'
      USING ERRCODE='55000';
  END IF;
  EXECUTE definition;
END;
$rewrite$;

DROP TYPE publication_intent_store;

DO $rewrite_locks$
DECLARE routine regprocedure; definition text;
BEGIN
  FOR routine IN SELECT value::regprocedure FROM unnest(ARRAY[
    'cancel_pathless_publication_intent(uuid,text,text)',
    'get_pathless_publication_write_target(uuid)',
    'record_generic_knowledge_revision(uuid,uuid,text,uuid[],knowledge_revision_contract_provenance)',
    'seed_pathless_publication_entrypoint()',
    'set_pathless_publication_entrypoint(uuid)',
    'stage_pathless_publication_artifact(uuid,publication_target,bigint,text,text,text,timestamp with time zone,text,text,integer,integer,text,uuid[],uuid[],text)'
  ]) value
  LOOP
    SELECT pg_get_functiondef(routine) INTO definition;
    definition := replace(definition,'filesystem-hypermedia-corpus-transition',
      'context-use:knowledge-lifecycle');
    EXECUTE definition;
  END LOOP;
END;
$rewrite_locks$;

DO $rewrite_claim_guard$
DECLARE definition text;
BEGIN
  SELECT pg_get_functiondef(
    'reject_pending_pathless_publication_claim_challenge()'::regprocedure
  ) INTO definition;
  definition := replace(definition,
    '      AND reservation.intent_store=''pathless'''||E'\n', '');
  IF definition LIKE '%intent_store%' THEN
    RAISE EXCEPTION 'failed to contract publication claim challenge guard'
      USING ERRCODE='55000';
  END IF;
  EXECUTE definition;
END;
$rewrite_claim_guard$;

CREATE OR REPLACE FUNCTION capture_inserted_current_page_version()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('knowledge-page-change-ledger',0));
  INSERT INTO knowledge_page_changes(page_id,version_id,version_number,change_kind,
    title,commit_message,actor_kind,actor_subject,changed_at)
  SELECT NEW.page_id,NEW.id,NEW.version_number,
    CASE WHEN page.archived_at IS NOT NULL THEN 'archived'
      WHEN NEW.version_number=1 THEN 'created' ELSE 'updated' END,
    NEW.title,NEW.commit_message,NEW.actor_kind,NEW.actor_subject,NEW.created_at
  FROM knowledge_pages page
  WHERE page.id=NEW.page_id AND page.current_version_id=NEW.id
  ON CONFLICT (version_id,change_kind) DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION capture_updated_current_page_version()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('knowledge-page-change-ledger',0));
  INSERT INTO knowledge_page_changes(page_id,version_id,version_number,change_kind,
    title,commit_message,actor_kind,actor_subject,changed_at)
  SELECT version.page_id,version.id,version.version_number,
    CASE WHEN NEW.archived_at IS NOT NULL THEN 'archived'
      WHEN version.version_number=1 THEN 'created' ELSE 'updated' END,
    version.title,version.commit_message,version.actor_kind,
    version.actor_subject,version.created_at
  FROM knowledge_page_versions version
  WHERE version.page_id=NEW.id AND version.id=NEW.current_version_id
  ON CONFLICT (version_id,change_kind) DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION capture_archived_knowledge_document()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('knowledge-page-change-ledger',0));
  INSERT INTO knowledge_page_changes(page_id,version_id,version_number,change_kind,
    title,commit_message,actor_kind,actor_subject,changed_at)
  SELECT version.page_id,version.id,version.version_number,'archived',version.title,
    version.commit_message,version.actor_kind,version.actor_subject,clock_timestamp()
  FROM knowledge_page_versions version
  WHERE version.page_id=NEW.id AND version.id=NEW.current_version_id
  ON CONFLICT (version_id,change_kind) DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION capture_deleted_current_page_version()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('knowledge-page-change-ledger',0));
  INSERT INTO knowledge_page_changes(page_id,version_id,version_number,change_kind,
    title,commit_message,actor_kind,actor_subject,changed_at)
  SELECT OLD.page_id,OLD.id,OLD.version_number,'deleted',OLD.title,
    'Permanently delete page',NULL,NULL,now()
  FROM knowledge_pages page
  WHERE page.id=OLD.page_id AND page.current_version_id=OLD.id
    AND page.archived_at IS NOT NULL
  ON CONFLICT (version_id,change_kind) DO NOTHING;
  RETURN OLD;
END;
$$;

CREATE OR REPLACE FUNCTION protect_configured_global_knowledge_guide()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF EXISTS (SELECT 1 FROM knowledge_settings
      WHERE singleton AND global_guide_document_id=OLD.id) THEN
      RAISE EXCEPTION 'the configured global knowledge guide cannot be archived or deleted'
        USING ERRCODE='23514';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.archived_at IS NOT NULL AND EXISTS (SELECT 1 FROM knowledge_settings
    WHERE singleton AND global_guide_document_id=OLD.id) THEN
    RAISE EXCEPTION 'the configured global knowledge guide cannot be archived or deleted'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION protect_registered_automation_documents()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE target_id uuid := CASE WHEN TG_OP='DELETE' THEN OLD.id ELSE NEW.id END;
BEGIN
  PERFORM lock_operational_document(target_id);
  IF EXISTS (SELECT 1 FROM automation_registry
    WHERE instructions_document_id=target_id OR state_document_id=target_id)
    AND (TG_OP='DELETE' OR NEW.archived_at IS NOT NULL) THEN
    RAISE EXCEPTION 'registered automation documents cannot be archived or deleted'
      USING ERRCODE='23514';
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE OR REPLACE FUNCTION validate_global_knowledge_guide()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF NEW.global_guide_document_id IS NOT NULL THEN
    PERFORM lock_operational_document(NEW.global_guide_document_id);
    IF EXISTS (SELECT 1 FROM automation_registry
      WHERE instructions_document_id=NEW.global_guide_document_id
         OR state_document_id=NEW.global_guide_document_id) THEN
      RAISE EXCEPTION 'an automation document cannot be the global knowledge guide'
        USING ERRCODE='23505';
    END IF;
    PERFORM 1 FROM knowledge_pages page
    JOIN hypermedia_documents document ON document.id=page.id
    WHERE page.id=NEW.global_guide_document_id AND page.archived_at IS NULL
      AND document.authority='knowledge' AND document.representation='markdown'
      AND NOT EXISTS (SELECT 1 FROM public_resources resource
        JOIN page_publications publication ON publication.public_id=resource.public_id
        WHERE resource.original_document_id=page.id)
    FOR UPDATE OF page;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'global guide must be active, private knowledge Markdown'
        USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION bump_page_publication_target_generation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF TG_OP='INSERT' THEN PERFORM bump_publication_target_generation('page',NEW.id);
  ELSIF TG_OP='DELETE' THEN PERFORM bump_publication_target_generation('page',OLD.id);
  ELSIF NEW.current_version_id IS DISTINCT FROM OLD.current_version_id
     OR NEW.archived_at IS DISTINCT FROM OLD.archived_at THEN
    PERFORM bump_publication_target_generation('page',NEW.id);
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION bump_asset_publication_target_generation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF TG_OP='INSERT' THEN PERFORM bump_publication_target_generation('asset',NEW.id);
  ELSIF TG_OP='DELETE' THEN PERFORM bump_publication_target_generation('asset',OLD.id);
  ELSIF NEW.filename IS DISTINCT FROM OLD.filename
     OR NEW.content_type IS DISTINCT FROM OLD.content_type
     OR NEW.size_bytes IS DISTINCT FROM OLD.size_bytes
     OR NEW.content_hash IS DISTINCT FROM OLD.content_hash
     OR NEW.s3_object_key IS DISTINCT FROM OLD.s3_object_key
     OR NEW.width IS DISTINCT FROM OLD.width OR NEW.height IS DISTINCT FROM OLD.height
     OR NEW.duration_seconds IS DISTINCT FROM OLD.duration_seconds
     OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
    PERFORM bump_publication_target_generation('asset',NEW.id);
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION prune_page_versions(p_page_id uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE removed_count integer;
BEGIN
  IF p_page_id IS NULL THEN RAISE EXCEPTION 'page id required' USING ERRCODE='22023'; END IF;
  PERFORM 1 FROM knowledge_pages WHERE id=p_page_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 0; END IF;
  WITH newest AS (SELECT id FROM knowledge_page_versions WHERE page_id=p_page_id
    ORDER BY version_number DESC LIMIT 5), removed AS (
    DELETE FROM knowledge_page_versions version
    WHERE version.page_id=p_page_id
      AND NOT EXISTS (SELECT 1 FROM newest WHERE newest.id=version.id)
      AND NOT EXISTS (SELECT 1 FROM knowledge_pages page
        WHERE page.id=p_page_id AND page.current_version_id=version.id)
      AND NOT EXISTS (SELECT 1 FROM public_page_artifacts artifact
        WHERE artifact.source_document_id=p_page_id AND artifact.source_revision_id=version.id)
      AND NOT EXISTS (SELECT 1 FROM pathless_publication_intents intent
        WHERE intent.target_kind='page' AND intent.target_document_id=p_page_id
          AND intent.expected_revision_id=version.id AND intent.expires_at>now())
    RETURNING 1)
  SELECT count(*)::integer INTO removed_count FROM removed;
  RETURN removed_count;
END;
$$;

CREATE TRIGGER knowledge_pages_lock_settings_before_guide_update
BEFORE UPDATE OF archived_at ON knowledge_pages FOR EACH STATEMENT
EXECUTE FUNCTION lock_knowledge_settings_for_page_lifecycle();
CREATE TRIGGER knowledge_pages_protect_configured_global_guide_update
BEFORE UPDATE OF archived_at ON knowledge_pages FOR EACH ROW
EXECUTE FUNCTION protect_configured_global_knowledge_guide();
CREATE TRIGGER knowledge_pages_protect_registered_automation_update
BEFORE UPDATE OF archived_at ON knowledge_pages FOR EACH ROW
EXECUTE FUNCTION protect_registered_automation_documents();
CREATE TRIGGER knowledge_pages_zz029_bump_publication_target
AFTER INSERT OR DELETE OR UPDATE OF current_version_id,archived_at ON knowledge_pages
FOR EACH ROW EXECUTE FUNCTION bump_page_publication_target_generation();
CREATE TRIGGER assets_zz029_bump_publication_target
AFTER INSERT OR DELETE OR UPDATE OF filename,content_type,size_bytes,content_hash,
  s3_object_key,width,height,duration_seconds,deleted_at ON assets
FOR EACH ROW EXECUTE FUNCTION bump_asset_publication_target_generation();

CREATE VIEW live_public_namespace_conflicts
WITH (security_barrier=true,security_invoker=false) AS
WITH private_identity(kind,id) AS (
  SELECT 'document',id FROM hypermedia_documents
  UNION ALL SELECT 'revision',id FROM hypermedia_document_revisions
  UNION ALL SELECT 'historical_document',original_document_id
    FROM public_resources WHERE original_document_id IS NOT NULL
), public_candidate(public_id,document_id,resource_kind) AS (
  SELECT public_id,original_document_id,resource_kind FROM public_resources
), alias_token AS (
  SELECT alias_path,route_kind,public_id,canonical_legacy_alias_uuid(alias_path) AS token,
    canonical_legacy_alias_kind(alias_path) AS expected_route_kind
  FROM public_route_aliases WHERE canonical_legacy_alias_uuid(alias_path) IS NOT NULL
), detected AS (
  SELECT DISTINCT 'public:resource:'||candidate.public_id::text||':private:'||private.kind conflict_key,
    candidate.public_id namespace_uuid,'public_id_private_id' conflict_kind,
    candidate.public_id,NULL::text alias_path,private.kind identity_kind
  FROM public_candidate candidate JOIN private_identity private ON private.id=candidate.public_id
  UNION SELECT DISTINCT 'public:resource:'||candidate.public_id::text||':artifact',candidate.public_id,
    'public_id_artifact_id',candidate.public_id,NULL::text,'public_artifact'
  FROM public_candidate candidate JOIN public_artifact_id_reservations artifact
    ON artifact.artifact_id=candidate.public_id
  UNION SELECT DISTINCT 'public:resource:'||candidate.public_id::text||':alias:'||alias.alias_path,
    candidate.public_id,'public_id_alias_token',candidate.public_id,alias.alias_path,'legacy_alias_token'
  FROM public_candidate candidate JOIN alias_token alias ON alias.token=candidate.public_id
  WHERE alias.public_id<>candidate.public_id OR alias.route_kind<>alias.expected_route_kind
    OR (candidate.resource_kind='page' AND alias.route_kind NOT IN ('page','markdown'))
    OR (candidate.resource_kind='asset' AND alias.route_kind<>'asset')
  UNION SELECT DISTINCT 'alias:'||alias.alias_path||':private:'||private.kind,alias.token,
    'alias_token_private_id',alias.public_id,alias.alias_path,private.kind
  FROM alias_token alias JOIN private_identity private ON private.id=alias.token
  UNION SELECT DISTINCT 'alias:'||alias.alias_path||':artifact',alias.token,
    'alias_token_artifact_id',alias.public_id,alias.alias_path,'public_artifact'
  FROM alias_token alias JOIN public_artifact_id_reservations artifact ON artifact.artifact_id=alias.token
  UNION SELECT DISTINCT 'artifact:'||artifact.artifact_id::text||':private:'||private.kind,
    artifact.artifact_id,'artifact_id_private_id',NULL::uuid,NULL::text,private.kind
  FROM public_artifact_id_reservations artifact JOIN private_identity private
    ON private.id=artifact.artifact_id
  UNION SELECT DISTINCT 'alias:'||alias.alias_path||':mapping',alias.token,
    'alias_token_public_mapping',alias.public_id,alias.alias_path,'public_resource'
  FROM alias_token alias LEFT JOIN public_resources resource ON resource.public_id=alias.token
  WHERE resource.public_id IS NULL OR alias.public_id<>alias.token
    OR alias.route_kind<>alias.expected_route_kind
    OR (resource.resource_kind='page' AND alias.route_kind NOT IN ('page','markdown'))
    OR (resource.resource_kind='asset' AND alias.route_kind<>'asset'))
SELECT conflict_key,namespace_uuid,conflict_kind,public_id,alias_path,
  identity_kind AS conflicting_identity_kind,'permanent'::text AS conflict_lifecycle FROM detected;
ALTER VIEW live_public_namespace_conflicts OWNER TO context_use_projection_owner;
GRANT SELECT ON live_public_namespace_conflicts TO context_use_boundary_owner,context_use_backup;

CREATE OR REPLACE FUNCTION public_uuid_has_private_identity(p_uuid uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT EXISTS (
    SELECT 1 FROM hypermedia_documents WHERE id=p_uuid
    UNION ALL SELECT 1 FROM hypermedia_document_revisions WHERE id=p_uuid
    UNION ALL SELECT 1 FROM hypermedia_bootstrap_allocations
      WHERE document_id=p_uuid OR revision_id=p_uuid
    UNION ALL SELECT 1 FROM public_resources WHERE original_document_id=p_uuid
    UNION ALL SELECT 1 FROM publication_target_generations WHERE target_document_id=p_uuid
  );
$$;

CREATE VIEW private_document_catalog
WITH (security_barrier=true,security_invoker=false) AS
SELECT document.id document_id,'knowledge'::text document_kind,document.authority,
  document.representation,CASE WHEN page.archived_at IS NULL THEN 'active' ELSE 'archived' END lifecycle,
  page.current_version_id current_revision_id,revision.revision_number current_revision_number,
  version.title,version.summary,NULL::text filename,NULL::text content_type,
  revision.body_size_bytes::bigint size_bytes,revision.body_content_hash content_hash,
  NULL::integer width,NULL::integer height,NULL::numeric duration_seconds,
  NULL::text integration,NULL::bigint connection_instance_id,NULL::text connection_id,
  NULL::text source_model,NULL::text source_record_id,array_remove(ARRAY[
    CASE WHEN settings.global_guide_document_id=page.id THEN 'global_guide' END,
    CASE WHEN EXISTS (SELECT 1 FROM automation_registry registry
      WHERE registry.instructions_document_id=page.id) THEN 'automation_instructions' END,
    CASE WHEN EXISTS (SELECT 1 FROM automation_registry registry
      WHERE registry.state_document_id=page.id) THEN 'automation_state' END],NULL) operational_roles,
  resource.public_id,contract.link_contract::text current_link_contract,revision.links_indexed_at,
  coalesce(search.revision_id=page.current_version_id,false) pathless_search_ready,
  document.created_at,document.updated_at
FROM hypermedia_documents document JOIN knowledge_pages page ON page.id=document.id
JOIN knowledge_page_versions version ON version.id=page.current_version_id AND version.page_id=page.id
JOIN hypermedia_document_revisions revision ON revision.id=page.current_version_id AND revision.document_id=page.id
LEFT JOIN knowledge_settings settings ON settings.singleton
LEFT JOIN public_resources resource ON resource.document_id=page.id
LEFT JOIN knowledge_revision_contracts contract ON contract.revision_id=page.current_version_id
LEFT JOIN pathless_knowledge_search search ON search.document_id=page.id
WHERE document.authority='knowledge' AND document.representation='markdown'
UNION ALL SELECT document.id,'record',document.authority,document.representation,
  CASE WHEN record.deleted_at IS NULL THEN 'active' ELSE 'deleted' END,
  record.current_revision_id,revision.revision_number,NULL,NULL,NULL,NULL,
  revision.body_size_bytes::bigint,revision.body_content_hash,NULL,NULL,NULL,
  record.integration,record.connection_instance_id,record.connection_id,record.model,
  record.source_record_id,'{}'::text[],NULL::uuid,NULL::text,revision.links_indexed_at,
  CASE WHEN record.current_revision_id IS NULL THEN record.deleted_at IS NOT NULL
    ELSE revision.id IS NOT NULL AND revision.links_indexed_at IS NOT NULL END,
  document.created_at,document.updated_at
FROM hypermedia_documents document JOIN source_records record ON record.document_id=document.id
LEFT JOIN hypermedia_document_revisions revision ON revision.id=record.current_revision_id
  AND revision.document_id=record.document_id
WHERE document.authority='source' AND document.representation='markdown'
UNION ALL SELECT document.id,'asset',document.authority,document.representation,
  CASE WHEN asset.deleted_at IS NULL THEN 'active' ELSE 'deleted' END,
  NULL::uuid,NULL::integer,NULL::text,NULL::text,asset.filename,asset.content_type,
  asset.size_bytes,asset.content_hash,asset.width,asset.height,asset.duration_seconds,
  NULL::text,NULL::bigint,NULL::text,NULL::text,NULL::text,'{}'::text[],resource.public_id,
  NULL::text,NULL::timestamptz,true,document.created_at,document.updated_at
FROM hypermedia_documents document JOIN assets asset ON asset.id=document.id
LEFT JOIN public_resources resource ON resource.document_id=asset.id
WHERE document.authority='knowledge' AND document.representation='asset';
ALTER VIEW private_document_catalog OWNER TO context_use_projection_owner;
GRANT SELECT ON private_document_catalog TO context_use_dashboard,context_use_mcp,context_use_backup;

REVOKE CREATE ON SCHEMA public FROM context_use_boundary_owner;
REVOKE CREATE ON SCHEMA public FROM context_use_projection_owner;
