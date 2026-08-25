-- Full-bundle import is a destination-local initialization capability. It is
-- deliberately absent from the logical bundle catalog: importing source data
-- must never reopen the destination's one-time initialization window.
CREATE TABLE knowledge_bundle_import_policy (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  state text NOT NULL CHECK (state IN ('pending','available','closed')),
  changed_at timestamptz NOT NULL DEFAULT now()
);

-- Existing installations fail closed unless they are still exactly the
-- managed bootstrap. The change ledger makes this conservative even when a
-- personal page was later permanently deleted.
INSERT INTO knowledge_bundle_import_policy(singleton,state)
SELECT true,CASE
  WHEN NOT EXISTS (SELECT 1 FROM hypermedia_bootstrap_allocations)
    AND NOT EXISTS (SELECT 1 FROM hypermedia_documents)
    AND NOT EXISTS (SELECT 1 FROM assets)
    AND NOT EXISTS (SELECT 1 FROM source_records)
    AND NOT EXISTS (SELECT 1 FROM public_resources)
    THEN 'pending'
  WHEN (SELECT count(*) FROM hypermedia_bootstrap_allocations)=5
    AND NOT EXISTS (
      SELECT 1 FROM hypermedia_bootstrap_allocations WHERE completed_at IS NULL
    )
    AND (SELECT count(*) FROM hypermedia_documents)=5
    AND NOT EXISTS (
      SELECT 1 FROM hypermedia_documents document
      WHERE NOT EXISTS (
        SELECT 1 FROM hypermedia_bootstrap_allocations allocation
        WHERE allocation.document_id=document.id
      )
    )
    AND (SELECT count(*) FROM knowledge_pages)=5
    AND NOT EXISTS (
      SELECT 1 FROM knowledge_pages page
      WHERE page.archived_at IS NOT NULL OR NOT EXISTS (
        SELECT 1 FROM hypermedia_bootstrap_allocations allocation
        WHERE allocation.document_id=page.id
      )
    )
    AND NOT EXISTS (SELECT 1 FROM assets)
    AND NOT EXISTS (SELECT 1 FROM source_records)
    AND NOT EXISTS (SELECT 1 FROM public_resources)
    AND NOT EXISTS (SELECT 1 FROM publication_intents)
    AND NOT EXISTS (
      SELECT 1 FROM knowledge_page_changes change
      WHERE NOT (
        (change.change_kind='created' AND change.version_number=1
          AND change.actor_kind='dashboard'
          AND change.actor_subject='context-use-hypermedia-bootstrap/v1'
          AND EXISTS (
            SELECT 1 FROM hypermedia_bootstrap_allocations allocation
            WHERE allocation.document_id=change.page_id
              AND allocation.revision_id=change.version_id
          ))
        OR
        (change.change_kind='updated' AND change.actor_kind='dashboard'
          AND change.actor_subject='context-use-managed-global-guide/v1'
          AND change.page_id=(
            SELECT document_id FROM hypermedia_bootstrap_allocations
            WHERE document_kind='global_guide'
          ))
      )
    )
    AND (SELECT count(*) FROM knowledge_page_changes
      WHERE change_kind='created'
        AND actor_subject='context-use-hypermedia-bootstrap/v1')=5
    AND (SELECT count(*) FROM automation_registry)=2
    AND EXISTS (
      SELECT 1 FROM automation_registry registry
      JOIN hypermedia_bootstrap_allocations instructions
        ON instructions.document_kind='activity_distiller_instructions'
       AND instructions.document_id=registry.instructions_document_id
      JOIN hypermedia_bootstrap_allocations state
        ON state.document_kind='activity_distiller_state'
       AND state.document_id=registry.state_document_id
      WHERE registry.key='activity-distiller' AND registry.disabled_at IS NULL
    )
    AND EXISTS (
      SELECT 1 FROM automation_registry registry
      JOIN hypermedia_bootstrap_allocations instructions
        ON instructions.document_kind='diary_composer_instructions'
       AND instructions.document_id=registry.instructions_document_id
      JOIN hypermedia_bootstrap_allocations state
        ON state.document_kind='diary_composer_state'
       AND state.document_id=registry.state_document_id
      WHERE registry.key='diary-composer' AND registry.disabled_at IS NULL
    )
    AND EXISTS (
      SELECT 1 FROM knowledge_settings settings
      JOIN hypermedia_bootstrap_allocations allocation
        ON allocation.document_kind='global_guide'
       AND allocation.document_id=settings.global_guide_document_id
      WHERE settings.singleton
    )
    AND EXISTS (
      SELECT 1 FROM publication_settings
      WHERE singleton AND updated_at IS NOT NULL AND entrypoint_public_id IS NULL
    )
    THEN 'available'
  ELSE 'closed'
END;

CREATE FUNCTION open_full_knowledge_import_after_bootstrap() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  UPDATE knowledge_bundle_import_policy
  SET state='available',changed_at=clock_timestamp()
  WHERE singleton AND state='pending'
    AND (SELECT count(*) FROM hypermedia_bootstrap_allocations)=5
    AND NOT EXISTS (
      SELECT 1 FROM hypermedia_bootstrap_allocations WHERE completed_at IS NULL
    );
  RETURN NULL;
END;
$$;

CREATE TRIGGER hypermedia_bootstrap_open_full_import
AFTER UPDATE OF completed_at ON hypermedia_bootstrap_allocations
FOR EACH STATEMENT EXECUTE FUNCTION open_full_knowledge_import_after_bootstrap();

CREATE FUNCTION close_full_knowledge_import() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  UPDATE knowledge_bundle_import_policy
  SET state='closed',changed_at=clock_timestamp()
  WHERE singleton AND state='available';
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE FUNCTION close_full_knowledge_import_for_page_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  -- Release-managed guide synchronization is still part of the untouched
  -- default template. Every owner/agent page change closes the window.
  IF NEW.change_kind='updated' AND NEW.actor_kind='dashboard'
     AND NEW.actor_subject='context-use-managed-global-guide/v1'
     AND NEW.page_id=(
       SELECT document_id FROM hypermedia_bootstrap_allocations
       WHERE document_kind='global_guide'
     ) THEN
    RETURN NEW;
  END IF;
  UPDATE knowledge_bundle_import_policy
  SET state='closed',changed_at=clock_timestamp()
  WHERE singleton AND state='available';
  RETURN NEW;
END;
$$;

CREATE TRIGGER knowledge_page_changes_close_full_import
BEFORE INSERT ON knowledge_page_changes
FOR EACH ROW EXECUTE FUNCTION close_full_knowledge_import_for_page_change();
CREATE TRIGGER assets_close_full_import
BEFORE INSERT OR UPDATE OR DELETE ON assets
FOR EACH ROW EXECUTE FUNCTION close_full_knowledge_import();
CREATE TRIGGER source_records_close_full_import
BEFORE INSERT OR UPDATE OR DELETE ON source_records
FOR EACH ROW EXECUTE FUNCTION close_full_knowledge_import();
CREATE TRIGGER public_resources_close_full_import
BEFORE INSERT OR UPDATE OR DELETE ON public_resources
FOR EACH ROW EXECUTE FUNCTION close_full_knowledge_import();
CREATE TRIGGER publication_intents_close_full_import
BEFORE INSERT OR UPDATE OR DELETE ON publication_intents
FOR EACH ROW EXECUTE FUNCTION close_full_knowledge_import();
CREATE TRIGGER automation_registry_close_full_import
BEFORE INSERT OR UPDATE OR DELETE ON automation_registry
FOR EACH ROW EXECUTE FUNCTION close_full_knowledge_import();
CREATE TRIGGER knowledge_settings_close_full_import
BEFORE INSERT OR UPDATE OR DELETE ON knowledge_settings
FOR EACH ROW EXECUTE FUNCTION close_full_knowledge_import();
CREATE TRIGGER publication_settings_close_full_import
BEFORE INSERT OR UPDATE OR DELETE ON publication_settings
FOR EACH ROW EXECUTE FUNCTION close_full_knowledge_import();

CREATE FUNCTION full_knowledge_import_available() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public
RETURN coalesce((
  SELECT state='available' FROM knowledge_bundle_import_policy WHERE singleton
),false);

-- Aggregate export preparation stays behind the same narrow privileged owner
-- as snapshot capture. The dashboard receives counts, never raw retained or
-- public object locators.
CREATE FUNCTION full_knowledge_bundle_summary()
RETURNS TABLE(page_count bigint,asset_count bigint,estimated_bytes bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT
    (SELECT count(*) FROM knowledge_pages WHERE archived_at IS NULL),
    (SELECT count(*) FROM assets WHERE deleted_at IS NULL),
    coalesce((SELECT sum(size_bytes) FROM (
      SELECT DISTINCT ON (object_key) object_key,size_bytes
      FROM (
        SELECT body_object_key object_key,body_size_bytes::bigint size_bytes
          FROM hypermedia_document_revisions
        UNION ALL SELECT s3_object_key,size_bytes FROM assets WHERE deleted_at IS NULL
        UNION ALL SELECT body_object_key,body_size_bytes FROM retained_page_artifacts
        UNION ALL SELECT body_object_key,body_size_bytes FROM public_page_artifacts
        UNION ALL SELECT body_object_key,body_size_bytes FROM public_asset_artifacts
      ) referenced_objects
      ORDER BY object_key,size_bytes
    ) unique_objects),0)::bigint;
$$;

-- Confirmation is independently isolated from the dashboard. Keep the same
-- eligibility decision at that boundary so a bundle cannot be authorized
-- after knowledge changed during upload or validation.
ALTER FUNCTION confirm_knowledge_bundle_import(uuid,text,text,text,integer,integer)
  RENAME TO confirm_knowledge_bundle_import_unchecked;
REVOKE ALL ON FUNCTION confirm_knowledge_bundle_import_unchecked(
  uuid,text,text,text,integer,integer
) FROM PUBLIC,context_use_confirmation;

CREATE FUNCTION confirm_knowledge_bundle_import(
  p_import_id uuid,p_owner_user_id text,p_session_id text,p_credential_id text,
  p_expected_counter integer,p_new_counter integer
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF NOT full_knowledge_import_available() THEN
    RAISE EXCEPTION 'full knowledge imports require an initialization-stage Context Use instance'
      USING ERRCODE='55000';
  END IF;
  PERFORM confirm_knowledge_bundle_import_unchecked(
    p_import_id,p_owner_user_id,p_session_id,p_credential_id,
    p_expected_counter,p_new_counter
  );
END;
$$;

-- Wrap the original restore so old deployments receive a strict lifecycle
-- gate without duplicating the large, versioned restore implementation.
ALTER FUNCTION restore_full_knowledge_bundle(uuid,text,text)
  RENAME TO restore_full_knowledge_bundle_unchecked;
REVOKE ALL ON FUNCTION restore_full_knowledge_bundle_unchecked(uuid,text,text)
  FROM PUBLIC,context_use_dashboard;

CREATE FUNCTION restore_full_knowledge_bundle(
  p_import_id uuid,p_owner_user_id text,p_session_id text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET jit=off AS $$
DECLARE restored jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('context-use:knowledge-lifecycle',0));
  IF NOT full_knowledge_import_available() THEN
    RAISE EXCEPTION 'full knowledge imports require an initialization-stage Context Use instance'
      USING ERRCODE='55000';
  END IF;
  restored:=restore_full_knowledge_bundle_unchecked(
    p_import_id,p_owner_user_id,p_session_id
  );
  UPDATE knowledge_bundle_import_policy
  SET state='closed',changed_at=clock_timestamp()
  WHERE singleton;
  RETURN restored;
END;
$$;

ALTER FUNCTION open_full_knowledge_import_after_bootstrap()
  OWNER TO context_use_import_owner;
ALTER FUNCTION close_full_knowledge_import()
  OWNER TO context_use_import_owner;
ALTER FUNCTION close_full_knowledge_import_for_page_change()
  OWNER TO context_use_import_owner;
ALTER FUNCTION full_knowledge_import_available()
  OWNER TO context_use_import_owner;
ALTER FUNCTION full_knowledge_bundle_summary()
  OWNER TO context_use_import_owner;
ALTER FUNCTION confirm_knowledge_bundle_import(uuid,text,text,text,integer,integer)
  OWNER TO context_use_boundary_owner;
ALTER FUNCTION restore_full_knowledge_bundle(uuid,text,text)
  OWNER TO context_use_import_owner;

REVOKE ALL ON FUNCTION open_full_knowledge_import_after_bootstrap() FROM PUBLIC;
REVOKE ALL ON FUNCTION close_full_knowledge_import() FROM PUBLIC;
REVOKE ALL ON FUNCTION close_full_knowledge_import_for_page_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION full_knowledge_import_available() FROM PUBLIC;
REVOKE ALL ON FUNCTION full_knowledge_bundle_summary() FROM PUBLIC;
REVOKE ALL ON FUNCTION confirm_knowledge_bundle_import(
  uuid,text,text,text,integer,integer
) FROM PUBLIC;
REVOKE ALL ON FUNCTION restore_full_knowledge_bundle(uuid,text,text) FROM PUBLIC;

GRANT SELECT,UPDATE ON knowledge_bundle_import_policy TO context_use_import_owner;
GRANT SELECT ON knowledge_bundle_import_policy TO context_use_backup;
GRANT EXECUTE ON FUNCTION full_knowledge_import_available()
  TO context_use_dashboard,context_use_boundary_owner;
GRANT EXECUTE ON FUNCTION full_knowledge_bundle_summary()
  TO context_use_dashboard;
GRANT EXECUTE ON FUNCTION confirm_knowledge_bundle_import(
  uuid,text,text,text,integer,integer
) TO context_use_confirmation;
GRANT EXECUTE ON FUNCTION restore_full_knowledge_bundle(uuid,text,text)
  TO context_use_dashboard;
