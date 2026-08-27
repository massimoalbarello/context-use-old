DROP TRIGGER assets_close_full_import ON public.assets;
DROP TRIGGER automation_registry_close_full_import ON public.automation_registry;
DROP TRIGGER hypermedia_bootstrap_open_full_import ON public.hypermedia_bootstrap_allocations;
DROP TRIGGER knowledge_page_changes_close_full_import ON public.knowledge_page_changes;
DROP TRIGGER knowledge_settings_close_full_import ON public.knowledge_settings;
DROP TRIGGER public_resources_close_full_import ON public.public_resources;
DROP TRIGGER publication_intents_close_full_import ON public.publication_intents;
DROP TRIGGER publication_settings_close_full_import ON public.publication_settings;
DROP TRIGGER source_records_close_full_import ON public.source_records;

DROP FUNCTION public.capture_full_knowledge_bundle(uuid,text,text);
DROP FUNCTION public.claim_knowledge_export_download(uuid,text,text);
DROP FUNCTION public.close_full_knowledge_import();
DROP FUNCTION public.close_full_knowledge_import_for_page_change();
DROP FUNCTION public.confirm_knowledge_bundle_import(uuid,text,text,text,integer,integer);
DROP FUNCTION public.confirm_knowledge_bundle_import_unchecked(uuid,text,text,text,integer,integer);
DROP FUNCTION public.confirm_knowledge_export_intent(uuid,text,text,text,integer,integer);
DROP FUNCTION public.full_knowledge_bundle_summary();
DROP FUNCTION public.full_knowledge_import_available();
DROP FUNCTION public.issue_knowledge_bundle_import_challenge(uuid,text);
DROP FUNCTION public.open_full_knowledge_import_after_bootstrap();
DROP FUNCTION public.restore_full_knowledge_bundle(uuid,text,text);
DROP FUNCTION public.restore_full_knowledge_bundle_unchecked(uuid,text,text);

CREATE OR REPLACE FUNCTION public.begin_hypermedia_bootstrap()
RETURNS TABLE(document_kind text,document_id uuid,revision_id uuid)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog','public'
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('context-use:hypermedia-bootstrap',0)
  );
  IF NOT EXISTS (SELECT 1 FROM knowledge_settings WHERE singleton) THEN
    INSERT INTO knowledge_settings(singleton) VALUES (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM publication_settings WHERE singleton) THEN
    INSERT INTO publication_settings(singleton,entrypoint_public_id,updated_at)
    VALUES (true,NULL,NULL);
  END IF;
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
       OR EXISTS (SELECT 1 FROM publication_settings
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

DROP FUNCTION public.issue_confirmation_challenge(
  public.confirmation_intent_kind,uuid,text
);
DROP FUNCTION public.consume_confirmation_challenge(
  public.confirmation_intent_kind,uuid,text,text,text,integer,integer
);
DROP TABLE public.confirmation_challenges;
DROP TYPE public.confirmation_intent_kind;

CREATE TYPE public.confirmation_intent_kind AS ENUM (
  'publication',
  'page_deletion'
);

CREATE TABLE public.confirmation_challenges (
  intent_kind public.confirmation_intent_kind NOT NULL,
  intent_id uuid NOT NULL,
  challenge text NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT confirmation_challenges_challenge_check
    CHECK (challenge ~ '^[A-Za-z0-9_-]{43,128}$'),
  CONSTRAINT confirmation_challenges_challenge_key UNIQUE (challenge),
  CONSTRAINT confirmation_challenges_pkey PRIMARY KEY (intent_kind,intent_id)
);

GRANT DELETE ON TABLE public.confirmation_challenges TO context_use_boundary_owner;
GRANT SELECT ON TABLE public.confirmation_challenges TO context_use_backup;
GRANT SELECT(intent_kind),INSERT(intent_kind)
  ON TABLE public.confirmation_challenges TO context_use_boundary_owner;
GRANT SELECT(intent_kind)
  ON TABLE public.confirmation_challenges TO context_use_confirmation,context_use_storage_owner;
GRANT SELECT(intent_id),INSERT(intent_id),UPDATE(intent_id)
  ON TABLE public.confirmation_challenges TO context_use_boundary_owner;
GRANT SELECT(intent_id)
  ON TABLE public.confirmation_challenges TO context_use_confirmation,context_use_storage_owner;
GRANT SELECT(challenge),INSERT(challenge)
  ON TABLE public.confirmation_challenges TO context_use_boundary_owner;
GRANT SELECT(challenge)
  ON TABLE public.confirmation_challenges TO context_use_confirmation;

CREATE FUNCTION public.consume_confirmation_challenge(
  p_intent_kind public.confirmation_intent_kind,
  p_intent_id uuid,
  p_challenge text,
  p_owner_user_id text,
  p_credential_id text,
  p_expected_counter integer,
  p_new_counter integer
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog','public'
AS $$
DECLARE
  stored_counter integer;
BEGIN
  IF p_challenge IS NULL OR p_owner_user_id IS NULL OR p_credential_id IS NULL
     OR p_expected_counter IS NULL OR p_new_counter IS NULL THEN
    RAISE EXCEPTION 'verified passkey assertion required' USING ERRCODE='42501';
  END IF;

  SELECT counter INTO stored_counter
  FROM auth.passkey
  WHERE "userId"=p_owner_user_id AND "credentialID"=p_credential_id
  FOR UPDATE;
  IF NOT FOUND OR stored_counter IS DISTINCT FROM p_expected_counter THEN
    RAISE EXCEPTION 'passkey counter changed during confirmation' USING ERRCODE='40001';
  END IF;
  IF p_new_counter<0
     OR ((stored_counter>0 OR p_new_counter>0) AND p_new_counter<=stored_counter) THEN
    RAISE EXCEPTION 'passkey counter did not advance' USING ERRCODE='42501';
  END IF;

  DELETE FROM confirmation_challenges
  WHERE intent_kind=p_intent_kind AND intent_id=p_intent_id
    AND challenge=p_challenge;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'confirmation challenge is missing or consumed' USING ERRCODE='23505';
  END IF;

  UPDATE auth.passkey SET counter=p_new_counter
  WHERE "userId"=p_owner_user_id AND "credentialID"=p_credential_id;
END;
$$;

ALTER FUNCTION public.consume_confirmation_challenge(
  public.confirmation_intent_kind,uuid,text,text,text,integer,integer
) OWNER TO context_use_boundary_owner;
REVOKE ALL ON FUNCTION public.consume_confirmation_challenge(
  public.confirmation_intent_kind,uuid,text,text,text,integer,integer
) FROM PUBLIC;

CREATE FUNCTION public.issue_confirmation_challenge(
  p_intent_kind public.confirmation_intent_kind,
  p_intent_id uuid,
  p_challenge text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog','public'
SET jit TO 'off'
AS $$
DECLARE
  intent_expires_at timestamptz;
  intent_inactive boolean;
  publication_exists boolean;
  preliminary record;
  publication_intent publication_intents%ROWTYPE;
  deletion_intent record;
  deletion_target record;
BEGIN
  IF p_intent_kind IS NULL OR p_intent_id IS NULL OR p_challenge IS NULL
     OR p_challenge !~ '^[A-Za-z0-9_-]{43,128}$' THEN
    RAISE EXCEPTION 'valid confirmation challenge required' USING ERRCODE='22023';
  END IF;

  PERFORM pg_advisory_xact_lock_shared(
    hashtextextended('context-use:knowledge-lifecycle',0)
  );

  IF p_intent_kind='publication' THEN
    SELECT EXISTS (
      SELECT 1 FROM publication_intent_id_reservations reservation
      JOIN publication_intents intent ON intent.id=reservation.intent_id
      WHERE reservation.intent_id=p_intent_id
    ) INTO publication_exists;
    IF NOT publication_exists THEN
      RAISE EXCEPTION 'publication intent not found' USING ERRCODE='P0002';
    END IF;

    SELECT intent.target_kind,intent.target_document_id,
      intent.expected_revision_id,intent.action
    INTO preliminary
    FROM publication_intents intent WHERE intent.id=p_intent_id;
    PERFORM lock_publication_context(
      preliminary.target_kind,preliminary.target_document_id,
      preliminary.expected_revision_id
    );
    PERFORM assert_publication_intent_current(
      p_intent_id,preliminary.action='publish'
    );
    SELECT * INTO publication_intent
    FROM publication_intents intent WHERE intent.id=p_intent_id;
    intent_expires_at := publication_intent.expires_at;
    intent_inactive := publication_intent.confirmed_at IS NOT NULL
      OR publication_intent.cancelled_at IS NOT NULL;
  ELSIF p_intent_kind='page_deletion' THEN
    SELECT intent.page_id,intent.expected_version_id
    INTO preliminary
    FROM page_deletion_intents intent WHERE intent.id=p_intent_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'confirmation intent not found' USING ERRCODE='P0002';
    END IF;
    PERFORM lock_operational_document(preliminary.page_id);
    SELECT page.id,page.current_version_id,page.archived_at
    INTO deletion_target
    FROM knowledge_pages page WHERE page.id=preliminary.page_id
    FOR UPDATE;
    SELECT intent.id,intent.page_id,intent.expected_version_id,
      intent.owner_user_id,intent.session_id,intent.expires_at
    INTO deletion_intent
    FROM page_deletion_intents intent WHERE intent.id=p_intent_id
    FOR UPDATE;
    IF NOT FOUND
       OR deletion_intent.page_id IS DISTINCT FROM preliminary.page_id
       OR deletion_intent.expected_version_id IS DISTINCT FROM preliminary.expected_version_id THEN
      RAISE EXCEPTION 'page deletion intent changed while locking' USING ERRCODE='40001';
    END IF;
    IF deletion_target.id IS NULL
       OR deletion_target.archived_at IS NULL
       OR deletion_target.current_version_id IS DISTINCT FROM deletion_intent.expected_version_id THEN
      RAISE EXCEPTION 'page is no longer eligible for permanent deletion' USING ERRCODE='22023';
    END IF;
    intent_expires_at := deletion_intent.expires_at;
    intent_inactive := false;
  ELSE
    RAISE EXCEPTION 'confirmation intent kind is unsupported' USING ERRCODE='22023';
  END IF;

  IF intent_expires_at IS NULL THEN
    RAISE EXCEPTION 'confirmation intent not found' USING ERRCODE='P0002';
  END IF;
  IF intent_inactive OR intent_expires_at<=now() THEN
    RAISE EXCEPTION 'confirmation intent is inactive' USING ERRCODE='22023';
  END IF;
  INSERT INTO confirmation_challenges(intent_kind,intent_id,challenge)
  VALUES (p_intent_kind,p_intent_id,p_challenge);
END;
$$;

ALTER FUNCTION public.issue_confirmation_challenge(
  public.confirmation_intent_kind,uuid,text
) OWNER TO context_use_boundary_owner;
REVOKE ALL ON FUNCTION public.issue_confirmation_challenge(
  public.confirmation_intent_kind,uuid,text
) FROM PUBLIC;
GRANT ALL ON FUNCTION public.issue_confirmation_challenge(
  public.confirmation_intent_kind,uuid,text
) TO context_use_confirmation;

DROP TABLE public.knowledge_bundle_import_objects;
DROP TABLE public.knowledge_bundle_import_parts;
DROP TABLE public.knowledge_bundle_import_records;
DROP TABLE public.knowledge_bundle_imports;
DROP TABLE public.knowledge_bundle_import_policy;
DROP TABLE public.knowledge_bundle_export_objects;
DROP TABLE public.knowledge_bundle_export_records;
DROP TABLE public.knowledge_bundle_exports;
DROP TABLE public.knowledge_export_intents;

DROP OWNED BY context_use_import_owner;
DROP ROLE context_use_import_owner;
