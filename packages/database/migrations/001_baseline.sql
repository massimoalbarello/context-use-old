-- Context Use hypermedia database baseline.
--
-- This migration creates the complete current schema for a new PostgreSQL 17
-- database. Existing installations move to this ledger entry only after the
-- migrator verifies the exact completed predecessor ledger; the SQL below is
-- never replayed over their documents, public artifacts, or object metadata.

DO $$
DECLARE
  role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY[
    'context_use_auth',
    'context_use_dashboard',
    'context_use_mcp',
    'context_use_public',
    'context_use_confirmation',
    'context_use_storage',
    'context_use_backup'
  ] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format(
        'CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS',
        role_name
      );
    ELSE
      EXECUTE format(
        'ALTER ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS',
        role_name
      );
    END IF;
    EXECUTE format('ALTER ROLE %I SET search_path TO pg_catalog, public', role_name);
  END LOOP;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='context_use_corpus') THEN
    CREATE ROLE context_use_corpus NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
      INHERIT NOREPLICATION NOBYPASSRLS;
  ELSE
    ALTER ROLE context_use_corpus NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
      INHERIT NOREPLICATION NOBYPASSRLS;
  END IF;
  ALTER ROLE context_use_corpus SET search_path TO pg_catalog, public;

  FOREACH role_name IN ARRAY ARRAY[
    'context_use_boundary_owner',
    'context_use_document_history_owner',
    'context_use_projection_owner',
    'context_use_publication_lock_owner',
    'context_use_storage_owner'
  ] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format(
        'CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS',
        role_name
      );
    ELSE
      EXECUTE format(
        'ALTER ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS',
        role_name
      );
    END IF;
    EXECUTE format('ALTER ROLE %I SET search_path TO pg_catalog, public', role_name);
  END LOOP;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='context_use_reset_owner') THEN
    CREATE ROLE context_use_reset_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
      NOINHERIT NOREPLICATION NOBYPASSRLS;
  ELSE
    ALTER ROLE context_use_reset_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
      NOINHERIT NOREPLICATION NOBYPASSRLS;
  END IF;
  ALTER ROLE context_use_reset_owner RESET search_path;

  EXECUTE format(
    'REVOKE CONNECT,TEMPORARY,CREATE ON DATABASE %I FROM PUBLIC',
    current_database()
  );
  EXECUTE format(
    'GRANT CONNECT ON DATABASE %I TO context_use_auth,context_use_dashboard,context_use_mcp,context_use_public,context_use_confirmation,context_use_storage,context_use_backup,context_use_corpus',
    current_database()
  );
END;
$$;

GRANT context_use_dashboard TO context_use_corpus;


-- Dumped from database version 17.11
-- Dumped by pg_dump version 17.11

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', true);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: pgcrypto; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;


--
-- Name: actor_kind; Type: TYPE; Schema: public; Owner: postgres
--

CREATE TYPE public.actor_kind AS ENUM (
    'dashboard',
    'mcp'
);


ALTER TYPE public.actor_kind OWNER TO postgres;

--
-- Name: confirmation_intent_kind; Type: TYPE; Schema: public; Owner: postgres
--

CREATE TYPE public.confirmation_intent_kind AS ENUM (
    'publication',
    'knowledge_export',
    'page_deletion',
    'knowledge_import'
);


ALTER TYPE public.confirmation_intent_kind OWNER TO postgres;

--
-- Name: hypermedia_document_authority; Type: TYPE; Schema: public; Owner: postgres
--

CREATE TYPE public.hypermedia_document_authority AS ENUM (
    'source',
    'knowledge'
);


ALTER TYPE public.hypermedia_document_authority OWNER TO postgres;

--
-- Name: hypermedia_document_representation; Type: TYPE; Schema: public; Owner: postgres
--

CREATE TYPE public.hypermedia_document_representation AS ENUM (
    'markdown',
    'asset'
);


ALTER TYPE public.hypermedia_document_representation OWNER TO postgres;

--
-- Name: knowledge_revision_contract_provenance; Type: TYPE; Schema: public; Owner: postgres
--

CREATE TYPE public.knowledge_revision_contract_provenance AS ENUM (
    'authored',
    'imported'
);


ALTER TYPE public.knowledge_revision_contract_provenance OWNER TO postgres;

--
-- Name: knowledge_revision_link_contract; Type: TYPE; Schema: public; Owner: postgres
--

CREATE TYPE public.knowledge_revision_link_contract AS ENUM (
    'generic_document_v1'
);


ALTER TYPE public.knowledge_revision_link_contract OWNER TO postgres;

--
-- Name: private_document_kind; Type: TYPE; Schema: public; Owner: postgres
--

CREATE TYPE public.private_document_kind AS ENUM (
    'knowledge',
    'record',
    'asset'
);


ALTER TYPE public.private_document_kind OWNER TO postgres;

--
-- Name: private_document_lifecycle; Type: TYPE; Schema: public; Owner: postgres
--

CREATE TYPE public.private_document_lifecycle AS ENUM (
    'active',
    'archived',
    'deleted'
);


ALTER TYPE public.private_document_lifecycle OWNER TO postgres;

--
-- Name: private_document_operational_role; Type: TYPE; Schema: public; Owner: postgres
--

CREATE TYPE public.private_document_operational_role AS ENUM (
    'global_guide',
    'automation_instructions',
    'automation_state',
    'directory_hub'
);


ALTER TYPE public.private_document_operational_role OWNER TO postgres;

--
-- Name: public_artifact_allocation_kind; Type: TYPE; Schema: public; Owner: postgres
--

CREATE TYPE public.public_artifact_allocation_kind AS ENUM (
    'retained_page',
    'publication_intent',
    'retained_publication'
);


ALTER TYPE public.public_artifact_allocation_kind OWNER TO postgres;

--
-- Name: public_artifact_origin; Type: TYPE; Schema: public; Owner: postgres
--

CREATE TYPE public.public_artifact_origin AS ENUM (
    'ordinary',
    'retained',
    'alias_hub'
);


ALTER TYPE public.public_artifact_origin OWNER TO postgres;

--
-- Name: public_route_kind; Type: TYPE; Schema: public; Owner: postgres
--

CREATE TYPE public.public_route_kind AS ENUM (
    'page',
    'directory',
    'markdown',
    'asset'
);


ALTER TYPE public.public_route_kind OWNER TO postgres;

--
-- Name: public_route_state; Type: TYPE; Schema: public; Owner: postgres
--

CREATE TYPE public.public_route_state AS ENUM (
    'unassigned',
    'inactive',
    'active'
);


ALTER TYPE public.public_route_state OWNER TO postgres;

--
-- Name: publication_action; Type: TYPE; Schema: public; Owner: postgres
--

CREATE TYPE public.publication_action AS ENUM (
    'publish',
    'unpublish'
);


ALTER TYPE public.publication_action OWNER TO postgres;

--
-- Name: publication_target; Type: TYPE; Schema: public; Owner: postgres
--

CREATE TYPE public.publication_target AS ENUM (
    'page',
    'asset'
);


ALTER TYPE public.publication_target OWNER TO postgres;

--
-- Name: retained_public_artifact_kind; Type: TYPE; Schema: public; Owner: postgres
--

CREATE TYPE public.retained_public_artifact_kind AS ENUM (
    'page',
    'asset',
    'alias_hub'
);


ALTER TYPE public.retained_public_artifact_kind OWNER TO postgres;

--
-- Name: assert_private_uuid_available(uuid); Type: FUNCTION; Schema: public; Owner: context_use_boundary_owner
--

CREATE FUNCTION public.assert_private_uuid_available(p_uuid uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
BEGIN
  PERFORM lock_public_uuid_namespace(p_uuid);
  IF public_uuid_has_reserved_public_identity(p_uuid)
     OR public_uuid_has_legacy_alias_token(p_uuid)
     OR public_uuid_has_artifact_identity(p_uuid) THEN
    RAISE EXCEPTION 'private UUID conflicts with the permanent public namespace'
      USING ERRCODE='23505';
  END IF;
END;
$$;


ALTER FUNCTION public.assert_private_uuid_available(p_uuid uuid) OWNER TO context_use_boundary_owner;

--
-- Name: assert_public_metadata_safe(public.publication_target, text, text, text); Type: FUNCTION; Schema: public; Owner: context_use_boundary_owner
--

CREATE FUNCTION public.assert_public_metadata_safe(p_target_kind public.publication_target, p_title text, p_summary text, p_filename text) RETURNS void
    LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE
    SET search_path TO 'pg_catalog', 'public'
    AS $$
BEGIN
  IF p_target_kind='page' THEN
    IF NOT public_metadata_is_safe(p_title)
       OR NOT public_metadata_is_safe(p_summary)
       OR p_filename IS NOT NULL THEN
      RAISE EXCEPTION 'page public metadata contains a private reference marker'
        USING ERRCODE='22023';
    END IF;
  ELSIF p_target_kind='asset' THEN
    IF p_title IS NOT NULL OR p_summary IS NOT NULL
       OR NOT public_metadata_is_safe(p_filename)
       OR p_filename IN ('.','..')
       OR position('/' IN p_filename)>0
       OR position(chr(92) IN p_filename)>0 THEN
      RAISE EXCEPTION 'asset public metadata contains a private reference marker'
        USING ERRCODE='22023';
    END IF;
  ELSE
    RAISE EXCEPTION 'publication target kind is invalid' USING ERRCODE='22023';
  END IF;
END;
$$;


ALTER FUNCTION public.assert_public_metadata_safe(p_target_kind public.publication_target, p_title text, p_summary text, p_filename text) OWNER TO context_use_boundary_owner;

--
-- Name: assert_public_uuid_available(uuid, uuid, public.publication_target); Type: FUNCTION; Schema: public; Owner: context_use_boundary_owner
--

CREATE FUNCTION public.assert_public_uuid_available(p_uuid uuid, p_original_document_id uuid, p_resource_kind public.publication_target) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
DECLARE namespace_uuid uuid;
BEGIN
  FOR namespace_uuid IN
    SELECT DISTINCT value FROM unnest(ARRAY[p_uuid,p_original_document_id]) value
    WHERE value IS NOT NULL ORDER BY value
  LOOP
    PERFORM lock_public_uuid_namespace(namespace_uuid);
  END LOOP;
  IF public_uuid_has_private_identity(p_uuid)
     OR public_uuid_has_artifact_identity(p_uuid)
     OR EXISTS (
       SELECT 1 FROM public_namespace_conflicts conflict
       WHERE conflict.namespace_uuid=p_uuid AND conflict.resolved_at IS NULL
     ) THEN
    RAISE EXCEPTION 'public UUID conflicts with a private or artifact identity'
      USING ERRCODE='23505';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public_resources resource
    WHERE resource.public_id=p_uuid AND (
      resource.original_document_id IS DISTINCT FROM p_original_document_id
      OR resource.resource_kind IS DISTINCT FROM p_resource_kind
    )
  ) THEN
    RAISE EXCEPTION 'public UUID is permanently assigned to another resource'
      USING ERRCODE='23505';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public_resources resource
    WHERE resource.original_document_id=p_original_document_id
      AND resource.public_id<>p_uuid
  ) THEN
    RAISE EXCEPTION 'private document is assigned another permanent public UUID'
      USING ERRCODE='23505';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public_route_aliases alias
    WHERE canonical_legacy_alias_uuid(alias.alias_path)=p_uuid AND (
      alias.public_id<>p_uuid
      OR canonical_legacy_alias_kind(alias.alias_path)<>alias.route_kind
      OR (p_resource_kind='page' AND alias.route_kind NOT IN ('page','markdown'))
      OR (p_resource_kind='asset' AND alias.route_kind<>'asset')
    )
  ) THEN
    RAISE EXCEPTION 'public UUID is shadowed by a legacy route alias'
      USING ERRCODE='23505';
  END IF;
END;
$$;


ALTER FUNCTION public.assert_public_uuid_available(p_uuid uuid, p_original_document_id uuid, p_resource_kind public.publication_target) OWNER TO context_use_boundary_owner;

--
-- Name: assert_publication_intent_current(uuid, boolean); Type: FUNCTION; Schema: public; Owner: context_use_boundary_owner
--

CREATE FUNCTION public.assert_publication_intent_current(p_intent_id uuid, p_require_staging boolean DEFAULT false) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    SET jit TO 'off'
    AS $$
DECLARE
  intent publication_intents%ROWTYPE;
  mapped_public_id uuid;
  mapped_document_id uuid;
  current_visibility_generation bigint;
  current_target_generation bigint;
  current_source_fingerprint text;
  current_projected_ids uuid[];
  current_projection_receipt text;
  current_public_title text;
  current_public_summary text;
  current_public_filename text;
  current_public_content_type text;
  current_asset_size_bytes bigint;
  current_public_duration_seconds numeric;
BEGIN
  SELECT * INTO intent
  FROM publication_intents
  WHERE id=p_intent_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'canonical publication intent not found' USING ERRCODE='P0002';
  END IF;
  IF intent.confirmed_at IS NOT NULL OR intent.cancelled_at IS NOT NULL
     OR intent.expires_at<=now() THEN
    RAISE EXCEPTION 'canonical publication intent is inactive'
      USING ERRCODE='22023';
  END IF;

  SELECT generation INTO current_target_generation
  FROM publication_target_generations
  WHERE target_kind=intent.target_kind
    AND target_document_id=intent.target_document_id;
  IF current_target_generation IS DISTINCT FROM intent.expected_target_generation THEN
    RAISE EXCEPTION 'canonical publication target changed after intent creation'
      USING ERRCODE='40001';
  END IF;

  SELECT public_id,document_id INTO mapped_public_id,mapped_document_id
  FROM public_resources
  WHERE original_document_id=intent.target_document_id
    AND resource_kind=intent.target_kind;
  IF mapped_public_id IS NOT NULL
     AND mapped_document_id IS DISTINCT FROM intent.target_document_id THEN
    RAISE EXCEPTION 'canonical publication resource mapping is detached'
      USING ERRCODE='23514';
  END IF;
  IF mapped_public_id IS NOT NULL THEN
    SELECT generation INTO current_visibility_generation
    FROM public_visibility_generations WHERE public_id=mapped_public_id;
  ELSE
    current_visibility_generation := 0;
  END IF;
  IF current_visibility_generation IS DISTINCT FROM intent.expected_visibility_generation
     OR (intent.expected_visibility_generation=0 AND mapped_public_id IS NOT NULL)
     OR (intent.action='publish' AND mapped_public_id IS NOT NULL
       AND mapped_public_id IS DISTINCT FROM intent.candidate_public_id) THEN
    RAISE EXCEPTION 'canonical publication visibility changed after intent creation'
      USING ERRCODE='40001';
  END IF;
  IF publication_visibility_state_hash(
       intent.target_kind,intent.target_document_id,
       coalesce(mapped_public_id,intent.candidate_public_id)
     ) IS DISTINCT FROM intent.expected_visibility_state_hash THEN
    RAISE EXCEPTION 'canonical publication state changed after intent creation'
      USING ERRCODE='40001';
  END IF;

  IF intent.target_kind='page' THEN
    IF NOT EXISTS (
      SELECT 1
      FROM knowledge_pages page
      JOIN hypermedia_documents document ON document.id=page.id
      WHERE page.id=intent.target_document_id
        AND page.archived_at IS NULL
        AND document.authority='knowledge'
        AND document.representation='markdown'
        AND (intent.action='unpublish'
          OR page.current_version_id=intent.expected_revision_id)
    ) THEN
      RAISE EXCEPTION 'canonical publication page is no longer current and active'
        USING ERRCODE='40001';
    END IF;
    IF intent.action='publish' THEN
      IF publication_target_is_operational(intent.target_document_id) THEN
        RAISE EXCEPTION 'operational control documents cannot be published'
          USING ERRCODE='23514';
      END IF;
      SELECT title,summary INTO current_public_title,current_public_summary
      FROM knowledge_page_versions
      WHERE id=intent.expected_revision_id
        AND page_id=intent.target_document_id;
      PERFORM assert_public_metadata_safe(
        'page',current_public_title,current_public_summary,NULL
      );
      current_source_fingerprint := publication_source_fingerprint(
        'page',intent.target_document_id,intent.expected_revision_id
      );
      current_projected_ids := publication_projected_target_ids(
        intent.target_document_id,intent.expected_revision_id,
        intent.candidate_public_id
      );
      current_projection_receipt := publication_projection_receipt_hash(
        intent.target_document_id,intent.expected_revision_id,
        intent.candidate_public_id,current_source_fingerprint
      );
      IF current_source_fingerprint IS DISTINCT FROM intent.expected_source_fingerprint
         OR current_projected_ids IS DISTINCT FROM intent.projected_target_public_ids
         OR current_projection_receipt IS DISTINCT FROM intent.projection_receipt_hash
         OR publication_projection_has_namespace_conflict(
           intent.target_document_id,intent.expected_revision_id,
           intent.candidate_public_id
         ) THEN
        RAISE EXCEPTION 'canonical publication source projection changed'
          USING ERRCODE='40001';
      END IF;
    END IF;
  ELSE
    IF NOT EXISTS (
      SELECT 1 FROM assets
      WHERE id=intent.target_document_id AND deleted_at IS NULL
    ) THEN
      RAISE EXCEPTION 'canonical publication asset is no longer active'
        USING ERRCODE='40001';
    END IF;
    IF intent.action='publish' THEN
      SELECT filename,content_type,size_bytes,duration_seconds
      INTO current_public_filename,current_public_content_type,
        current_asset_size_bytes,current_public_duration_seconds
      FROM assets WHERE id=intent.target_document_id;
      PERFORM assert_public_metadata_safe(
        'asset',NULL,NULL,current_public_filename
      );
      IF NOT public_metadata_is_safe(current_public_content_type)
         OR length(current_public_content_type)>255
         OR current_asset_size_bytes>5000000000
         OR NOT public_duration_is_safe(
           current_public_duration_seconds
         ) THEN
        RAISE EXCEPTION 'asset public metadata is not safely representable'
          USING ERRCODE='22023';
      END IF;
      current_source_fingerprint := publication_source_fingerprint(
        'asset',intent.target_document_id,NULL
      );
      IF current_source_fingerprint IS DISTINCT FROM intent.expected_source_fingerprint THEN
        RAISE EXCEPTION 'canonical publication asset source changed'
          USING ERRCODE='40001';
      END IF;
    END IF;
  END IF;

  IF intent.action='publish' AND EXISTS (
    SELECT 1 FROM blocking_public_namespace_conflicts conflict
    WHERE conflict.namespace_uuid=intent.target_document_id
       OR conflict.namespace_uuid=intent.expected_revision_id
       OR conflict.namespace_uuid=coalesce(
         mapped_public_id,intent.candidate_public_id
       )
       OR conflict.namespace_uuid=ANY(intent.projected_target_public_ids)
  ) THEN
    RAISE EXCEPTION 'canonical publication has an unresolved namespace conflict'
      USING ERRCODE='23505';
  END IF;

  IF p_require_staging AND intent.action='publish' THEN
    PERFORM assert_publication_staging_exact(intent.id);
  END IF;
END;
$$;


ALTER FUNCTION public.assert_publication_intent_current(p_intent_id uuid, p_require_staging boolean) OWNER TO context_use_boundary_owner;

--
-- Name: assert_publication_staging_exact(uuid); Type: FUNCTION; Schema: public; Owner: context_use_boundary_owner
--

CREATE FUNCTION public.assert_publication_staging_exact(p_intent_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    SET jit TO 'off'
    SET "TimeZone" TO 'UTC'
    AS $$
DECLARE
  intent publication_intents%ROWTYPE;
  staging publication_artifact_staging%ROWTYPE;
  source_title text;
  source_summary text;
  source_last_edited_at timestamptz;
  source_filename text;
  source_content_type text;
  source_body_size_bytes bigint;
  source_body_content_hash text;
  source_width integer;
  source_height integer;
  source_duration_seconds numeric;
  expected_token text;
BEGIN
  SELECT * INTO intent
  FROM publication_intents stored WHERE stored.id=p_intent_id;
  SELECT * INTO staging
  FROM publication_artifact_staging stored
  WHERE stored.intent_id=p_intent_id;
  IF intent.id IS NULL OR intent.action<>'publish' OR staging.intent_id IS NULL THEN
    RAISE EXCEPTION 'canonical publication artifact is not staged'
      USING ERRCODE='55000';
  END IF;

  IF intent.target_kind='page' THEN
    SELECT version.title,version.summary,version.created_at,
      revision.body_size_bytes::bigint,revision.body_content_hash
    INTO source_title,source_summary,source_last_edited_at,
      source_body_size_bytes,source_body_content_hash
    FROM hypermedia_document_revisions revision
    JOIN knowledge_page_versions version
      ON version.id=revision.id AND version.page_id=revision.document_id
    WHERE revision.id=intent.expected_revision_id
      AND revision.document_id=intent.target_document_id;
  ELSE
    SELECT asset.filename,asset.content_type,asset.size_bytes,
      asset.content_hash,asset.width,asset.height,asset.duration_seconds
    INTO source_filename,source_content_type,source_body_size_bytes,
      source_body_content_hash,source_width,source_height,
      source_duration_seconds
    FROM assets asset WHERE asset.id=intent.target_document_id;
  END IF;

  expected_token := publication_representation_token(
    jsonb_build_object(
      'target_kind',intent.target_kind,
      'candidate_public_id',intent.candidate_public_id,
      'artifact_id',intent.candidate_artifact_id,
      'source_fingerprint',intent.expected_source_fingerprint,
      'body_object_key',intent.candidate_object_key,
      'body_size_bytes',staging.body_size_bytes,
      'body_content_hash',staging.body_content_hash,
      'public_title',source_title,
      'public_summary',source_summary,
      'public_last_edited_at',source_last_edited_at,
      'public_filename',source_filename,
      'public_content_type',source_content_type,
      'public_width',source_width,
      'public_height',source_height,
      'public_duration_seconds',source_duration_seconds,
      'projected_target_public_ids',intent.projected_target_public_ids,
      'observed_public_uuid_tokens',intent.projected_target_public_ids,
      'projection_receipt_hash',intent.projection_receipt_hash
    )
  );

  IF staging.target_kind IS DISTINCT FROM intent.target_kind
     OR staging.candidate_public_id IS DISTINCT FROM intent.candidate_public_id
     OR staging.artifact_id IS DISTINCT FROM intent.candidate_artifact_id
     OR staging.body_object_key IS DISTINCT FROM intent.candidate_object_key
     OR staging.projected_target_public_ids IS DISTINCT FROM
       intent.projected_target_public_ids
     OR staging.observed_public_uuid_tokens IS DISTINCT FROM
       intent.projected_target_public_ids
     OR staging.projection_receipt_hash IS DISTINCT FROM
       intent.projection_receipt_hash
     OR staging.allocation_kind<>'publication_intent'
     OR staging.allocation_id IS DISTINCT FROM intent.id
     OR staging.representation_token IS DISTINCT FROM expected_token
     OR NOT EXISTS (
       SELECT 1 FROM public_representation_token_reservations reservation
       WHERE reservation.representation_token=staging.representation_token
         AND reservation.artifact_id=staging.artifact_id
         AND reservation.resource_kind=staging.target_kind
     ) THEN
    RAISE EXCEPTION 'canonical publication staging evidence is not exact'
      USING ERRCODE='23514';
  END IF;

  IF intent.target_kind='page' THEN
    IF staging.body_size_bytes>4000000
       OR staging.public_title IS DISTINCT FROM source_title
       OR staging.public_summary IS DISTINCT FROM source_summary
       OR staging.public_last_edited_at IS DISTINCT FROM source_last_edited_at
       OR staging.public_filename IS NOT NULL
       OR staging.public_content_type IS NOT NULL
       OR staging.public_width IS NOT NULL
       OR staging.public_height IS NOT NULL
       OR staging.public_duration_seconds IS NOT NULL THEN
      RAISE EXCEPTION 'canonical page staging evidence is not exact'
        USING ERRCODE='23514';
    END IF;
  ELSE
    IF staging.body_size_bytes IS DISTINCT FROM source_body_size_bytes
       OR staging.body_content_hash IS DISTINCT FROM source_body_content_hash
       OR staging.public_title IS NOT NULL OR staging.public_summary IS NOT NULL
       OR staging.public_last_edited_at IS NOT NULL
       OR staging.public_filename IS DISTINCT FROM source_filename
       OR staging.public_content_type IS DISTINCT FROM source_content_type
       OR staging.public_width IS DISTINCT FROM source_width
       OR staging.public_height IS DISTINCT FROM source_height
       OR staging.public_duration_seconds::text IS DISTINCT FROM
         source_duration_seconds::text THEN
      RAISE EXCEPTION 'canonical asset staging evidence is not exact'
        USING ERRCODE='23514';
    END IF;
  END IF;
END;
$$;


ALTER FUNCTION public.assert_publication_staging_exact(p_intent_id uuid) OWNER TO context_use_boundary_owner;

--
-- Name: begin_hypermedia_bootstrap(); Type: FUNCTION; Schema: public; Owner: context_use_boundary_owner
--

CREATE FUNCTION public.begin_hypermedia_bootstrap() RETURNS TABLE(document_kind text, document_id uuid, revision_id uuid)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
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


ALTER FUNCTION public.begin_hypermedia_bootstrap() OWNER TO context_use_boundary_owner;

--
-- Name: begin_publication_intent(uuid, public.publication_action, public.publication_target, uuid, uuid, text, text); Type: FUNCTION; Schema: public; Owner: context_use_boundary_owner
--

CREATE FUNCTION public.begin_publication_intent(p_intent_id uuid, p_action public.publication_action, p_target_kind public.publication_target, p_target_document_id uuid, p_expected_revision_id uuid, p_owner_user_id text, p_session_id text) RETURNS TABLE(id uuid, action public.publication_action, target_kind public.publication_target, target_document_id uuid, expected_revision_id uuid, candidate_public_id uuid, expires_at timestamp with time zone)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    SET jit TO 'off'
    AS $$
DECLARE
  stored publication_intents%ROWTYPE;
  mapped_public_id uuid;
  mapped_document_id uuid;
  allocated_public_id uuid;
  allocated_artifact_id uuid;
  allocated_object_key text;
  source_fingerprint text;
  projected_ids uuid[] := '{}'::uuid[];
  projection_receipt text;
  visibility_generation bigint := 0;
  visibility_hash text;
  target_generation bigint;
  page_title text;
  page_summary text;
  asset_filename text;
  asset_content_type text;
  asset_size_bytes bigint;
  asset_duration_seconds numeric;
  attempt integer;
BEGIN
  IF p_intent_id IS NULL OR p_action IS NULL OR p_target_kind IS NULL
     OR p_target_document_id IS NULL
     OR p_owner_user_id IS DISTINCT FROM 'context-use-owner'
     OR p_session_id IS NULL OR length(p_session_id) NOT BETWEEN 1 AND 512
     OR (p_action='publish' AND p_target_kind='page'
       AND p_expected_revision_id IS NULL)
     OR (p_target_kind='asset' AND p_expected_revision_id IS NOT NULL)
     OR (p_action='unpublish' AND p_expected_revision_id IS NOT NULL) THEN
    RAISE EXCEPTION 'valid canonical publication intent input is required'
      USING ERRCODE='22023';
  END IF;

  PERFORM pg_advisory_xact_lock_shared(
    hashtextextended('context-use:knowledge-lifecycle',0)
  );
  -- A lost-response retry returns the immutable original plan even if its
  -- source has since changed. Only a genuinely new UUID enters target locks
  -- and allocation; confirmation still rejects an expired/stale plan.
  SELECT * INTO stored
  FROM publication_intents intent
  WHERE intent.id=p_intent_id
  FOR UPDATE;
  IF FOUND THEN
    IF stored.action IS DISTINCT FROM p_action
       OR stored.target_kind IS DISTINCT FROM p_target_kind
       OR stored.target_document_id IS DISTINCT FROM p_target_document_id
       OR stored.expected_revision_id IS DISTINCT FROM p_expected_revision_id
       OR stored.owner_user_id IS DISTINCT FROM p_owner_user_id
       OR stored.session_id IS DISTINCT FROM p_session_id THEN
      RAISE EXCEPTION 'canonical publication intent retry does not match'
        USING ERRCODE='23505';
    END IF;
    RETURN QUERY SELECT stored.id,stored.action,stored.target_kind,
      stored.target_document_id,stored.expected_revision_id,
      stored.candidate_public_id,stored.expires_at;
    RETURN;
  END IF;

  PERFORM lock_publication_context(
    p_target_kind,p_target_document_id,p_expected_revision_id
  );
  -- Serialize the cross-family UUID only after target locks, matching the
  -- established lock order. Recheck after the wait so concurrent exact
  -- retries share one allocation instead of leaving an orphan reservation.
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'publication-intent-uuid:'||p_intent_id::text,0
  ));
  SELECT * INTO stored
  FROM publication_intents intent
  WHERE intent.id=p_intent_id
  FOR UPDATE;
  IF FOUND THEN
    IF stored.action IS DISTINCT FROM p_action
       OR stored.target_kind IS DISTINCT FROM p_target_kind
       OR stored.target_document_id IS DISTINCT FROM p_target_document_id
       OR stored.expected_revision_id IS DISTINCT FROM p_expected_revision_id
       OR stored.owner_user_id IS DISTINCT FROM p_owner_user_id
       OR stored.session_id IS DISTINCT FROM p_session_id THEN
      RAISE EXCEPTION 'canonical publication intent retry does not match'
        USING ERRCODE='23505';
    END IF;
    RETURN QUERY SELECT stored.id,stored.action,stored.target_kind,
      stored.target_document_id,stored.expected_revision_id,
      stored.candidate_public_id,stored.expires_at;
    RETURN;
  END IF;
  IF EXISTS (
    SELECT 1 FROM publication_intent_id_reservations
    WHERE intent_id=p_intent_id
  ) THEN
    RAISE EXCEPTION 'publication intent UUID cannot be reused'
      USING ERRCODE='23505';
  END IF;

  SELECT generation INTO target_generation
  FROM publication_target_generations generation
  WHERE generation.target_kind=p_target_kind
    AND generation.target_document_id=p_target_document_id;
  IF target_generation IS NULL THEN
    RAISE EXCEPTION 'publication target generation is missing'
      USING ERRCODE='23503';
  END IF;
  SELECT resource.public_id,resource.document_id
  INTO mapped_public_id,mapped_document_id
  FROM public_resources resource
  WHERE resource.original_document_id=p_target_document_id
    AND resource.resource_kind=p_target_kind;
  IF mapped_public_id IS NOT NULL
     AND mapped_document_id IS DISTINCT FROM p_target_document_id THEN
    RAISE EXCEPTION 'canonical publication resource mapping is detached'
      USING ERRCODE='23514';
  END IF;
  IF mapped_public_id IS NOT NULL THEN
    SELECT generation.generation INTO visibility_generation
    FROM public_visibility_generations generation
    WHERE generation.public_id=mapped_public_id;
    IF visibility_generation IS NULL THEN
      RAISE EXCEPTION 'public visibility generation is missing'
        USING ERRCODE='23503';
    END IF;
  END IF;

  IF p_target_kind='page' THEN
    IF p_action='publish' THEN
      SELECT version.title,version.summary
      INTO page_title,page_summary
      FROM knowledge_pages page
      JOIN hypermedia_documents document
        ON document.id=page.id
       AND document.authority='knowledge'
       AND document.representation='markdown'
      JOIN hypermedia_document_revisions revision
        ON revision.id=page.current_version_id AND revision.document_id=page.id
      JOIN knowledge_page_versions version
        ON version.id=revision.id AND version.page_id=page.id
      JOIN knowledge_revision_contracts contract
        ON contract.revision_id=revision.id AND contract.document_id=page.id
       AND contract.link_contract='generic_document_v1'
      WHERE page.id=p_target_document_id
        AND page.current_version_id=p_expected_revision_id
        AND page.archived_at IS NULL;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'page publication requires its active current generic revision'
          USING ERRCODE='23514';
      END IF;
      IF publication_target_is_operational(p_target_document_id) THEN
        RAISE EXCEPTION 'operational control documents cannot be published'
          USING ERRCODE='23514';
      END IF;
      PERFORM assert_public_metadata_safe(
        'page',page_title,page_summary,NULL
      );
    ELSIF NOT EXISTS (
      SELECT 1 FROM knowledge_pages page
      WHERE page.id=p_target_document_id AND page.archived_at IS NULL
    ) THEN
      RAISE EXCEPTION 'page unpublication target is not active'
        USING ERRCODE='23514';
    END IF;
  ELSE
    SELECT asset.filename,asset.content_type,asset.size_bytes,
      asset.duration_seconds
    INTO asset_filename,asset_content_type,asset_size_bytes,
      asset_duration_seconds
    FROM assets asset
    WHERE asset.id=p_target_document_id AND asset.deleted_at IS NULL;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'asset publication target is not active'
        USING ERRCODE='23514';
    END IF;
    IF p_action='publish' THEN
      PERFORM assert_public_metadata_safe(
        'asset',NULL,NULL,asset_filename
      );
      IF NOT public_metadata_is_safe(asset_content_type)
         OR length(asset_content_type)>255
         OR asset_size_bytes>5000000000
         OR NOT public_duration_is_safe(asset_duration_seconds) THEN
        RAISE EXCEPTION 'asset public metadata is not safely representable'
          USING ERRCODE='22023';
      END IF;
    END IF;
  END IF;

  IF p_action='unpublish' THEN
    IF mapped_public_id IS NULL OR NOT (
      (p_target_kind='page' AND EXISTS (
        SELECT 1 FROM page_publications publication
        WHERE publication.public_id=mapped_public_id
      )) OR
      (p_target_kind='asset' AND EXISTS (
        SELECT 1 FROM asset_publications publication
        WHERE publication.public_id=mapped_public_id
      ))
    ) THEN
      RAISE EXCEPTION 'publication target is already private'
        USING ERRCODE='23514';
    END IF;
    allocated_public_id := NULL;
    visibility_hash := publication_visibility_state_hash(
      p_target_kind,p_target_document_id,mapped_public_id
    );
  ELSE
    allocated_public_id := mapped_public_id;
    IF allocated_public_id IS NULL THEN
      FOR attempt IN 1..32 LOOP
        allocated_public_id := gen_random_uuid();
        CONTINUE WHEN allocated_public_id IN (
          p_intent_id,p_target_document_id,p_expected_revision_id
        );
        BEGIN
          PERFORM assert_public_uuid_available(
            allocated_public_id,p_target_document_id,p_target_kind
          );
          EXIT;
        EXCEPTION WHEN unique_violation THEN
          allocated_public_id := NULL;
        END;
      END LOOP;
      IF allocated_public_id IS NULL THEN
        RAISE EXCEPTION 'could not allocate a public resource UUID'
          USING ERRCODE='54000';
      END IF;
    END IF;

    FOR attempt IN 1..32 LOOP
      allocated_artifact_id := gen_random_uuid();
      CONTINUE WHEN allocated_artifact_id IN (
        p_intent_id,p_target_document_id,p_expected_revision_id,
        allocated_public_id
      );
      allocated_object_key := CASE p_target_kind
        WHEN 'page' THEN
          'documents/public/'||allocated_artifact_id::text||'.md'
        WHEN 'asset' THEN
          'artifacts/public/'||allocated_artifact_id::text
      END;
      BEGIN
        PERFORM reserve_public_artifact_identity(
          allocated_artifact_id,allocated_object_key,
          'publication_intent',p_intent_id
        );
        EXIT;
      EXCEPTION WHEN unique_violation THEN
        allocated_artifact_id := NULL;
      END;
    END LOOP;
    IF allocated_artifact_id IS NULL THEN
      RAISE EXCEPTION 'could not allocate a public artifact UUID'
        USING ERRCODE='54000';
    END IF;

    source_fingerprint := publication_source_fingerprint(
      p_target_kind,p_target_document_id,p_expected_revision_id
    );
    IF source_fingerprint IS NULL THEN
      RAISE EXCEPTION 'publication source fingerprint is unavailable'
        USING ERRCODE='23514';
    END IF;
    IF p_target_kind='page' THEN
      projected_ids := publication_projected_target_ids(
        p_target_document_id,p_expected_revision_id,allocated_public_id
      );
      projection_receipt := publication_projection_receipt_hash(
        p_target_document_id,p_expected_revision_id,allocated_public_id,
        source_fingerprint
      );
    END IF;
    IF EXISTS (
      SELECT 1 FROM blocking_public_namespace_conflicts conflict
      WHERE conflict.namespace_uuid=p_target_document_id
         OR conflict.namespace_uuid=p_expected_revision_id
         OR conflict.namespace_uuid=allocated_public_id
         OR conflict.namespace_uuid=ANY(projected_ids)
    ) OR (p_target_kind='page'
      AND publication_projection_has_namespace_conflict(
        p_target_document_id,p_expected_revision_id,allocated_public_id
      )) THEN
      RAISE EXCEPTION 'publication has an unresolved namespace conflict'
        USING ERRCODE='23505';
    END IF;
    visibility_hash := publication_visibility_state_hash(
      p_target_kind,p_target_document_id,allocated_public_id
    );
  END IF;

  INSERT INTO publication_intents(
    id,action,target_kind,target_document_id,expected_revision_id,
    candidate_public_id,candidate_artifact_id,candidate_object_key,
    artifact_allocation_kind,artifact_allocation_id,
    projected_target_public_ids,projection_receipt_hash,
    owner_user_id,session_id,expires_at,expected_visibility_generation,
    expected_visibility_state_hash,expected_target_generation,
    expected_source_fingerprint
  ) VALUES (
    p_intent_id,p_action,p_target_kind,p_target_document_id,
    p_expected_revision_id,allocated_public_id,allocated_artifact_id,
    allocated_object_key,
    CASE WHEN p_action='publish'
      THEN 'publication_intent'::public_artifact_allocation_kind END,
    CASE WHEN p_action='publish' THEN p_intent_id END,
    projected_ids,projection_receipt,p_owner_user_id,p_session_id,
    now()+interval '5 minutes',visibility_generation,visibility_hash,
    target_generation,source_fingerprint
  );

  SELECT * INTO stored
  FROM publication_intents intent WHERE intent.id=p_intent_id;
  RETURN QUERY SELECT stored.id,stored.action,stored.target_kind,
    stored.target_document_id,stored.expected_revision_id,
    stored.candidate_public_id,stored.expires_at;
END;
$$;


ALTER FUNCTION public.begin_publication_intent(p_intent_id uuid, p_action public.publication_action, p_target_kind public.publication_target, p_target_document_id uuid, p_expected_revision_id uuid, p_owner_user_id text, p_session_id text) OWNER TO context_use_boundary_owner;

--
-- Name: bump_asset_publication_target_generation(); Type: FUNCTION; Schema: public; Owner: context_use_boundary_owner
--

CREATE FUNCTION public.bump_asset_publication_target_generation() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
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


ALTER FUNCTION public.bump_asset_publication_target_generation() OWNER TO context_use_boundary_owner;

--
-- Name: bump_page_publication_target_generation(); Type: FUNCTION; Schema: public; Owner: context_use_boundary_owner
--

CREATE FUNCTION public.bump_page_publication_target_generation() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
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


ALTER FUNCTION public.bump_page_publication_target_generation() OWNER TO context_use_boundary_owner;

--
-- Name: bump_pin_public_visibility(); Type: FUNCTION; Schema: public; Owner: context_use_boundary_owner
--

CREATE FUNCTION public.bump_pin_public_visibility() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
BEGIN
  PERFORM bump_public_visibility_generation(
    CASE WHEN TG_OP='DELETE' THEN OLD.public_id ELSE NEW.public_id END
  );
  RETURN NULL;
END;
$$;


ALTER FUNCTION public.bump_pin_public_visibility() OWNER TO context_use_boundary_owner;

--
-- Name: bump_public_visibility_generation(uuid); Type: FUNCTION; Schema: public; Owner: context_use_boundary_owner
--

CREATE FUNCTION public.bump_public_visibility_generation(p_public_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
BEGIN
  IF p_public_id IS NULL THEN RETURN; END IF;
  UPDATE public_visibility_generations
  SET generation=generation+1,updated_at=now()
  WHERE public_id=p_public_id AND generation<9223372036854775807;
  IF NOT FOUND THEN
    IF EXISTS (
      SELECT 1 FROM public_visibility_generations WHERE public_id=p_public_id
    ) THEN
      RAISE EXCEPTION 'public visibility generation exhausted'
        USING ERRCODE='22003';
    END IF;
    RAISE EXCEPTION 'public visibility generation is missing'
      USING ERRCODE='23503';
  END IF;
END;
$$;


ALTER FUNCTION public.bump_public_visibility_generation(p_public_id uuid) OWNER TO context_use_boundary_owner;

--
-- Name: bump_publication_target_generation(public.publication_target, uuid); Type: FUNCTION; Schema: public; Owner: context_use_boundary_owner
--

CREATE FUNCTION public.bump_publication_target_generation(p_target_kind public.publication_target, p_target_document_id uuid) RETURNS bigint
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
DECLARE
  next_generation bigint;
BEGIN
  IF p_target_kind IS NULL OR p_target_document_id IS NULL THEN
    RAISE EXCEPTION 'publication target identity is required'
      USING ERRCODE='22023';
  END IF;
  SELECT generation INTO next_generation
  FROM publication_target_generations
  WHERE target_kind=p_target_kind AND target_document_id=p_target_document_id
  FOR UPDATE;
  IF FOUND THEN
    IF next_generation=9223372036854775807 THEN
      RAISE EXCEPTION 'publication target generation exhausted'
        USING ERRCODE='22003';
    END IF;
    next_generation := next_generation+1;
    UPDATE publication_target_generations
    SET generation=next_generation,updated_at=now()
    WHERE target_kind=p_target_kind AND target_document_id=p_target_document_id;
  ELSE
    next_generation := 1;
    INSERT INTO publication_target_generations(
      target_kind,target_document_id,generation
    ) VALUES (p_target_kind,p_target_document_id,next_generation);
  END IF;
  RETURN next_generation;
END;
$$;


ALTER FUNCTION public.bump_publication_target_generation(p_target_kind public.publication_target, p_target_document_id uuid) OWNER TO context_use_boundary_owner;

--
-- Name: cancel_publication_intent(uuid, text, text); Type: FUNCTION; Schema: public; Owner: context_use_boundary_owner
--

CREATE FUNCTION public.cancel_publication_intent(p_intent_id uuid, p_owner_user_id text, p_session_id text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
DECLARE
  intent publication_intents%ROWTYPE;
BEGIN
  IF p_intent_id IS NULL OR p_owner_user_id IS NULL OR p_session_id IS NULL THEN
    RAISE EXCEPTION 'publication cancellation principal is required'
      USING ERRCODE='42501';
  END IF;
  PERFORM pg_advisory_xact_lock_shared(
    hashtextextended('context-use:knowledge-lifecycle',0)
  );
  SELECT * INTO intent
  FROM publication_intents WHERE id=p_intent_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'canonical publication intent not found' USING ERRCODE='P0002';
  END IF;
  IF intent.owner_user_id IS DISTINCT FROM p_owner_user_id
     OR intent.session_id IS DISTINCT FROM p_session_id THEN
    RAISE EXCEPTION 'canonical publication intent principal mismatch'
      USING ERRCODE='42501';
  END IF;
  IF intent.confirmed_at IS NOT NULL THEN
    RAISE EXCEPTION 'confirmed publication intent cannot be cancelled'
      USING ERRCODE='23514';
  END IF;
  IF intent.cancelled_at IS NULL THEN
    DELETE FROM confirmation_challenges
    WHERE intent_kind='publication' AND intent_id=intent.id;
    UPDATE publication_intents
    SET cancelled_at=now() WHERE id=intent.id;
  END IF;
END;
$$;


ALTER FUNCTION public.cancel_publication_intent(p_intent_id uuid, p_owner_user_id text, p_session_id text) OWNER TO context_use_boundary_owner;

--
-- Name: canonical_legacy_alias_kind(text); Type: FUNCTION; Schema: public; Owner: context_use_boundary_owner
--

CREATE FUNCTION public.canonical_legacy_alias_kind(p_alias_path text) RETURNS public.public_route_kind
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    SET search_path TO 'pg_catalog', 'public'
    AS $_$
  SELECT CASE
    WHEN p_alias_path ~ '^/p/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.]md$'
      THEN 'markdown'::public_route_kind
    WHEN p_alias_path ~ '^/p/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN 'page'::public_route_kind
    WHEN p_alias_path ~ '^/a/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN 'asset'::public_route_kind
    ELSE NULL
  END;
$_$;


ALTER FUNCTION public.canonical_legacy_alias_kind(p_alias_path text) OWNER TO context_use_boundary_owner;

--
-- Name: canonical_legacy_alias_uuid(text); Type: FUNCTION; Schema: public; Owner: context_use_boundary_owner
--

CREATE FUNCTION public.canonical_legacy_alias_uuid(p_alias_path text) RETURNS uuid
    LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE
    SET search_path TO 'pg_catalog'
    AS $_$
DECLARE
  matched text[];
BEGIN
  matched := regexp_match(
    p_alias_path,
    '^/p/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})([.]md)?$'
  );
  IF matched IS NOT NULL THEN RETURN matched[1]::uuid; END IF;
  matched := regexp_match(
    p_alias_path,
    '^/a/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'
  );
  IF matched IS NOT NULL THEN RETURN matched[1]::uuid; END IF;
  RETURN NULL;
END;
$_$;


ALTER FUNCTION public.canonical_legacy_alias_uuid(p_alias_path text) OWNER TO context_use_boundary_owner;

--
-- Name: canonical_public_uuid_set(uuid[]); Type: FUNCTION; Schema: public; Owner: context_use_boundary_owner
--

CREATE FUNCTION public.canonical_public_uuid_set(p_values uuid[]) RETURNS uuid[]
    LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE
    SET search_path TO 'pg_catalog'
    AS $$
DECLARE
  canonical uuid[];
BEGIN
  IF p_values IS NULL OR cardinality(p_values)>100000
     OR array_position(p_values,NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'public UUID receipt is invalid' USING ERRCODE='22023';
  END IF;
  SELECT coalesce(array_agg(value ORDER BY value),'{}'::uuid[])
  INTO canonical
  FROM (SELECT DISTINCT unnest(p_values) AS value) values;
  RETURN canonical;
END;
$$;


ALTER FUNCTION public.canonical_public_uuid_set(p_values uuid[]) OWNER TO context_use_boundary_owner;

--
-- Name: capture_archived_knowledge_document(); Type: FUNCTION; Schema: public; Owner: context_use_document_history_owner
--

CREATE FUNCTION public.capture_archived_knowledge_document() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
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


ALTER FUNCTION public.capture_archived_knowledge_document() OWNER TO context_use_document_history_owner;

--
-- Name: capture_deleted_current_page_version(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.capture_deleted_current_page_version() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
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


ALTER FUNCTION public.capture_deleted_current_page_version() OWNER TO postgres;

--
-- Name: capture_inserted_current_page_version(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.capture_inserted_current_page_version() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
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


ALTER FUNCTION public.capture_inserted_current_page_version() OWNER TO postgres;

--
-- Name: capture_updated_current_page_version(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.capture_updated_current_page_version() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
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


ALTER FUNCTION public.capture_updated_current_page_version() OWNER TO postgres;

--
-- Name: claim_knowledge_export_download(uuid, text, text); Type: FUNCTION; Schema: public; Owner: context_use_boundary_owner
--

CREATE FUNCTION public.claim_knowledge_export_download(p_intent_id uuid, p_owner_user_id text, p_session_id text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
DECLARE
  intent record;
BEGIN
  IF p_owner_user_id IS NULL OR p_session_id IS NULL THEN
    RAISE EXCEPTION 'export principal required' USING ERRCODE='42501';
  END IF;

  SELECT
    id,owner_user_id,session_id,expires_at,confirmed_at,download_started_at
  INTO intent
  FROM knowledge_export_intents
  WHERE id=p_intent_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'knowledge export intent not found' USING ERRCODE='P0002';
  END IF;
  IF intent.confirmed_at IS NULL THEN
    RAISE EXCEPTION 'knowledge export passkey confirmation required' USING ERRCODE='42501';
  END IF;
  IF intent.expires_at<=now() THEN
    RAISE EXCEPTION 'knowledge export intent expired' USING ERRCODE='22023';
  END IF;
  IF intent.owner_user_id IS DISTINCT FROM p_owner_user_id
     OR intent.session_id IS DISTINCT FROM p_session_id THEN
    RAISE EXCEPTION 'knowledge export principal mismatch' USING ERRCODE='42501';
  END IF;

  UPDATE knowledge_export_intents
  SET download_started_at=coalesce(download_started_at,now())
  WHERE id=p_intent_id;
END;
$$;


ALTER FUNCTION public.claim_knowledge_export_download(p_intent_id uuid, p_owner_user_id text, p_session_id text) OWNER TO context_use_boundary_owner;

--
-- Name: claim_publication_artifact(uuid, uuid); Type: FUNCTION; Schema: public; Owner: context_use_storage_owner
--

CREATE FUNCTION public.claim_publication_artifact(p_intent_id uuid, p_claim_token uuid) RETURNS TABLE(claim_token uuid, finalized boolean, artifact_id uuid, body_object_key text, body_size_bytes bigint, body_content_hash text, "authorization" jsonb)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    SET jit TO 'off'
    AS $$
DECLARE
  existing publication_object_claims%ROWTYPE;
  target record;
BEGIN
  IF p_intent_id IS NULL OR p_claim_token IS NULL THEN
    RAISE EXCEPTION 'publication allocation and claim token are required'
      USING ERRCODE='22023';
  END IF;
  SELECT * INTO existing
  FROM publication_object_claims claim
  WHERE claim.allocation_kind='publication_intent'
    AND claim.allocation_id=p_intent_id;
  IF FOUND AND existing.finalized_at IS NOT NULL THEN
    RETURN QUERY SELECT existing.claim_token,true,existing.artifact_id,
      existing.body_object_key,existing.body_size_bytes,
      existing.body_content_hash,NULL::jsonb;
    RETURN;
  END IF;

  SELECT * INTO target FROM get_publication_write_target(p_intent_id);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'publication write target was not returned'
      USING ERRCODE='P0002';
  END IF;
  IF existing.allocation_id IS NULL THEN
    INSERT INTO publication_object_claims(
      allocation_kind,allocation_id,artifact_id,body_object_key,claim_token
    ) VALUES (
      'publication_intent',p_intent_id,target.artifact_id,
      target.body_object_key,p_claim_token
    )
    ON CONFLICT (allocation_kind,allocation_id) DO NOTHING;
  END IF;
  SELECT * INTO existing
  FROM publication_object_claims claim
  WHERE claim.allocation_kind='publication_intent'
    AND claim.allocation_id=p_intent_id
  FOR UPDATE;
  IF NOT FOUND
     OR existing.artifact_id IS DISTINCT FROM target.artifact_id
     OR existing.body_object_key IS DISTINCT FROM target.body_object_key THEN
    RAISE EXCEPTION 'publication object claim does not match its allocation'
      USING ERRCODE='23505';
  END IF;
  RETURN QUERY SELECT existing.claim_token,false,existing.artifact_id,
    existing.body_object_key,NULL::bigint,NULL::text,to_jsonb(target);
END;
$$;


ALTER FUNCTION public.claim_publication_artifact(p_intent_id uuid, p_claim_token uuid) OWNER TO context_use_storage_owner;

--
-- Name: complete_hypermedia_bootstrap(); Type: FUNCTION; Schema: public; Owner: context_use_boundary_owner
--

CREATE FUNCTION public.complete_hypermedia_bootstrap() RETURNS timestamp with time zone
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    SET jit TO 'off'
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


ALTER FUNCTION public.complete_hypermedia_bootstrap() OWNER TO context_use_boundary_owner;

--
-- Name: confirm_knowledge_export_intent(uuid, text, text, text, integer, integer); Type: FUNCTION; Schema: public; Owner: context_use_boundary_owner
--

CREATE FUNCTION public.confirm_knowledge_export_intent(p_intent_id uuid, p_owner_user_id text, p_session_id text, p_credential_id text, p_expected_counter integer, p_new_counter integer) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
DECLARE
  intent record;
  intent_challenge text;
BEGIN
  IF p_intent_id IS NULL OR p_owner_user_id IS NULL OR p_session_id IS NULL
     OR p_credential_id IS NULL OR length(trim(p_credential_id))<1
     OR p_expected_counter IS NULL OR p_new_counter IS NULL THEN
    RAISE EXCEPTION 'verified export principal required' USING ERRCODE='42501';
  END IF;
  SELECT stored.id,stored.owner_user_id,stored.session_id,stored.expires_at,
    stored.confirmed_at,stored.download_started_at
  INTO intent
  FROM knowledge_export_intents stored WHERE stored.id=p_intent_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'knowledge export intent not found' USING ERRCODE='P0002';
  END IF;
  IF intent.confirmed_at IS NOT NULL OR intent.download_started_at IS NOT NULL THEN
    RAISE EXCEPTION 'knowledge export intent already used' USING ERRCODE='23505';
  END IF;
  IF intent.expires_at<=now() THEN
    RAISE EXCEPTION 'knowledge export intent expired' USING ERRCODE='22023';
  END IF;
  IF intent.owner_user_id IS DISTINCT FROM p_owner_user_id
     OR intent.session_id IS DISTINCT FROM p_session_id THEN
    RAISE EXCEPTION 'knowledge export principal mismatch' USING ERRCODE='42501';
  END IF;
  SELECT challenge.challenge INTO intent_challenge
  FROM confirmation_challenges challenge
  WHERE challenge.intent_kind='knowledge_export' AND challenge.intent_id=intent.id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'knowledge export challenge not issued' USING ERRCODE='42501';
  END IF;
  PERFORM consume_confirmation_challenge(
    'knowledge_export',intent.id,intent_challenge,intent.owner_user_id,
    p_credential_id,p_expected_counter,p_new_counter
  );
  UPDATE knowledge_export_intents
  SET confirmed_at=now(),expires_at=now()+interval '24 hours'
  WHERE id=intent.id;
END;
$$;


ALTER FUNCTION public.confirm_knowledge_export_intent(p_intent_id uuid, p_owner_user_id text, p_session_id text, p_credential_id text, p_expected_counter integer, p_new_counter integer) OWNER TO context_use_boundary_owner;

--
-- Name: confirm_page_deletion_intent(uuid, text, text, text, integer, integer); Type: FUNCTION; Schema: public; Owner: context_use_boundary_owner
--

CREATE FUNCTION public.confirm_page_deletion_intent(p_intent_id uuid, p_owner_user_id text, p_session_id text, p_credential_id text, p_expected_counter integer, p_new_counter integer) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
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


ALTER FUNCTION public.confirm_page_deletion_intent(p_intent_id uuid, p_owner_user_id text, p_session_id text, p_credential_id text, p_expected_counter integer, p_new_counter integer) OWNER TO context_use_boundary_owner;

--
-- Name: confirm_publication_intent(uuid, text, text, text, integer, integer); Type: FUNCTION; Schema: public; Owner: context_use_boundary_owner
--

CREATE FUNCTION public.confirm_publication_intent(p_intent_id uuid, p_owner_user_id text, p_session_id text, p_credential_id text, p_expected_counter integer, p_new_counter integer) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    SET jit TO 'off'
    AS $$
DECLARE
  publication_exists boolean;
  preliminary record;
  publication_intent publication_intents%ROWTYPE;
  staging publication_artifact_staging%ROWTYPE;
  mapped_public_id uuid;
  mapped_document_id uuid;
  mapped_resource_kind publication_target;
  intent_challenge text;
  namespace_uuid uuid;
  source_body_size_bytes bigint;
  source_body_content_hash text;
BEGIN
  IF p_intent_id IS NULL OR p_owner_user_id IS NULL OR p_session_id IS NULL
     OR p_credential_id IS NULL OR length(trim(p_credential_id))<1
     OR p_expected_counter IS NULL OR p_new_counter IS NULL THEN
    RAISE EXCEPTION 'verified publication principal required'
      USING ERRCODE='42501';
  END IF;

  PERFORM pg_advisory_xact_lock_shared(
    hashtextextended('context-use:knowledge-lifecycle',0)
  );
  SELECT EXISTS (
    SELECT 1 FROM publication_intent_id_reservations reservation
    JOIN publication_intents intent
      ON intent.id=reservation.intent_id
    WHERE reservation.intent_id=p_intent_id
  ) INTO publication_exists;
  IF NOT publication_exists THEN
    RAISE EXCEPTION 'publication intent not found' USING ERRCODE='P0002';
  END IF;

  IF publication_exists THEN
    -- Immutable, principal-bound confirmation is an idempotent terminal
    -- result. This fast path deliberately precedes expiry, target and passkey
    -- checks so a lost response never reapplies a later publication state.
    SELECT intent.id,intent.action,intent.target_kind,
      intent.target_document_id,intent.expected_revision_id,
      intent.candidate_public_id,intent.owner_user_id,intent.session_id,
      intent.expires_at,intent.confirmed_at,intent.cancelled_at
    INTO preliminary
    FROM publication_intents intent WHERE intent.id=p_intent_id;
    IF preliminary.owner_user_id IS DISTINCT FROM p_owner_user_id
       OR preliminary.session_id IS DISTINCT FROM p_session_id THEN
      RAISE EXCEPTION 'publication intent principal mismatch'
        USING ERRCODE='42501';
    END IF;
    IF preliminary.confirmed_at IS NOT NULL THEN RETURN; END IF;
    IF preliminary.cancelled_at IS NOT NULL THEN
      RAISE EXCEPTION 'canonical publication intent is inactive'
        USING ERRCODE='22023';
    END IF;

    PERFORM lock_publication_context(
      preliminary.target_kind,preliminary.target_document_id,
      preliminary.expected_revision_id
    );
    SELECT * INTO publication_intent
    FROM publication_intents intent WHERE intent.id=p_intent_id
    FOR UPDATE;
    IF publication_intent.id IS NULL
       OR publication_intent.action IS DISTINCT FROM preliminary.action
       OR publication_intent.target_kind IS DISTINCT FROM preliminary.target_kind
       OR publication_intent.target_document_id IS DISTINCT FROM
         preliminary.target_document_id
       OR publication_intent.expected_revision_id IS DISTINCT FROM
         preliminary.expected_revision_id
       OR publication_intent.candidate_public_id IS DISTINCT FROM
         preliminary.candidate_public_id THEN
      RAISE EXCEPTION 'publication intent changed while locking'
        USING ERRCODE='40001';
    END IF;
    IF publication_intent.owner_user_id IS DISTINCT FROM p_owner_user_id
       OR publication_intent.session_id IS DISTINCT FROM p_session_id THEN
      RAISE EXCEPTION 'publication intent principal mismatch'
        USING ERRCODE='42501';
    END IF;
    IF publication_intent.confirmed_at IS NOT NULL THEN RETURN; END IF;
    IF publication_intent.cancelled_at IS NOT NULL
       OR publication_intent.expires_at<=now() THEN
      RAISE EXCEPTION 'canonical publication intent is inactive'
        USING ERRCODE='22023';
    END IF;

    PERFORM assert_publication_intent_current(
      publication_intent.id,publication_intent.action='publish'
    );
    SELECT challenge.challenge INTO intent_challenge
    FROM confirmation_challenges challenge
    WHERE challenge.intent_kind='publication'
      AND challenge.intent_id=publication_intent.id
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'publication challenge not issued' USING ERRCODE='42501';
    END IF;
    PERFORM consume_confirmation_challenge(
      'publication',publication_intent.id,intent_challenge,
      publication_intent.owner_user_id,p_credential_id,
      p_expected_counter,p_new_counter
    );

    IF publication_intent.action='publish' THEN
      -- Confirmation locks every UUID namespace in deterministic order.
      FOR namespace_uuid IN
        SELECT DISTINCT value
        FROM unnest(array_remove(ARRAY[
          publication_intent.target_document_id,
          publication_intent.expected_revision_id,
          publication_intent.candidate_public_id
        ]||publication_intent.projected_target_public_ids,NULL)) value
        ORDER BY value
      LOOP
        PERFORM lock_public_uuid_namespace(namespace_uuid);
      END LOOP;
      IF EXISTS (
        SELECT 1 FROM blocking_public_namespace_conflicts conflict
        WHERE conflict.namespace_uuid=publication_intent.target_document_id
           OR conflict.namespace_uuid=publication_intent.expected_revision_id
           OR conflict.namespace_uuid=publication_intent.candidate_public_id
           OR conflict.namespace_uuid=ANY(
             publication_intent.projected_target_public_ids
           )
      ) THEN
        RAISE EXCEPTION 'publication has an unresolved namespace conflict'
          USING ERRCODE='23505';
      END IF;

      SELECT resource.public_id,resource.document_id,resource.resource_kind
      INTO mapped_public_id,mapped_document_id,mapped_resource_kind
      FROM public_resources resource
      WHERE resource.original_document_id=publication_intent.target_document_id;
      IF mapped_public_id IS NULL THEN
        PERFORM assert_public_uuid_available(
          publication_intent.candidate_public_id,
          publication_intent.target_document_id,publication_intent.target_kind
        );
        INSERT INTO public_resources(public_id,document_id,resource_kind)
        VALUES (
          publication_intent.candidate_public_id,
          publication_intent.target_document_id,publication_intent.target_kind
        );
        mapped_public_id := publication_intent.candidate_public_id;
      ELSIF mapped_public_id IS DISTINCT FROM
          publication_intent.candidate_public_id
        OR mapped_document_id IS DISTINCT FROM
          publication_intent.target_document_id
        OR mapped_resource_kind IS DISTINCT FROM publication_intent.target_kind THEN
        RAISE EXCEPTION 'publication resource mapping changed'
          USING ERRCODE='40001';
      END IF;

      SELECT * INTO staging
      FROM publication_artifact_staging stored
      WHERE stored.intent_id=publication_intent.id;
      IF publication_intent.target_kind='page' THEN
        SELECT revision.body_size_bytes::bigint,revision.body_content_hash
        INTO source_body_size_bytes,source_body_content_hash
        FROM hypermedia_document_revisions revision
        WHERE revision.id=publication_intent.expected_revision_id
          AND revision.document_id=publication_intent.target_document_id;
        INSERT INTO public_page_artifacts(
          artifact_id,public_id,source_document_id,source_revision_id,
          source_body_size_bytes,source_body_content_hash,body_object_key,
          body_size_bytes,body_content_hash,public_title,public_summary,
          public_last_edited_at,projected_target_public_ids,
          observed_public_uuid_tokens,projection_receipt_hash,origin,
          source_intent_id,representation_token,
          reservation_allocation_kind,reservation_allocation_id
        ) VALUES (
          staging.artifact_id,mapped_public_id,
          publication_intent.target_document_id,
          publication_intent.expected_revision_id,source_body_size_bytes,
          source_body_content_hash,staging.body_object_key,
          staging.body_size_bytes,staging.body_content_hash,
          staging.public_title,staging.public_summary,
          staging.public_last_edited_at,staging.projected_target_public_ids,
          staging.observed_public_uuid_tokens,
          staging.projection_receipt_hash,'ordinary',publication_intent.id,
          staging.representation_token,'publication_intent',publication_intent.id
        );
        DELETE FROM page_publications WHERE public_id=mapped_public_id;
        INSERT INTO page_publications(public_id,artifact_id)
        VALUES (mapped_public_id,staging.artifact_id);
      ELSE
        INSERT INTO public_asset_artifacts(
          artifact_id,public_id,source_document_id,body_object_key,
          body_size_bytes,body_content_hash,public_filename,
          public_content_type,public_width,public_height,
          public_duration_seconds,origin,source_intent_id,
          representation_token,reservation_allocation_kind,
          reservation_allocation_id
        ) VALUES (
          staging.artifact_id,mapped_public_id,
          publication_intent.target_document_id,staging.body_object_key,
          staging.body_size_bytes,staging.body_content_hash,
          staging.public_filename,staging.public_content_type,
          staging.public_width,staging.public_height,
          staging.public_duration_seconds,'ordinary',publication_intent.id,
          staging.representation_token,'publication_intent',publication_intent.id
        );
        DELETE FROM asset_publications WHERE public_id=mapped_public_id;
        INSERT INTO asset_publications(public_id,artifact_id)
        VALUES (mapped_public_id,staging.artifact_id);
      END IF;
    ELSE
      SELECT resource.public_id,resource.document_id,resource.resource_kind
      INTO mapped_public_id,mapped_document_id,mapped_resource_kind
      FROM public_resources resource
      WHERE resource.original_document_id=publication_intent.target_document_id;
      IF mapped_public_id IS NULL
         OR mapped_document_id IS DISTINCT FROM
           publication_intent.target_document_id
         OR mapped_resource_kind IS DISTINCT FROM publication_intent.target_kind THEN
        RAISE EXCEPTION 'publication resource mapping changed'
          USING ERRCODE='40001';
      END IF;
      IF publication_intent.target_kind='page' THEN
        DELETE FROM page_publications WHERE public_id=mapped_public_id;
      ELSE
        DELETE FROM asset_publications WHERE public_id=mapped_public_id;
      END IF;
    END IF;

    UPDATE publication_intents
    SET confirmed_at=now() WHERE id=publication_intent.id;
    RETURN;
  END IF;

  RAISE EXCEPTION 'publication intent not found' USING ERRCODE='P0002';
END;
$$;


ALTER FUNCTION public.confirm_publication_intent(p_intent_id uuid, p_owner_user_id text, p_session_id text, p_credential_id text, p_expected_counter integer, p_new_counter integer) OWNER TO context_use_boundary_owner;

--
-- Name: consume_confirmation_challenge(public.confirmation_intent_kind, uuid, text, text, text, integer, integer); Type: FUNCTION; Schema: public; Owner: context_use_boundary_owner
--

CREATE FUNCTION public.consume_confirmation_challenge(p_intent_kind public.confirmation_intent_kind, p_intent_id uuid, p_challenge text, p_owner_user_id text, p_credential_id text, p_expected_counter integer, p_new_counter integer) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
DECLARE
  stored_counter integer;
BEGIN
  IF p_challenge IS NULL OR p_owner_user_id IS NULL OR p_credential_id IS NULL
     OR p_expected_counter IS NULL OR p_new_counter IS NULL THEN
    RAISE EXCEPTION 'verified passkey assertion required' USING ERRCODE='42501';
  END IF;

  SELECT counter INTO stored_counter
  FROM passkey
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

  UPDATE passkey SET counter=p_new_counter
  WHERE "userId"=p_owner_user_id AND "credentialID"=p_credential_id;
END;
$$;


ALTER FUNCTION public.consume_confirmation_challenge(p_intent_kind public.confirmation_intent_kind, p_intent_id uuid, p_challenge text, p_owner_user_id text, p_credential_id text, p_expected_counter integer, p_new_counter integer) OWNER TO context_use_boundary_owner;

--
-- Name: defer_document_link_index(uuid); Type: FUNCTION; Schema: public; Owner: context_use_boundary_owner
--

CREATE FUNCTION public.defer_document_link_index(p_source_revision_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
BEGIN
  UPDATE hypermedia_document_revisions
  SET links_index_attempted_at=now()
  WHERE id=p_source_revision_id AND links_indexed_at IS NULL;
END;
$$;


ALTER FUNCTION public.defer_document_link_index(p_source_revision_id uuid) OWNER TO context_use_boundary_owner;

--
-- Name: document_search_vector(text, text, text); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.document_search_vector(p_title text, p_summary text, p_body_markdown text) RETURNS tsvector
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    SET search_path TO 'pg_catalog'
    RETURN ((setweight(to_tsvector('simple'::regconfig, COALESCE(p_title, ''::text)), 'A'::"char") || setweight(to_tsvector('english'::regconfig, COALESCE(p_summary, ''::text)), 'A'::"char")) || setweight(to_tsvector('english'::regconfig, COALESCE(p_body_markdown, ''::text)), 'B'::"char"));


ALTER FUNCTION public.document_search_vector(p_title text, p_summary text, p_body_markdown text) OWNER TO postgres;

--
-- Name: finalize_publication_artifact_claim(uuid, uuid, public.publication_target, bigint, text, text, text, timestamp with time zone, text, text, integer, integer, text, uuid[], uuid[], text); Type: FUNCTION; Schema: public; Owner: context_use_storage_owner
--

CREATE FUNCTION public.finalize_publication_artifact_claim(p_claim_token uuid, p_intent_id uuid, p_target_kind public.publication_target, p_body_size_bytes bigint, p_body_content_hash text, p_public_title text, p_public_summary text, p_public_last_edited_at timestamp with time zone, p_public_filename text, p_public_content_type text, p_public_width integer, p_public_height integer, p_public_duration_seconds text, p_projected_target_public_ids uuid[], p_observed_public_uuid_tokens uuid[], p_projection_receipt_hash text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    SET jit TO 'off'
    SET "TimeZone" TO 'UTC'
    AS $$
DECLARE
  claim publication_object_claims%ROWTYPE;
BEGIN
  SELECT * INTO claim
  FROM publication_object_claims stored
  WHERE stored.allocation_kind='publication_intent'
    AND stored.allocation_id=p_intent_id;
  IF NOT FOUND OR claim.claim_token IS DISTINCT FROM p_claim_token THEN
    RAISE EXCEPTION 'publication object claim is unavailable'
      USING ERRCODE='55000';
  END IF;
  IF claim.finalized_at IS NOT NULL THEN
    IF claim.body_size_bytes IS DISTINCT FROM p_body_size_bytes
       OR claim.body_content_hash IS DISTINCT FROM p_body_content_hash THEN
      RAISE EXCEPTION 'publication object claim finalization does not match'
        USING ERRCODE='23505';
    END IF;
    PERFORM stage_publication_artifact(
      p_intent_id,p_target_kind,p_body_size_bytes,p_body_content_hash,
      p_public_title,p_public_summary,p_public_last_edited_at,
      p_public_filename,p_public_content_type,p_public_width,p_public_height,
      p_public_duration_seconds,p_projected_target_public_ids,
      p_observed_public_uuid_tokens,p_projection_receipt_hash
    );
    RETURN;
  END IF;
  -- Lock the target and intent before the claim row. This matches challenge
  -- issuance and prevents a storage-finalize/confirmation lock inversion.
  PERFORM 1 FROM get_publication_write_target(p_intent_id);
  SELECT * INTO claim
  FROM publication_object_claims stored
  WHERE stored.allocation_kind='publication_intent'
    AND stored.allocation_id=p_intent_id
  FOR UPDATE;
  IF NOT FOUND OR claim.claim_token IS DISTINCT FROM p_claim_token THEN
    RAISE EXCEPTION 'publication object claim is unavailable'
      USING ERRCODE='55000';
  END IF;
  IF claim.finalized_at IS NULL THEN
    UPDATE publication_object_claims stored
    SET finalized_at=now(),body_size_bytes=p_body_size_bytes,
      body_content_hash=p_body_content_hash
    WHERE stored.allocation_kind='publication_intent'
      AND stored.allocation_id=p_intent_id;
  ELSIF claim.body_size_bytes IS DISTINCT FROM p_body_size_bytes
     OR claim.body_content_hash IS DISTINCT FROM p_body_content_hash THEN
    RAISE EXCEPTION 'publication object claim finalization does not match'
      USING ERRCODE='23505';
  END IF;
  PERFORM stage_publication_artifact(
    p_intent_id,p_target_kind,p_body_size_bytes,p_body_content_hash,
    p_public_title,p_public_summary,p_public_last_edited_at,
    p_public_filename,p_public_content_type,p_public_width,p_public_height,
    p_public_duration_seconds,p_projected_target_public_ids,
    p_observed_public_uuid_tokens,p_projection_receipt_hash
  );
END;
$$;


ALTER FUNCTION public.finalize_publication_artifact_claim(p_claim_token uuid, p_intent_id uuid, p_target_kind public.publication_target, p_body_size_bytes bigint, p_body_content_hash text, p_public_title text, p_public_summary text, p_public_last_edited_at timestamp with time zone, p_public_filename text, p_public_content_type text, p_public_width integer, p_public_height integer, p_public_duration_seconds text, p_projected_target_public_ids uuid[], p_observed_public_uuid_tokens uuid[], p_projection_receipt_hash text) OWNER TO context_use_storage_owner;

--
-- Name: get_dashboard_publication_status(public.publication_target, uuid); Type: FUNCTION; Schema: public; Owner: context_use_boundary_owner
--

CREATE FUNCTION public.get_dashboard_publication_status(p_target_kind public.publication_target, p_target_document_id uuid) RETURNS TABLE(public_id uuid, published_revision_id uuid, published_revision_number integer, active boolean)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
BEGIN
  IF p_target_kind='page' THEN
    RETURN QUERY
    SELECT resource.public_id,
      CASE WHEN active_page.public_id IS NOT NULL
        THEN artifact.source_revision_id ELSE NULL END,
      CASE WHEN active_page.public_id IS NOT NULL
        THEN version.version_number ELSE NULL END,
      active_page.public_id IS NOT NULL
    FROM (SELECT 1) singleton
    LEFT JOIN public_resources resource
      ON resource.resource_kind='page'
     AND resource.document_id=p_target_document_id
    LEFT JOIN page_publications pin
      ON pin.public_id=resource.public_id
    LEFT JOIN public_page_artifacts artifact
      ON artifact.public_id=pin.public_id
     AND artifact.artifact_id=pin.artifact_id
    LEFT JOIN knowledge_page_versions version
      ON version.id=artifact.source_revision_id
     AND version.page_id=p_target_document_id
    LEFT JOIN public_pages active_page
      ON active_page.public_id=resource.public_id
    LIMIT 1;
    RETURN;
  END IF;

  RETURN QUERY
  SELECT resource.public_id,NULL::uuid,NULL::integer,
    active_asset.public_id IS NOT NULL
  FROM (SELECT 1) singleton
  LEFT JOIN public_resources resource
    ON resource.resource_kind='asset'
   AND resource.document_id=p_target_document_id
  LEFT JOIN public_assets active_asset
    ON active_asset.public_id=resource.public_id
  LIMIT 1;
END;
$$;


ALTER FUNCTION public.get_dashboard_publication_status(p_target_kind public.publication_target, p_target_document_id uuid) OWNER TO context_use_boundary_owner;

--
-- Name: get_publication_entrypoint(); Type: FUNCTION; Schema: public; Owner: context_use_boundary_owner
--

CREATE FUNCTION public.get_publication_entrypoint() RETURNS TABLE(public_id uuid, configured boolean, active boolean)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
  SELECT settings.entrypoint_public_id,
    settings.updated_at IS NOT NULL,
    settings.entrypoint_public_id IS NOT NULL AND EXISTS (
      SELECT 1
      FROM page_publications publication
      JOIN public_page_artifacts artifact
        ON artifact.public_id=publication.public_id
       AND artifact.artifact_id=publication.artifact_id
      JOIN public_resources resource
        ON resource.public_id=publication.public_id
       AND resource.document_id IS NOT NULL
       AND resource.resource_kind='page'
      WHERE publication.public_id=settings.entrypoint_public_id
        AND NOT EXISTS (
          SELECT 1 FROM blocking_public_namespace_conflicts conflict
          WHERE conflict.namespace_uuid IN (
                  artifact.public_id,artifact.artifact_id
                )
             OR conflict.public_id=artifact.public_id
        )
    )
  FROM publication_settings settings
  WHERE settings.singleton;
$$;


ALTER FUNCTION public.get_publication_entrypoint() OWNER TO context_use_boundary_owner;

--
-- Name: get_publication_write_target(uuid); Type: FUNCTION; Schema: public; Owner: context_use_storage_owner
--

CREATE FUNCTION public.get_publication_write_target(p_intent_id uuid) RETURNS TABLE(intent_id uuid, target_kind public.publication_target, candidate_public_id uuid, artifact_id uuid, source_body_object_key text, source_body_size_bytes bigint, source_body_content_hash text, body_object_key text, max_body_size_bytes bigint, public_title text, public_summary text, public_last_edited_at text, public_filename text, public_content_type text, public_width integer, public_height integer, public_duration_seconds text, projected_target_public_ids uuid[], projection_receipt_hash text, target_projection jsonb)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    SET jit TO 'off'
    AS $$
DECLARE
  preliminary record;
  intent record;
BEGIN
  IF p_intent_id IS NULL THEN
    RAISE EXCEPTION 'publication intent is required' USING ERRCODE='22023';
  END IF;
  PERFORM pg_advisory_xact_lock_shared(
    hashtextextended('context-use:knowledge-lifecycle',0)
  );
  SELECT stored.target_kind,stored.target_document_id,stored.expected_revision_id,
    stored.action
  INTO preliminary
  FROM publication_intents stored WHERE stored.id=p_intent_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'canonical publication intent not found' USING ERRCODE='P0002';
  END IF;
  IF preliminary.action<>'publish' THEN
    RAISE EXCEPTION 'unpublication has no storage write target'
      USING ERRCODE='22023';
  END IF;
  PERFORM lock_publication_context(
    preliminary.target_kind,preliminary.target_document_id,
    preliminary.expected_revision_id
  );
  PERFORM assert_publication_intent_current(p_intent_id,false);
  SELECT stored.id,stored.action,stored.target_kind,
    stored.target_document_id,stored.expected_revision_id,
    stored.candidate_public_id,stored.candidate_artifact_id,
    stored.candidate_object_key,stored.projected_target_public_ids,
    stored.projection_receipt_hash
  INTO intent
  FROM publication_intents stored WHERE stored.id=p_intent_id;
  IF EXISTS (
    SELECT 1 FROM confirmation_challenges challenge
    WHERE challenge.intent_kind='publication' AND challenge.intent_id=intent.id
  ) OR EXISTS (
    SELECT 1 FROM publication_artifact_staging staging
    WHERE staging.intent_id=intent.id
  ) THEN
    RAISE EXCEPTION 'publication artifact write is no longer pending'
      USING ERRCODE='55000';
  END IF;

  IF intent.target_kind='page' THEN
    RETURN QUERY
    SELECT intent.id,intent.target_kind,intent.candidate_public_id,
      intent.candidate_artifact_id,revision.body_object_key,
      revision.body_size_bytes::bigint,revision.body_content_hash,
      intent.candidate_object_key,4000000::bigint,
      version.title,version.summary,to_char(
        version.created_at AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      ),
      NULL::text,NULL::text,NULL::integer,NULL::integer,NULL::text,
      intent.projected_target_public_ids,intent.projection_receipt_hash,
      publication_projection_plan(
        intent.target_document_id,intent.expected_revision_id,
        intent.candidate_public_id
      )
    FROM hypermedia_document_revisions revision
    JOIN knowledge_page_versions version
      ON version.id=revision.id AND version.page_id=revision.document_id
    WHERE revision.id=intent.expected_revision_id
      AND revision.document_id=intent.target_document_id;
  ELSE
    RETURN QUERY
    SELECT intent.id,intent.target_kind,intent.candidate_public_id,
      intent.candidate_artifact_id,asset.s3_object_key,
      asset.size_bytes,asset.content_hash,intent.candidate_object_key,
      5000000000::bigint,NULL::text,NULL::text,NULL::text,
      asset.filename,asset.content_type,asset.width,asset.height,
      asset.duration_seconds::text,
      '{}'::uuid[],NULL::text,'[]'::jsonb
    FROM assets asset WHERE asset.id=intent.target_document_id;
  END IF;
END;
$$;


ALTER FUNCTION public.get_publication_write_target(p_intent_id uuid) OWNER TO context_use_storage_owner;

--
-- Name: guard_artifact_reservation_namespace(); Type: FUNCTION; Schema: public; Owner: context_use_boundary_owner
--

CREATE FUNCTION public.guard_artifact_reservation_namespace() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'public artifact reservations are permanent'
      USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' THEN
    IF NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'public artifact reservations are immutable'
        USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  PERFORM lock_public_uuid_namespace(NEW.artifact_id);
  IF EXISTS (
    SELECT 1 FROM public_artifact_id_reservations reservation
    WHERE reservation.artifact_id=NEW.artifact_id
      AND reservation.body_object_key=NEW.body_object_key
      AND reservation.allocation_kind=NEW.allocation_kind
      AND reservation.allocation_id=NEW.allocation_id
  ) THEN
    RETURN NEW;
  END IF;
  IF public_uuid_has_reserved_public_identity(NEW.artifact_id)
     OR public_uuid_has_legacy_alias_token(NEW.artifact_id)
     OR public_uuid_has_private_identity(NEW.artifact_id) THEN
    RAISE EXCEPTION 'public artifact UUID conflicts with the public namespace'
      USING ERRCODE='23505';
  END IF;
  IF NOT (
    (NEW.allocation_kind='retained_page'
      AND NEW.allocation_id=NEW.artifact_id
      AND NEW.body_object_key=
        'documents/public/'||NEW.artifact_id::text||'.md')
    OR (NEW.allocation_kind IN ('publication_intent','retained_publication') AND (
      NEW.body_object_key='documents/public/'||NEW.artifact_id::text||'.md'
      OR NEW.body_object_key='artifacts/public/'||NEW.artifact_id::text
    ))
  ) THEN
    RAISE EXCEPTION 'public artifact reservation shape is invalid'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION public.guard_artifact_reservation_namespace() OWNER TO context_use_boundary_owner;

--
-- Name: guard_hypermedia_bootstrap_allocations(); Type: FUNCTION; Schema: public; Owner: context_use_boundary_owner
--

CREATE FUNCTION public.guard_hypermedia_bootstrap_allocations() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
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


ALTER FUNCTION public.guard_hypermedia_bootstrap_allocations() OWNER TO context_use_boundary_owner;

--
-- Name: guard_legacy_alias_namespace(); Type: FUNCTION; Schema: public; Owner: context_use_boundary_owner
--

CREATE FUNCTION public.guard_legacy_alias_namespace() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
DECLARE
  token uuid;
  expected_kind public_route_kind;
  resource_kind publication_target;
BEGIN
  IF TG_OP IN ('UPDATE','DELETE') THEN
    RAISE EXCEPTION 'permanent public route aliases are append-only'
      USING ERRCODE='23514';
  END IF;
  token := canonical_legacy_alias_uuid(NEW.alias_path);
  IF token IS NULL THEN RETURN NEW; END IF;
  expected_kind := canonical_legacy_alias_kind(NEW.alias_path);
  PERFORM lock_public_uuid_namespace(token);
  IF EXISTS (
    SELECT 1 FROM public_route_aliases alias
    WHERE alias.alias_path=NEW.alias_path
      AND alias.route_kind=NEW.route_kind
      AND alias.public_id=NEW.public_id
  ) THEN
    RETURN NEW;
  END IF;
  IF public_uuid_has_private_identity(token)
     OR public_uuid_has_artifact_identity(token) THEN
    RAISE EXCEPTION 'legacy alias token conflicts with a private or artifact UUID'
      USING ERRCODE='23505';
  END IF;
  IF NEW.public_id<>token OR NEW.route_kind<>expected_kind THEN
    RAISE EXCEPTION 'UUID-shaped legacy alias must match its canonical public identity'
      USING ERRCODE='23505';
  END IF;
  SELECT resource.resource_kind INTO resource_kind
  FROM public_resources resource WHERE resource.public_id=token;
  IF resource_kind IS NULL
     OR (resource_kind='page' AND expected_kind NOT IN ('page','markdown'))
     OR (resource_kind='asset' AND expected_kind<>'asset') THEN
    RAISE EXCEPTION 'UUID-shaped legacy alias kind does not match its public resource'
      USING ERRCODE='23505';
  END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION public.guard_legacy_alias_namespace() OWNER TO context_use_boundary_owner;

--
-- Name: guard_private_uuid_columns(); Type: FUNCTION; Schema: public; Owner: context_use_boundary_owner
--

CREATE FUNCTION public.guard_private_uuid_columns() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
DECLARE
  candidate uuid;
BEGIN
  FOR candidate IN
    SELECT DISTINCT (to_jsonb(NEW)->>column_name)::uuid
    FROM unnest(TG_ARGV) AS columns(column_name)
    WHERE to_jsonb(NEW)->>column_name IS NOT NULL
    ORDER BY 1
  LOOP
    PERFORM lock_public_uuid_namespace(candidate);
    IF TG_OP='INSERT' AND TG_TABLE_NAME='hypermedia_documents'
       AND EXISTS (
         SELECT 1 FROM hypermedia_documents document
         WHERE document.id=candidate
           AND document.authority=(to_jsonb(NEW)->>'authority')::hypermedia_document_authority
           AND document.representation=
             coalesce(
               (to_jsonb(NEW)->>'representation')::hypermedia_document_representation,
               'markdown'::hypermedia_document_representation
             )
       ) THEN
      CONTINUE;
    END IF;
    IF TG_OP='INSERT' AND TG_TABLE_NAME='hypermedia_document_revisions'
       AND EXISTS (
         SELECT 1 FROM hypermedia_document_revisions revision
         WHERE revision.id=candidate
           AND revision.document_id=(to_jsonb(NEW)->>'document_id')::uuid
           AND revision.revision_number=
             (to_jsonb(NEW)->>'revision_number')::integer
           AND revision.body_object_key=to_jsonb(NEW)->>'body_object_key'
           AND revision.body_size_bytes=
             (to_jsonb(NEW)->>'body_size_bytes')::integer
           AND revision.body_content_hash=to_jsonb(NEW)->>'body_content_hash'
       ) THEN
      CONTINUE;
    END IF;
    PERFORM assert_private_uuid_available(candidate);
  END LOOP;
  RETURN NEW;
END;
$$;


ALTER FUNCTION public.guard_private_uuid_columns() OWNER TO context_use_boundary_owner;

--
-- Name: guard_public_artifact_history(); Type: FUNCTION; Schema: public; Owner: context_use_boundary_owner
--

CREATE FUNCTION public.guard_public_artifact_history() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
BEGIN
  IF TG_OP IN ('UPDATE','DELETE') THEN
    RAISE EXCEPTION 'public artifact history is immutable'
      USING ERRCODE='23514';
  END IF;
  PERFORM reserve_public_representation_token(
    NEW.representation_token,NEW.artifact_id,NEW.resource_kind
  );
  RETURN NEW;
END;
$$;


ALTER FUNCTION public.guard_public_artifact_history() OWNER TO context_use_boundary_owner;

--
-- Name: guard_public_representation_token_reservation(); Type: FUNCTION; Schema: public; Owner: context_use_boundary_owner
--

CREATE FUNCTION public.guard_public_representation_token_reservation() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $$
BEGIN
  IF TG_OP='DELETE' OR NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'public representation reservations are immutable'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION public.guard_public_representation_token_reservation() OWNER TO context_use_boundary_owner;

--
-- Name: guard_public_resource_identity(); Type: FUNCTION; Schema: public; Owner: context_use_boundary_owner
--

CREATE FUNCTION public.guard_public_resource_identity() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
DECLARE
  namespace_uuid uuid;
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'permanent public resources cannot be deleted'
      USING ERRCODE='23514';
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.document_id IS NULL THEN
      RAISE EXCEPTION 'new public resources require a private document identity'
        USING ERRCODE='23514';
    END IF;
    IF NEW.original_document_id IS NULL THEN
      NEW.original_document_id := NEW.document_id;
    ELSIF NEW.original_document_id IS DISTINCT FROM NEW.document_id THEN
      RAISE EXCEPTION 'public resource original identity mismatch'
        USING ERRCODE='23514';
    END IF;
    FOR namespace_uuid IN
      SELECT DISTINCT value
      FROM unnest(ARRAY[NEW.public_id,NEW.original_document_id]) AS values(value)
      ORDER BY value
    LOOP
      PERFORM lock_public_uuid_namespace(namespace_uuid);
    END LOOP;
    IF EXISTS (
      SELECT 1 FROM public_resources resource
      WHERE resource.public_id=NEW.public_id
        AND resource.document_id=NEW.document_id
        AND resource.original_document_id=NEW.original_document_id
        AND resource.resource_kind=NEW.resource_kind
    ) THEN
      RETURN NEW;
    END IF;
    PERFORM assert_public_uuid_available(
      NEW.public_id,NEW.original_document_id,NEW.resource_kind
    );
    RETURN NEW;
  END IF;
  IF NEW.public_id IS DISTINCT FROM OLD.public_id
     OR NEW.resource_kind IS DISTINCT FROM OLD.resource_kind
     OR NEW.original_document_id IS DISTINCT FROM OLD.original_document_id
     OR (OLD.document_id IS NULL AND NEW.document_id IS NOT NULL)
     OR (NEW.document_id IS NOT NULL
       AND NEW.document_id IS DISTINCT FROM OLD.document_id) THEN
    RAISE EXCEPTION 'permanent public resource identity is immutable'
      USING ERRCODE='23514';
  END IF;
  IF OLD.document_id IS NOT NULL AND NEW.document_id IS NULL THEN
    DELETE FROM page_publications WHERE public_id=OLD.public_id;
    DELETE FROM asset_publications WHERE public_id=OLD.public_id;
  END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION public.guard_public_resource_identity() OWNER TO context_use_boundary_owner;

--
-- Name: guard_publication_intent_history(); Type: FUNCTION; Schema: public; Owner: context_use_boundary_owner
--

CREATE FUNCTION public.guard_publication_intent_history() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'canonical publication intent history is permanent'
      USING ERRCODE='23514';
  END IF;
  IF (to_jsonb(NEW)-'confirmed_at'-'cancelled_at')
       IS DISTINCT FROM (to_jsonb(OLD)-'confirmed_at'-'cancelled_at')
     OR (OLD.confirmed_at IS NOT NULL
       AND NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at)
     OR (OLD.cancelled_at IS NOT NULL
       AND NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at)
     OR (OLD.confirmed_at IS NULL AND NEW.confirmed_at IS NOT NULL
       AND OLD.cancelled_at IS NULL AND NEW.cancelled_at IS NOT NULL) THEN
    RAISE EXCEPTION 'canonical publication intent evidence is immutable'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION public.guard_publication_intent_history() OWNER TO context_use_boundary_owner;

--
-- Name: guard_publication_intent_id_reservation(); Type: FUNCTION; Schema: public; Owner: context_use_boundary_owner
--

CREATE FUNCTION public.guard_publication_intent_id_reservation() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $$
BEGIN
  IF TG_OP='DELETE' OR NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'publication intent UUID reservations are immutable'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION public.guard_publication_intent_id_reservation() OWNER TO context_use_boundary_owner;

--
-- Name: guard_publication_object_claim_history(); Type: FUNCTION; Schema: public; Owner: context_use_boundary_owner
--

CREATE FUNCTION public.guard_publication_object_claim_history() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $_$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'canonical publication object claims are permanent'
      USING ERRCODE='55000';
  END IF;
  IF OLD.finalized_at IS NULL
     AND NEW.finalized_at IS NOT NULL
     AND NEW.allocation_kind=OLD.allocation_kind
     AND NEW.allocation_id=OLD.allocation_id
     AND NEW.artifact_id=OLD.artifact_id
     AND NEW.body_object_key=OLD.body_object_key
     AND NEW.claim_token=OLD.claim_token
     AND NEW.claimed_at=OLD.claimed_at
     AND NEW.body_size_bytes IS NOT NULL
     AND NEW.body_size_bytes>=0
     AND NEW.body_content_hash ~ '^[a-f0-9]{64}$' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'canonical publication object claims are immutable after finalization'
    USING ERRCODE='55000';
END;
$_$;


ALTER FUNCTION public.guard_publication_object_claim_history() OWNER TO context_use_boundary_owner;

--
-- Name: guard_publication_staging_history(); Type: FUNCTION; Schema: public; Owner: context_use_boundary_owner
--

CREATE FUNCTION public.guard_publication_staging_history() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $$
BEGIN
  IF TG_OP IN ('UPDATE','DELETE') THEN
    RAISE EXCEPTION 'canonical publication staging is immutable'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION public.guard_publication_staging_history() OWNER TO context_use_boundary_owner;

--
-- Name: initialize_public_visibility_generation(); Type: FUNCTION; Schema: public; Owner: context_use_boundary_owner
--

CREATE FUNCTION public.initialize_public_visibility_generation() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
BEGIN
  INSERT INTO public_visibility_generations(public_id,generation)
  VALUES (NEW.public_id,1)
  ON CONFLICT (public_id) DO NOTHING;
  RETURN NULL;
END;
$$;


ALTER FUNCTION public.initialize_public_visibility_generation() OWNER TO context_use_boundary_owner;

--
-- Name: issue_confirmation_challenge(public.confirmation_intent_kind, uuid, text); Type: FUNCTION; Schema: public; Owner: context_use_boundary_owner
--

CREATE FUNCTION public.issue_confirmation_challenge(p_intent_kind public.confirmation_intent_kind, p_intent_id uuid, p_challenge text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    SET jit TO 'off'
    AS $_$
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
    RAISE EXCEPTION 'valid confirmation challenge required'
      USING ERRCODE='22023';
  END IF;

  PERFORM pg_advisory_xact_lock_shared(
    hashtextextended('context-use:knowledge-lifecycle',0)
  );

  IF p_intent_kind='publication' THEN
    SELECT EXISTS (
      SELECT 1 FROM publication_intent_id_reservations reservation
      JOIN publication_intents intent
        ON intent.id=reservation.intent_id
      WHERE reservation.intent_id=p_intent_id
    ) INTO publication_exists;
    IF NOT publication_exists THEN
      RAISE EXCEPTION 'publication intent not found' USING ERRCODE='P0002';
    END IF;

    IF publication_exists THEN
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
    END IF;
  ELSIF p_intent_kind='knowledge_export' THEN
    SELECT intent.expires_at,
      intent.confirmed_at IS NOT NULL OR intent.download_started_at IS NOT NULL
    INTO intent_expires_at,intent_inactive
    FROM knowledge_export_intents intent WHERE intent.id=p_intent_id
    FOR UPDATE;
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
       OR deletion_intent.expected_version_id IS DISTINCT FROM
         preliminary.expected_version_id THEN
      RAISE EXCEPTION 'page deletion intent changed while locking'
        USING ERRCODE='40001';
    END IF;
    IF deletion_target.id IS NULL
       OR deletion_target.archived_at IS NULL
       OR deletion_target.current_version_id IS DISTINCT FROM
         deletion_intent.expected_version_id THEN
      RAISE EXCEPTION 'page is no longer eligible for permanent deletion'
        USING ERRCODE='22023';
    END IF;
    intent_expires_at := deletion_intent.expires_at;
    intent_inactive := false;
  ELSE
    RAISE EXCEPTION 'confirmation intent kind is unsupported'
      USING ERRCODE='22023';
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
$_$;


ALTER FUNCTION public.issue_confirmation_challenge(p_intent_kind public.confirmation_intent_kind, p_intent_id uuid, p_challenge text) OWNER TO context_use_boundary_owner;

--
-- Name: keep_asset_document_identity_stable(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.keep_asset_document_identity_stable() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'asset document identity is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION public.keep_asset_document_identity_stable() OWNER TO postgres;

--
-- Name: keep_hypermedia_document_identity_stable(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.keep_hypermedia_document_identity_stable() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.authority IS DISTINCT FROM OLD.authority
     OR NEW.representation IS DISTINCT FROM OLD.representation THEN
    RAISE EXCEPTION 'document authority and representation are immutable'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION public.keep_hypermedia_document_identity_stable() OWNER TO postgres;

--
-- Name: list_publication_entrypoint_candidates(); Type: FUNCTION; Schema: public; Owner: context_use_boundary_owner
--

CREATE FUNCTION public.list_publication_entrypoint_candidates() RETURNS TABLE(public_id uuid, public_title text, public_summary text, public_last_edited_at text, representation_token text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    SET "TimeZone" TO 'UTC'
    AS $$
  SELECT page.public_id,page.public_title,page.public_summary,
    page.public_last_edited_at,page.representation_token
  FROM public_pages page
  ORDER BY page.public_title,page.public_id;
$$;


ALTER FUNCTION public.list_publication_entrypoint_candidates() OWNER TO context_use_boundary_owner;

--
-- Name: lock_automation_registry_for_operational_retarget(); Type: FUNCTION; Schema: public; Owner: context_use_boundary_owner
--

CREATE FUNCTION public.lock_automation_registry_for_operational_retarget() RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
BEGIN
  LOCK TABLE automation_registry IN SHARE ROW EXCLUSIVE MODE;
END;
$$;


ALTER FUNCTION public.lock_automation_registry_for_operational_retarget() OWNER TO context_use_boundary_owner;

--
-- Name: lock_knowledge_settings_for_page_lifecycle(); Type: FUNCTION; Schema: public; Owner: context_use_boundary_owner
--

CREATE FUNCTION public.lock_knowledge_settings_for_page_lifecycle() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
BEGIN
  -- A statement-level trigger runs before PostgreSQL locks any target page row.
  -- This gives guide configuration and page lifecycle changes the same
  -- settings-then-page lock order and avoids both stale validation and deadlock.
  PERFORM 1 FROM knowledge_settings WHERE singleton FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'knowledge settings singleton is missing' USING ERRCODE='55000';
  END IF;
  RETURN NULL;
END;
$$;


ALTER FUNCTION public.lock_knowledge_settings_for_page_lifecycle() OWNER TO context_use_boundary_owner;

--
-- Name: lock_operational_document(uuid); Type: FUNCTION; Schema: public; Owner: context_use_boundary_owner
--

CREATE FUNCTION public.lock_operational_document(p_document_id uuid) RETURNS void
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $$
  SELECT pg_advisory_xact_lock(hashtextextended('operational-document:'||p_document_id::text,0));
$$;


ALTER FUNCTION public.lock_operational_document(p_document_id uuid) OWNER TO context_use_boundary_owner;

--
-- Name: lock_public_routing_apply_tables(); Type: FUNCTION; Schema: public; Owner: context_use_publication_lock_owner
--

CREATE FUNCTION public.lock_public_routing_apply_tables() RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
BEGIN
  LOCK TABLE public_resources,public_route_aliases IN SHARE ROW EXCLUSIVE MODE;
END;
$$;


ALTER FUNCTION public.lock_public_routing_apply_tables() OWNER TO context_use_publication_lock_owner;

--
-- Name: lock_public_routing_audit_tables(); Type: FUNCTION; Schema: public; Owner: context_use_publication_lock_owner
--

CREATE FUNCTION public.lock_public_routing_audit_tables() RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
BEGIN
  LOCK TABLE public_resources,public_route_aliases IN SHARE MODE;
END;
$$;


ALTER FUNCTION public.lock_public_routing_audit_tables() OWNER TO context_use_publication_lock_owner;

--
-- Name: lock_public_uuid_namespace(uuid); Type: FUNCTION; Schema: public; Owner: context_use_boundary_owner
--

CREATE FUNCTION public.lock_public_uuid_namespace(p_uuid uuid) RETURNS void
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $$
  SELECT pg_advisory_xact_lock(
    hashtextextended('permanent-public-uuid-namespace:'||p_uuid::text,0)
  );
$$;


ALTER FUNCTION public.lock_public_uuid_namespace(p_uuid uuid) OWNER TO context_use_boundary_owner;

--
-- Name: lock_publication_context(public.publication_target, uuid, uuid); Type: FUNCTION; Schema: public; Owner: context_use_boundary_owner
--

CREATE FUNCTION public.lock_publication_context(p_target_kind public.publication_target, p_target_document_id uuid, p_expected_revision_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
DECLARE
  document_ids uuid[];
  document_id uuid;
BEGIN
  IF p_target_kind IS NULL OR p_target_document_id IS NULL THEN
    RAISE EXCEPTION 'publication target is required' USING ERRCODE='22023';
  END IF;
  SELECT coalesce(array_agg(id ORDER BY id),'{}'::uuid[])
  INTO document_ids
  FROM (
    SELECT p_target_document_id AS id
    UNION
    SELECT unnest(contract.target_document_ids)
    FROM knowledge_revision_contracts contract
    WHERE p_target_kind='page'
      AND contract.revision_id=p_expected_revision_id
      AND contract.document_id=p_target_document_id
  ) identities;

  -- Canonical advisory acquisition prevents two cross-linking page
  -- publications from taking their source rows in opposite orders.
  FOREACH document_id IN ARRAY document_ids LOOP
    PERFORM lock_operational_document(document_id);
  END LOOP;

  IF p_target_kind='page' THEN
    PERFORM 1 FROM knowledge_pages
    WHERE id=p_target_document_id FOR UPDATE;
  ELSE
    PERFORM 1 FROM assets WHERE id=p_target_document_id FOR UPDATE;
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'publication target not found' USING ERRCODE='P0002';
  END IF;

  PERFORM page.id
  FROM knowledge_pages page
  WHERE page.id=ANY(document_ids) AND page.id<>p_target_document_id
  ORDER BY page.id
  FOR SHARE;
  PERFORM asset.id
  FROM assets asset
  WHERE asset.id=ANY(document_ids) AND asset.id<>p_target_document_id
  ORDER BY asset.id
  FOR SHARE;

  -- Match the established lock order after the target row: resource, visibility
  -- generation and pin before the private-target generation.
  PERFORM resource.public_id
  FROM public_resources resource
  WHERE resource.original_document_id=ANY(document_ids)
  ORDER BY resource.original_document_id,resource.public_id
  FOR UPDATE;
  PERFORM generation.public_id
  FROM public_visibility_generations generation
  JOIN public_resources resource ON resource.public_id=generation.public_id
  WHERE resource.original_document_id=ANY(document_ids)
  ORDER BY generation.public_id
  FOR UPDATE OF generation;
  PERFORM publication.public_id
  FROM page_publications publication
  JOIN public_resources resource ON resource.public_id=publication.public_id
  WHERE resource.original_document_id=ANY(document_ids)
  ORDER BY publication.public_id
  FOR SHARE OF publication;
  PERFORM publication.public_id
  FROM asset_publications publication
  JOIN public_resources resource ON resource.public_id=publication.public_id
  WHERE resource.original_document_id=ANY(document_ids)
  ORDER BY publication.public_id
  FOR SHARE OF publication;
  PERFORM generation.target_document_id
  FROM publication_target_generations generation
  WHERE generation.target_document_id=ANY(document_ids)
  ORDER BY generation.target_kind,generation.target_document_id
  FOR UPDATE;
END;
$$;


ALTER FUNCTION public.lock_publication_context(p_target_kind public.publication_target, p_target_document_id uuid, p_expected_revision_id uuid) OWNER TO context_use_boundary_owner;

--
-- Name: prevent_automation_document_role_reuse(); Type: FUNCTION; Schema: public; Owner: context_use_boundary_owner
--

CREATE FUNCTION public.prevent_automation_document_role_reuse() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
DECLARE target_id uuid;
BEGIN
  FOR target_id IN
    SELECT id FROM unnest(array_remove(
      ARRAY[NEW.instructions_document_id,NEW.state_document_id],NULL
    )) id ORDER BY id
  LOOP
    PERFORM lock_operational_document(target_id);
  END LOOP;
  IF EXISTS (
    SELECT 1 FROM automation_registry registry
    WHERE registry.id<>NEW.id AND (
      registry.instructions_document_id=ANY(array_remove(
        ARRAY[NEW.instructions_document_id,NEW.state_document_id],NULL
      )) OR registry.state_document_id=ANY(array_remove(
        ARRAY[NEW.instructions_document_id,NEW.state_document_id],NULL
      ))
    )
  ) THEN
    RAISE EXCEPTION 'an automation document cannot be reused in another registry role'
      USING ERRCODE='23505';
  END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION public.prevent_automation_document_role_reuse() OWNER TO context_use_boundary_owner;

--
-- Name: prevent_operational_publication_intent(); Type: FUNCTION; Schema: public; Owner: context_use_boundary_owner
--

CREATE FUNCTION public.prevent_operational_publication_intent() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
BEGIN
  IF NEW.action='publish' AND NEW.target_kind='page' THEN
    PERFORM lock_operational_document(NEW.target_id);
    IF publication_target_is_operational(NEW.target_id) THEN
      RAISE EXCEPTION 'operational control documents cannot be published'
        USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION public.prevent_operational_publication_intent() OWNER TO context_use_boundary_owner;

--
-- Name: protect_active_asset_publication(); Type: FUNCTION; Schema: public; Owner: context_use_boundary_owner
--

CREATE FUNCTION public.protect_active_asset_publication() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
BEGIN
  IF (TG_OP='DELETE' OR NEW.deleted_at IS NOT NULL) AND EXISTS (
    SELECT 1
    FROM public_resources resource
    JOIN asset_publications publication ON publication.public_id=resource.public_id
    WHERE resource.original_document_id=OLD.id
  ) THEN
    RAISE EXCEPTION 'an actively published v2 asset cannot be archived or deleted'
      USING ERRCODE='23514';
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END;
$$;


ALTER FUNCTION public.protect_active_asset_publication() OWNER TO context_use_boundary_owner;

--
-- Name: protect_active_page_publication(); Type: FUNCTION; Schema: public; Owner: context_use_boundary_owner
--

CREATE FUNCTION public.protect_active_page_publication() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
BEGIN
  IF (TG_OP='DELETE' OR NEW.archived_at IS NOT NULL) AND EXISTS (
    SELECT 1
    FROM public_resources resource
    JOIN page_publications publication ON publication.public_id=resource.public_id
    WHERE resource.original_document_id=OLD.id
  ) THEN
    RAISE EXCEPTION 'an actively published v2 page cannot be archived or deleted'
      USING ERRCODE='23514';
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END;
$$;


ALTER FUNCTION public.protect_active_page_publication() OWNER TO context_use_boundary_owner;

--
-- Name: protect_configured_global_knowledge_guide(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.protect_configured_global_knowledge_guide() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$
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


ALTER FUNCTION public.protect_configured_global_knowledge_guide() OWNER TO postgres;

--
-- Name: protect_owner_identity(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.protect_owner_identity() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'the owner identity is immutable' USING ERRCODE='42501';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.email IS DISTINCT FROM OLD.email
     OR NEW."emailVerified" IS DISTINCT FROM OLD."emailVerified" THEN
    RAISE EXCEPTION 'the owner identity is immutable' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION public.protect_owner_identity() OWNER TO postgres;

--
-- Name: protect_passkey_credential(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.protect_passkey_credential() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(OLD."userId",0));
    IF (
      SELECT count("userId") FROM passkey WHERE "userId"=OLD."userId"
    )<=1 THEN
      RAISE EXCEPTION 'at least one owner passkey is required' USING ERRCODE='22023';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW."publicKey" IS DISTINCT FROM OLD."publicKey"
     OR NEW."userId" IS DISTINCT FROM OLD."userId"
     OR NEW."credentialID" IS DISTINCT FROM OLD."credentialID"
     OR NEW."deviceType" IS DISTINCT FROM OLD."deviceType"
     OR NEW."backedUp" IS DISTINCT FROM OLD."backedUp"
     OR NEW.transports IS DISTINCT FROM OLD.transports
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
     OR NEW.aaguid IS DISTINCT FROM OLD.aaguid
     OR NEW.counter<OLD.counter THEN
    RAISE EXCEPTION 'the owner passkey credential is immutable' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION public.protect_passkey_credential() OWNER TO postgres;

--
-- Name: protect_registered_automation_documents(); Type: FUNCTION; Schema: public; Owner: context_use_boundary_owner
--

CREATE FUNCTION public.protect_registered_automation_documents() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
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


ALTER FUNCTION public.protect_registered_automation_documents() OWNER TO context_use_boundary_owner;

--
-- Name: prune_page_versions(uuid); Type: FUNCTION; Schema: public; Owner: context_use_boundary_owner
--

CREATE FUNCTION public.prune_page_versions(p_page_id uuid) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
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
      AND NOT EXISTS (SELECT 1 FROM publication_intents intent
        WHERE intent.target_kind='page' AND intent.target_document_id=p_page_id
          AND intent.expected_revision_id=version.id AND intent.expires_at>now())
    RETURNING 1)
  SELECT count(*)::integer INTO removed_count FROM removed;
  RETURN removed_count;
END;
$$;


ALTER FUNCTION public.prune_page_versions(p_page_id uuid) OWNER TO context_use_boundary_owner;

--
-- Name: public_duration_is_safe(numeric); Type: FUNCTION; Schema: public; Owner: context_use_boundary_owner
--

CREATE FUNCTION public.public_duration_is_safe(p_value numeric) RETURNS boolean
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    SET search_path TO 'pg_catalog'
    RETURN CASE WHEN (p_value IS NULL) THEN true ELSE ((length((p_value)::text) <= 1024) AND ((p_value)::text ~ '^(0|[1-9][0-9]*)([.][0-9]+)?$'::text)) END;


ALTER FUNCTION public.public_duration_is_safe(p_value numeric) OWNER TO context_use_boundary_owner;

--
-- Name: public_metadata_is_safe(text); Type: FUNCTION; Schema: public; Owner: context_use_boundary_owner
--

CREATE FUNCTION public.public_metadata_is_safe(p_value text) RETURNS boolean
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    SET search_path TO 'pg_catalog'
    RETURN ((p_value IS NOT NULL) AND (p_value = TRIM(BOTH FROM p_value)) AND (p_value !~ '[[:cntrl:]]'::text) AND (p_value !~* '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'::text) AND (p_value !~* '(context-use:|/app/|/api/|[[][[])'::text));


ALTER FUNCTION public.public_metadata_is_safe(p_value text) OWNER TO context_use_boundary_owner;

--
-- Name: public_route_kind(text); Type: FUNCTION; Schema: public; Owner: context_use_projection_owner
--

CREATE FUNCTION public.public_route_kind(p_route text) RETURNS public.public_route_kind
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    SET search_path TO 'pg_catalog'
    RETURN CASE WHEN (p_route = '/p/'::text) THEN 'directory'::public.public_route_kind WHEN ((p_route ~~ '/a/%'::text) AND ((length(SUBSTRING(p_route FROM 4)) >= 1) AND (length(SUBSTRING(p_route FROM 4)) <= 512)) AND (SUBSTRING(p_route FROM 4) ~ '^[a-z0-9][a-z0-9/_-]*$'::text) AND (SUBSTRING(p_route FROM 4) !~ '//'::text) AND ("right"(p_route, 1) <> '/'::text)) THEN 'asset'::public.public_route_kind WHEN ((p_route ~~ '/p/%/'::text) AND ((length(SUBSTRING(p_route FROM 4 FOR (length(p_route) - 4))) >= 1) AND (length(SUBSTRING(p_route FROM 4 FOR (length(p_route) - 4))) <= 512)) AND (SUBSTRING(p_route FROM 4 FOR (length(p_route) - 4)) ~ '^[a-z0-9][a-z0-9/_-]*$'::text) AND (SUBSTRING(p_route FROM 4 FOR (length(p_route) - 4)) !~ '//'::text) AND ("right"(SUBSTRING(p_route FROM 4 FOR (length(p_route) - 4)), 1) <> '/'::text)) THEN 'directory'::public.public_route_kind WHEN ((p_route ~~ '/p/%.md'::text) AND ((length(SUBSTRING(p_route FROM 4 FOR (length(p_route) - 6))) >= 1) AND (length(SUBSTRING(p_route FROM 4 FOR (length(p_route) - 6))) <= 512)) AND (SUBSTRING(p_route FROM 4 FOR (length(p_route) - 6)) ~ '^[a-z0-9][a-z0-9/_-]*$'::text) AND (SUBSTRING(p_route FROM 4 FOR (length(p_route) - 6)) !~ '//'::text) AND ("right"(SUBSTRING(p_route FROM 4 FOR (length(p_route) - 6)), 1) <> '/'::text)) THEN 'markdown'::public.public_route_kind WHEN ((p_route ~~ '/p/%'::text) AND ((length(SUBSTRING(p_route FROM 4)) >= 1) AND (length(SUBSTRING(p_route FROM 4)) <= 512)) AND (SUBSTRING(p_route FROM 4) ~ '^[a-z0-9][a-z0-9/_-]*$'::text) AND (SUBSTRING(p_route FROM 4) !~ '//'::text) AND ("right"(p_route, 1) <> '/'::text)) THEN 'page'::public.public_route_kind ELSE NULL::public.public_route_kind END;


ALTER FUNCTION public.public_route_kind(p_route text) OWNER TO context_use_projection_owner;

--
-- Name: public_uuid_has_artifact_identity(uuid); Type: FUNCTION; Schema: public; Owner: context_use_boundary_owner
--

CREATE FUNCTION public.public_uuid_has_artifact_identity(p_uuid uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
  SELECT EXISTS (
    SELECT 1 FROM public_artifact_id_reservations WHERE artifact_id=p_uuid
  );
$$;


ALTER FUNCTION public.public_uuid_has_artifact_identity(p_uuid uuid) OWNER TO context_use_boundary_owner;

--
-- Name: public_uuid_has_legacy_alias_token(uuid); Type: FUNCTION; Schema: public; Owner: context_use_boundary_owner
--

CREATE FUNCTION public.public_uuid_has_legacy_alias_token(p_uuid uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
  SELECT EXISTS (
    SELECT 1 FROM public_route_aliases alias
    WHERE canonical_legacy_alias_uuid(alias.alias_path)=p_uuid
  );
$$;


ALTER FUNCTION public.public_uuid_has_legacy_alias_token(p_uuid uuid) OWNER TO context_use_boundary_owner;

--
-- Name: public_uuid_has_private_identity(uuid); Type: FUNCTION; Schema: public; Owner: context_use_boundary_owner
--

CREATE FUNCTION public.public_uuid_has_private_identity(p_uuid uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
  SELECT EXISTS (
    SELECT 1 FROM hypermedia_documents WHERE id=p_uuid
    UNION ALL SELECT 1 FROM hypermedia_document_revisions WHERE id=p_uuid
    UNION ALL SELECT 1 FROM hypermedia_bootstrap_allocations
      WHERE document_id=p_uuid OR revision_id=p_uuid
    UNION ALL SELECT 1 FROM public_resources WHERE original_document_id=p_uuid
    UNION ALL SELECT 1 FROM publication_target_generations WHERE target_document_id=p_uuid
  );
$$;


ALTER FUNCTION public.public_uuid_has_private_identity(p_uuid uuid) OWNER TO context_use_boundary_owner;

--
-- Name: public_uuid_has_reserved_public_identity(uuid); Type: FUNCTION; Schema: public; Owner: context_use_boundary_owner
--

CREATE FUNCTION public.public_uuid_has_reserved_public_identity(p_uuid uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
  SELECT EXISTS (SELECT 1 FROM public_resources WHERE public_id=p_uuid);
$$;


ALTER FUNCTION public.public_uuid_has_reserved_public_identity(p_uuid uuid) OWNER TO context_use_boundary_owner;

--
-- Name: publication_projected_target_ids(uuid, uuid, uuid); Type: FUNCTION; Schema: public; Owner: context_use_boundary_owner
--

CREATE FUNCTION public.publication_projected_target_ids(p_target_document_id uuid, p_expected_revision_id uuid, p_candidate_public_id uuid) RETURNS uuid[]
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
  SELECT canonical_public_uuid_set(coalesce(array_agg(
    (entry->>'public_id')::uuid
  ),'{}'::uuid[]))
  FROM jsonb_array_elements(publication_projection_plan(
    p_target_document_id,p_expected_revision_id,p_candidate_public_id
  )) entry
  WHERE entry->>'public_id' IS NOT NULL;
$$;


ALTER FUNCTION public.publication_projected_target_ids(p_target_document_id uuid, p_expected_revision_id uuid, p_candidate_public_id uuid) OWNER TO context_use_boundary_owner;

--
-- Name: publication_projection_has_namespace_conflict(uuid, uuid, uuid); Type: FUNCTION; Schema: public; Owner: context_use_boundary_owner
--

CREATE FUNCTION public.publication_projection_has_namespace_conflict(p_target_document_id uuid, p_expected_revision_id uuid, p_candidate_public_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
  SELECT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(publication_projection_plan(
      p_target_document_id,p_expected_revision_id,p_candidate_public_id
    )) entry
    WHERE entry->>'outcome'='namespace_conflict'
  );
$$;


ALTER FUNCTION public.publication_projection_has_namespace_conflict(p_target_document_id uuid, p_expected_revision_id uuid, p_candidate_public_id uuid) OWNER TO context_use_boundary_owner;

--
-- Name: publication_projection_plan(uuid, uuid, uuid); Type: FUNCTION; Schema: public; Owner: context_use_boundary_owner
--

CREATE FUNCTION public.publication_projection_plan(p_target_document_id uuid, p_expected_revision_id uuid, p_candidate_public_id uuid) RETURNS jsonb
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
  WITH contract_targets AS (
    SELECT DISTINCT target_document_id
    FROM knowledge_revision_contracts contract,
      unnest(contract.target_document_ids) target_document_id
    WHERE contract.revision_id=p_expected_revision_id
      AND contract.document_id=p_target_document_id
  ), described AS (
    SELECT target.target_document_id,resource.public_id AS mapped_public_id,
      resource.resource_kind AS mapped_resource_kind,
      CASE
        WHEN target.target_document_id=p_target_document_id THEN 'self'
        WHEN EXISTS (
          SELECT 1 FROM blocking_public_namespace_conflicts conflict
          WHERE conflict.namespace_uuid=target.target_document_id
             OR conflict.namespace_uuid=resource.public_id
        ) THEN 'namespace_conflict'
        WHEN resource.public_id IS NOT NULL
         AND resource.document_id=target.target_document_id
         AND (
           (resource.resource_kind='page' AND EXISTS (
             SELECT 1 FROM page_publications publication
             WHERE publication.public_id=resource.public_id
           ))
           OR (resource.resource_kind='asset' AND EXISTS (
             SELECT 1 FROM asset_publications publication
             WHERE publication.public_id=resource.public_id
           ))
         ) THEN 'active_public'
        WHEN resource.public_id IS NOT NULL THEN 'inactive_public'
        WHEN EXISTS (
          SELECT 1 FROM knowledge_pages page
          WHERE page.id=target.target_document_id
          UNION ALL
          SELECT 1 FROM assets asset WHERE asset.id=target.target_document_id
        ) THEN 'private'
        ELSE 'dangling'
      END AS outcome
    FROM contract_targets target
    LEFT JOIN LATERAL (
      SELECT public_id,document_id,resource_kind
      FROM public_resources
      WHERE original_document_id=target.target_document_id
      LIMIT 1
    ) resource ON true
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'target_document_id',target_document_id,
    'outcome',outcome,
    'public_id',CASE
      WHEN outcome='self' THEN p_candidate_public_id
      WHEN outcome='active_public' THEN mapped_public_id
      ELSE NULL
    END,
    'public_target_kind',CASE
      WHEN outcome='self' THEN 'page'
      WHEN outcome='active_public' THEN mapped_resource_kind::text
      ELSE NULL
    END
  ) ORDER BY target_document_id),'[]'::jsonb)
  FROM described;
$$;


ALTER FUNCTION public.publication_projection_plan(p_target_document_id uuid, p_expected_revision_id uuid, p_candidate_public_id uuid) OWNER TO context_use_boundary_owner;

--
-- Name: publication_projection_receipt_hash(uuid, uuid, uuid, text); Type: FUNCTION; Schema: public; Owner: context_use_boundary_owner
--

CREATE FUNCTION public.publication_projection_receipt_hash(p_target_document_id uuid, p_expected_revision_id uuid, p_candidate_public_id uuid, p_source_fingerprint text) RETURNS text
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
  SELECT encode(digest(convert_to(jsonb_build_object(
    'source_fingerprint',p_source_fingerprint,
    'target_document_id',p_target_document_id,
    'expected_revision_id',p_expected_revision_id,
    'candidate_public_id',p_candidate_public_id,
    'projection_plan',publication_projection_plan(
      p_target_document_id,p_expected_revision_id,p_candidate_public_id
    )
  )::text,'UTF8'),'sha256'),'hex')
$$;


ALTER FUNCTION public.publication_projection_receipt_hash(p_target_document_id uuid, p_expected_revision_id uuid, p_candidate_public_id uuid, p_source_fingerprint text) OWNER TO context_use_boundary_owner;

--
-- Name: publication_representation_token(jsonb); Type: FUNCTION; Schema: public; Owner: context_use_boundary_owner
--

CREATE FUNCTION public.publication_representation_token(p_frozen_tuple jsonb) RETURNS text
    LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE
    SET search_path TO 'pg_catalog', 'public'
    AS $$
BEGIN
  IF p_frozen_tuple IS NULL OR jsonb_typeof(p_frozen_tuple)<>'object' THEN
    RAISE EXCEPTION 'complete frozen public representation is required'
      USING ERRCODE='22023';
  END IF;
  RETURN encode(digest(convert_to(p_frozen_tuple::text,'UTF8'),'sha256'),'hex');
END;
$$;


ALTER FUNCTION public.publication_representation_token(p_frozen_tuple jsonb) OWNER TO context_use_boundary_owner;

--
-- Name: publication_source_fingerprint(public.publication_target, uuid, uuid); Type: FUNCTION; Schema: public; Owner: context_use_storage_owner
--

CREATE FUNCTION public.publication_source_fingerprint(p_target_kind public.publication_target, p_target_document_id uuid, p_expected_revision_id uuid) RETURNS text
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    SET "TimeZone" TO 'UTC'
    AS $$
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


ALTER FUNCTION public.publication_source_fingerprint(p_target_kind public.publication_target, p_target_document_id uuid, p_expected_revision_id uuid) OWNER TO context_use_storage_owner;

--
-- Name: publication_target_is_operational(uuid); Type: FUNCTION; Schema: public; Owner: context_use_boundary_owner
--

CREATE FUNCTION public.publication_target_is_operational(p_document_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
  SELECT EXISTS (
    SELECT 1 FROM knowledge_settings
    WHERE singleton AND global_guide_document_id=p_document_id
    UNION ALL SELECT 1 FROM automation_registry
    WHERE instructions_document_id=p_document_id OR state_document_id=p_document_id
  );
$$;


ALTER FUNCTION public.publication_target_is_operational(p_document_id uuid) OWNER TO context_use_boundary_owner;

--
-- Name: publication_visibility_state_hash(public.publication_target, uuid, uuid); Type: FUNCTION; Schema: public; Owner: context_use_boundary_owner
--

CREATE FUNCTION public.publication_visibility_state_hash(p_target_kind public.publication_target, p_target_document_id uuid, p_public_id uuid) RETURNS text
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
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


ALTER FUNCTION public.publication_visibility_state_hash(p_target_kind public.publication_target, p_target_document_id uuid, p_public_id uuid) OWNER TO context_use_boundary_owner;

--
-- Name: record_generic_knowledge_revision(uuid, uuid, text, uuid[], public.knowledge_revision_contract_provenance); Type: FUNCTION; Schema: public; Owner: context_use_boundary_owner
--

CREATE FUNCTION public.record_generic_knowledge_revision(p_expected_document_id uuid, p_revision_id uuid, p_body_markdown text, p_target_document_ids uuid[], p_provenance public.knowledge_revision_contract_provenance DEFAULT 'authored'::public.knowledge_revision_contract_provenance) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
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
    hashtextextended('context-use:knowledge-lifecycle',0)
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
   AND (page.archived_at IS NULL OR p_provenance='imported')
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

  INSERT INTO knowledge_search(
    document_id,revision_id,search_vector,indexed_at
  ) VALUES (
    resolved_document_id,p_revision_id,
    document_search_vector(page_title,page_summary,''),now()
  )
  ON CONFLICT (document_id) DO UPDATE
  SET revision_id=excluded.revision_id,
      search_vector=excluded.search_vector,
      indexed_at=excluded.indexed_at;

  DELETE FROM knowledge_search_chunks
  WHERE document_id=resolved_document_id;
  INSERT INTO knowledge_search_chunks(
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


ALTER FUNCTION public.record_generic_knowledge_revision(p_expected_document_id uuid, p_revision_id uuid, p_body_markdown text, p_target_document_ids uuid[], p_provenance public.knowledge_revision_contract_provenance) OWNER TO context_use_boundary_owner;

--
-- Name: register_asset_document_identity(); Type: FUNCTION; Schema: public; Owner: context_use_boundary_owner
--

CREATE FUNCTION public.register_asset_document_identity() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
DECLARE
  existing_authority hypermedia_document_authority;
  existing_representation hypermedia_document_representation;
BEGIN
  INSERT INTO hypermedia_documents(
    id,authority,representation,created_at,updated_at
  ) VALUES (NEW.id,'knowledge','asset',NEW.created_at,NEW.created_at)
  ON CONFLICT (id) DO NOTHING;

  SELECT authority,representation
  INTO existing_authority,existing_representation
  FROM hypermedia_documents
  WHERE id=NEW.id;
  IF existing_authority IS DISTINCT FROM 'knowledge'::hypermedia_document_authority
     OR existing_representation IS DISTINCT FROM 'asset'::hypermedia_document_representation THEN
    RAISE EXCEPTION 'asset identity collides with an existing hypermedia document'
      USING ERRCODE='23505';
  END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION public.register_asset_document_identity() OWNER TO context_use_boundary_owner;

--
-- Name: register_generic_knowledge_revision(uuid, text, uuid[]); Type: FUNCTION; Schema: public; Owner: context_use_boundary_owner
--

CREATE FUNCTION public.register_generic_knowledge_revision(p_revision_id uuid, p_body_markdown text, p_target_document_ids uuid[]) RETURNS integer
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
  SELECT record_generic_knowledge_revision(
    NULL,p_revision_id,p_body_markdown,p_target_document_ids,'authored'
  )
$$;


ALTER FUNCTION public.register_generic_knowledge_revision(p_revision_id uuid, p_body_markdown text, p_target_document_ids uuid[]) OWNER TO context_use_boundary_owner;

--
-- Name: register_knowledge_document_metadata(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.register_knowledge_document_metadata() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
BEGIN
  INSERT INTO hypermedia_documents(id,authority,created_at,updated_at)
  VALUES (NEW.id,'knowledge',NEW.created_at,NEW.updated_at)
  ON CONFLICT (id) DO NOTHING;
  RETURN NULL;
END;
$$;


ALTER FUNCTION public.register_knowledge_document_metadata() OWNER TO postgres;

--
-- Name: reject_pending_publication_claim_challenge(); Type: FUNCTION; Schema: public; Owner: context_use_boundary_owner
--

CREATE FUNCTION public.reject_pending_publication_claim_challenge() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
BEGIN
  IF NEW.intent_kind='publication' AND EXISTS (
    SELECT 1
    FROM publication_intent_id_reservations reservation
    JOIN publication_object_claims claim
      ON claim.allocation_kind='publication_intent'
     AND claim.allocation_id=reservation.intent_id
    WHERE reservation.intent_id=NEW.intent_id
      AND claim.finalized_at IS NULL
    FOR SHARE OF claim
  ) THEN
    RAISE EXCEPTION 'publication artifact write is still in progress'
      USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION public.reject_pending_publication_claim_challenge() OWNER TO context_use_boundary_owner;

--
-- Name: remove_deleted_asset_document_identity(); Type: FUNCTION; Schema: public; Owner: context_use_boundary_owner
--

CREATE FUNCTION public.remove_deleted_asset_document_identity() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
BEGIN
  DELETE FROM hypermedia_documents
  WHERE id=OLD.id AND authority='knowledge' AND representation='asset';
  RETURN NULL;
END;
$$;


ALTER FUNCTION public.remove_deleted_asset_document_identity() OWNER TO context_use_boundary_owner;

--
-- Name: remove_deleted_knowledge_document_metadata(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.remove_deleted_knowledge_document_metadata() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
BEGIN
  DELETE FROM hypermedia_documents WHERE id=OLD.id AND authority='knowledge';
  RETURN NULL;
END;
$$;


ALTER FUNCTION public.remove_deleted_knowledge_document_metadata() OWNER TO postgres;

--
-- Name: remove_deleted_knowledge_revision_metadata(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.remove_deleted_knowledge_revision_metadata() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
BEGIN
  DELETE FROM hypermedia_document_revisions WHERE id=OLD.id;
  RETURN NULL;
END;
$$;


ALTER FUNCTION public.remove_deleted_knowledge_revision_metadata() OWNER TO postgres;

--
-- Name: remove_owner_passkey(text, text); Type: FUNCTION; Schema: public; Owner: context_use_boundary_owner
--

CREATE FUNCTION public.remove_owner_passkey(p_owner_user_id text, p_passkey_id text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
BEGIN
  IF p_owner_user_id IS DISTINCT FROM 'context-use-owner'
     OR p_passkey_id IS NULL OR length(trim(p_passkey_id))<1 THEN
    RAISE EXCEPTION 'valid owner passkey required' USING ERRCODE='42501';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_owner_user_id,0));
  IF (
    SELECT count("userId") FROM passkey WHERE "userId"=p_owner_user_id
  )<=1 THEN
    RAISE EXCEPTION 'at least one owner passkey is required' USING ERRCODE='22023';
  END IF;

  DELETE FROM passkey
  WHERE id=p_passkey_id AND "userId"=p_owner_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'owner passkey not found' USING ERRCODE='P0002';
  END IF;
END;
$$;


ALTER FUNCTION public.remove_owner_passkey(p_owner_user_id text, p_passkey_id text) OWNER TO context_use_boundary_owner;

--
-- Name: remove_truncated_asset_document_identities(); Type: FUNCTION; Schema: public; Owner: context_use_boundary_owner
--

CREATE FUNCTION public.remove_truncated_asset_document_identities() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
BEGIN
  DELETE FROM hypermedia_documents document
  WHERE document.authority='knowledge' AND document.representation='asset'
    AND NOT EXISTS (SELECT 1 FROM assets asset WHERE asset.id=document.id);
  RETURN NULL;
END;
$$;


ALTER FUNCTION public.remove_truncated_asset_document_identities() OWNER TO context_use_boundary_owner;

--
-- Name: replace_document_links(uuid, uuid[]); Type: FUNCTION; Schema: public; Owner: context_use_boundary_owner
--

CREATE FUNCTION public.replace_document_links(p_source_revision_id uuid, p_target_document_ids uuid[]) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
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


ALTER FUNCTION public.replace_document_links(p_source_revision_id uuid, p_target_document_ids uuid[]) OWNER TO context_use_boundary_owner;

--
-- Name: replace_knowledge_document_identity_metadata(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.replace_knowledge_document_identity_metadata() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
BEGIN
  DELETE FROM hypermedia_documents WHERE id=OLD.id AND authority='knowledge';
  INSERT INTO hypermedia_documents(id,authority,created_at,updated_at)
  VALUES (NEW.id,'knowledge',NEW.created_at,NEW.updated_at)
  ON CONFLICT (id) DO NOTHING;
  RETURN NULL;
END;
$$;


ALTER FUNCTION public.replace_knowledge_document_identity_metadata() OWNER TO postgres;

--
-- Name: replace_knowledge_revision_projections(uuid, uuid[]); Type: FUNCTION; Schema: public; Owner: context_use_boundary_owner
--

CREATE FUNCTION public.replace_knowledge_revision_projections(p_source_revision_id uuid, p_target_document_ids uuid[]) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
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


ALTER FUNCTION public.replace_knowledge_revision_projections(p_source_revision_id uuid, p_target_document_ids uuid[]) OWNER TO context_use_boundary_owner;

--
-- Name: replace_source_record_search_chunks(uuid, text[]); Type: FUNCTION; Schema: public; Owner: context_use_boundary_owner
--

CREATE FUNCTION public.replace_source_record_search_chunks(p_document_id uuid, p_chunks text[]) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
DECLARE
  inserted_count integer;
BEGIN
  IF p_document_id IS NULL OR p_chunks IS NULL
     OR cardinality(p_chunks)>2048
     OR array_position(p_chunks,NULL) IS NOT NULL
     OR EXISTS (
       SELECT 1 FROM unnest(p_chunks) AS value(chunk)
       WHERE octet_length(chunk)>65536
     ) THEN
    RAISE EXCEPTION 'source record search chunks are invalid' USING ERRCODE='22023';
  END IF;
  PERFORM 1 FROM source_records WHERE document_id=p_document_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'source record not found' USING ERRCODE='P0002';
  END IF;

  DELETE FROM source_record_search_chunks WHERE document_id=p_document_id;
  INSERT INTO source_record_search_chunks(document_id,chunk_number,search_vector)
  SELECT p_document_id,ordinality-1,to_tsvector('english',chunk)
  FROM unnest(p_chunks) WITH ORDINALITY AS value(chunk,ordinality);
  GET DIAGNOSTICS inserted_count=ROW_COUNT;
  RETURN inserted_count;
END;
$$;


ALTER FUNCTION public.replace_source_record_search_chunks(p_document_id uuid, p_chunks text[]) OWNER TO context_use_boundary_owner;

--
-- Name: require_finalized_publication_object_claim(); Type: FUNCTION; Schema: public; Owner: context_use_boundary_owner
--

CREATE FUNCTION public.require_finalized_publication_object_claim() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
DECLARE claim publication_object_claims%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME<>'publication_artifact_staging' THEN
    RAISE EXCEPTION 'unexpected canonical publication staging table'
      USING ERRCODE='55000';
  END IF;
  SELECT * INTO claim FROM publication_object_claims stored
  WHERE stored.allocation_kind='publication_intent'
    AND stored.allocation_id=NEW.intent_id FOR SHARE;
  IF NOT FOUND OR claim.finalized_at IS NULL
     OR claim.artifact_id IS DISTINCT FROM NEW.artifact_id
     OR claim.body_object_key IS DISTINCT FROM NEW.body_object_key
     OR claim.body_size_bytes IS DISTINCT FROM NEW.body_size_bytes
     OR claim.body_content_hash IS DISTINCT FROM NEW.body_content_hash THEN
    RAISE EXCEPTION 'publication artifact requires an exact finalized object claim'
      USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION public.require_finalized_publication_object_claim() OWNER TO context_use_boundary_owner;

--
-- Name: reserve_public_artifact_identity(uuid, text, public.public_artifact_allocation_kind, uuid); Type: FUNCTION; Schema: public; Owner: context_use_boundary_owner
--

CREATE FUNCTION public.reserve_public_artifact_identity(p_artifact_id uuid, p_body_object_key text, p_allocation_kind public.public_artifact_allocation_kind, p_allocation_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
BEGIN
  IF p_artifact_id IS NULL OR p_body_object_key IS NULL
     OR p_allocation_kind IS NULL OR p_allocation_id IS NULL THEN
    RAISE EXCEPTION 'complete artifact allocation is required' USING ERRCODE='22023';
  END IF;
  PERFORM lock_public_uuid_namespace(p_artifact_id);
  INSERT INTO public_artifact_id_reservations(
    artifact_id,body_object_key,allocation_kind,allocation_id
  ) VALUES (
    p_artifact_id,p_body_object_key,p_allocation_kind,p_allocation_id
  ) ON CONFLICT (artifact_id) DO NOTHING;
  IF NOT EXISTS (
    SELECT 1 FROM public_artifact_id_reservations reservation
    WHERE reservation.artifact_id=p_artifact_id
      AND reservation.body_object_key=p_body_object_key
      AND reservation.allocation_kind=p_allocation_kind
      AND reservation.allocation_id=p_allocation_id
  ) THEN
    RAISE EXCEPTION 'public artifact UUID is permanently reserved'
      USING ERRCODE='23505';
  END IF;
END;
$$;


ALTER FUNCTION public.reserve_public_artifact_identity(p_artifact_id uuid, p_body_object_key text, p_allocation_kind public.public_artifact_allocation_kind, p_allocation_id uuid) OWNER TO context_use_boundary_owner;

--
-- Name: reserve_public_representation_token(text, uuid, public.publication_target); Type: FUNCTION; Schema: public; Owner: context_use_boundary_owner
--

CREATE FUNCTION public.reserve_public_representation_token(p_representation_token text, p_artifact_id uuid, p_resource_kind public.publication_target) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $_$
DECLARE
  reserved record;
BEGIN
  IF p_representation_token IS NULL
     OR p_representation_token !~ '^[a-f0-9]{64}$'
     OR p_artifact_id IS NULL OR p_resource_kind IS NULL THEN
    RAISE EXCEPTION 'complete public representation identity is required'
      USING ERRCODE='22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'public-representation-token:'||p_representation_token,0
  ));
  SELECT artifact_id,resource_kind INTO reserved
  FROM public_representation_token_reservations
  WHERE representation_token=p_representation_token;
  IF FOUND THEN
    IF reserved.artifact_id IS DISTINCT FROM p_artifact_id
       OR reserved.resource_kind IS DISTINCT FROM p_resource_kind THEN
      RAISE EXCEPTION 'public representation token is permanently reserved'
        USING ERRCODE='23505';
    END IF;
    RETURN;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public_representation_token_reservations
    WHERE artifact_id=p_artifact_id
  ) THEN
    RAISE EXCEPTION 'public artifact already has a representation token'
      USING ERRCODE='23505';
  END IF;
  INSERT INTO public_representation_token_reservations(
    representation_token,artifact_id,resource_kind
  ) VALUES (p_representation_token,p_artifact_id,p_resource_kind);
END;
$_$;


ALTER FUNCTION public.reserve_public_representation_token(p_representation_token text, p_artifact_id uuid, p_resource_kind public.publication_target) OWNER TO context_use_boundary_owner;

--
-- Name: reserve_publication_intent_id(uuid); Type: FUNCTION; Schema: public; Owner: context_use_boundary_owner
--

CREATE FUNCTION public.reserve_publication_intent_id(p_intent_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
BEGIN
  IF p_intent_id IS NULL THEN
    RAISE EXCEPTION 'publication intent identity is required' USING ERRCODE='22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'publication-intent-uuid:'||p_intent_id::text,0
  ));
  IF EXISTS (SELECT 1 FROM publication_intent_id_reservations
    WHERE intent_id=p_intent_id) THEN
    IF NOT EXISTS (SELECT 1 FROM publication_intents
      WHERE id=p_intent_id) THEN
      RAISE EXCEPTION 'publication intent UUID cannot be reused'
        USING ERRCODE='23505';
    END IF;
    RETURN;
  END IF;
  INSERT INTO publication_intent_id_reservations(intent_id) VALUES (p_intent_id);
END;
$$;


ALTER FUNCTION public.reserve_publication_intent_id(p_intent_id uuid) OWNER TO context_use_boundary_owner;

--
-- Name: reserve_publication_intent_id_from_row(); Type: FUNCTION; Schema: public; Owner: context_use_boundary_owner
--

CREATE FUNCTION public.reserve_publication_intent_id_from_row() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
BEGIN
  PERFORM reserve_publication_intent_id(NEW.id);
  RETURN NEW;
END;
$$;


ALTER FUNCTION public.reserve_publication_intent_id_from_row() OWNER TO context_use_boundary_owner;

--
-- Name: reserve_retained_page_artifact_identity(); Type: FUNCTION; Schema: public; Owner: context_use_boundary_owner
--

CREATE FUNCTION public.reserve_retained_page_artifact_identity() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
    IF NEW.artifact_id IS DISTINCT FROM OLD.artifact_id
       OR NEW.body_object_key IS DISTINCT FROM OLD.body_object_key THEN
      RAISE EXCEPTION 'retained public artifact identity is immutable'
        USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  PERFORM reserve_public_artifact_identity(
    NEW.artifact_id,NEW.body_object_key,'retained_page',NEW.artifact_id
  );
  RETURN NEW;
END;
$$;


ALTER FUNCTION public.reserve_retained_page_artifact_identity() OWNER TO context_use_boundary_owner;

--
-- Name: resolve_public_route(text); Type: FUNCTION; Schema: public; Owner: context_use_projection_owner
--

CREATE FUNCTION public.resolve_public_route(p_route text) RETURNS TABLE(state public.public_route_state, route_kind public.public_route_kind, canonical_path text, public_id uuid, representation_token text, public_title text, public_summary text, public_last_edited_at text, public_filename text, public_content_type text, public_width integer, public_height integer, public_duration_seconds text)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    SET "TimeZone" TO 'UTC'
    AS $_$
DECLARE
  requested_kind public_route_kind;
  resolved_public_id uuid;
  expected_resource_kind publication_target;
  actual_resource_kind publication_target;
  resolved_document_id uuid;
  direct_token text;
  page_row record;
  asset_row record;
  assigned boolean := false;
BEGIN
  requested_kind := public_route_kind(p_route);
  IF requested_kind IS NULL THEN
    RAISE EXCEPTION 'public route is not exact or canonical'
      USING ERRCODE='22023';
  END IF;
  route_kind := requested_kind;

  -- `/p/` belongs exclusively to the independently latched canonical setting;
  -- a permanent legacy root alias can never become an implicit fallback.
  IF p_route='/p/' THEN
    SELECT settings.entrypoint_public_id,
      settings.updated_at IS NOT NULL
    INTO resolved_public_id,assigned
    FROM publication_settings settings
    WHERE settings.singleton;
    IF NOT assigned THEN state := 'unassigned'; RETURN NEXT; RETURN; END IF;
    IF resolved_public_id IS NULL THEN
      state := 'inactive'; RETURN NEXT; RETURN;
    END IF;
    SELECT page.* INTO page_row
    FROM public_pages page
    WHERE page.public_id=resolved_public_id;
    IF NOT FOUND THEN state := 'inactive'; RETURN NEXT; RETURN; END IF;
    state := 'active';
    canonical_path := page_row.canonical_path;
    public_id := page_row.public_id;
    representation_token := page_row.representation_token;
    public_title := page_row.public_title;
    public_summary := page_row.public_summary;
    public_last_edited_at := page_row.public_last_edited_at;
    RETURN NEXT;
    RETURN;
  END IF;

  IF p_route ~ '^/p/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    direct_token := substring(p_route FROM 4);
    expected_resource_kind := 'page';
  ELSIF p_route ~ '^/p/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.]md$' THEN
    direct_token := substring(p_route FROM 4 FOR 36);
    expected_resource_kind := 'page';
  ELSIF p_route ~ '^/a/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    direct_token := substring(p_route FROM 4);
    expected_resource_kind := 'asset';
  END IF;

  IF direct_token IS NOT NULL THEN
    resolved_public_id := direct_token::uuid;
    -- Canonical authority wins over aliases only when any grandfathered alias
    -- at that spelling agrees exactly; ambiguity fails closed.
    IF EXISTS (
      SELECT 1 FROM public_route_aliases alias
      WHERE alias.alias_path=p_route
        AND (
          alias.public_id<>resolved_public_id
          OR alias.route_kind<>requested_kind
        )
    ) THEN
      state := 'inactive'; RETURN NEXT; RETURN;
    END IF;
    SELECT resource.resource_kind,resource.document_id
    INTO actual_resource_kind,resolved_document_id
    FROM public_resources resource
    WHERE resource.public_id=resolved_public_id;
    IF NOT FOUND THEN
      state := 'unassigned';
      RETURN NEXT;
      RETURN;
    END IF;
    IF EXISTS (
      SELECT 1 FROM blocking_public_namespace_conflicts conflict
      WHERE conflict.namespace_uuid=resolved_public_id
         OR conflict.public_id=resolved_public_id
         OR conflict.alias_path=p_route
    ) THEN
      state := 'inactive'; RETURN NEXT; RETURN;
    END IF;
    IF resolved_document_id IS NULL
       OR actual_resource_kind<>expected_resource_kind THEN
      state := 'inactive'; RETURN NEXT; RETURN;
    END IF;
  ELSE
    SELECT alias.public_id INTO resolved_public_id
    FROM public_route_aliases alias
    WHERE alias.alias_path=p_route AND alias.route_kind=requested_kind;
    IF NOT FOUND THEN
      state := 'unassigned';
      RETURN NEXT;
      RETURN;
    END IF;
    IF EXISTS (
      SELECT 1 FROM blocking_public_namespace_conflicts conflict
      WHERE conflict.namespace_uuid=resolved_public_id
         OR conflict.public_id=resolved_public_id
         OR conflict.alias_path=p_route
    ) THEN
      state := 'inactive'; RETURN NEXT; RETURN;
    END IF;
    SELECT resource.resource_kind,resource.document_id
    INTO actual_resource_kind,resolved_document_id
    FROM public_resources resource
    WHERE resource.public_id=resolved_public_id;
    IF NOT FOUND OR resolved_document_id IS NULL
       OR (requested_kind='asset' AND actual_resource_kind<>'asset')
       OR (requested_kind<>'asset' AND actual_resource_kind<>'page') THEN
      state := 'inactive'; RETURN NEXT; RETURN;
    END IF;
  END IF;

  IF actual_resource_kind='page' THEN
    SELECT page.* INTO page_row
    FROM public_pages page
    WHERE page.public_id=resolved_public_id;
    IF NOT FOUND THEN state := 'inactive'; RETURN NEXT; RETURN; END IF;
    state := 'active';
    canonical_path := CASE requested_kind
      WHEN 'markdown' THEN page_row.markdown_path
      ELSE page_row.canonical_path END;
    public_id := page_row.public_id;
    representation_token := page_row.representation_token;
    public_title := page_row.public_title;
    public_summary := page_row.public_summary;
    public_last_edited_at := page_row.public_last_edited_at;
  ELSE
    SELECT asset.* INTO asset_row
    FROM public_assets asset
    WHERE asset.public_id=resolved_public_id;
    IF NOT FOUND THEN state := 'inactive'; RETURN NEXT; RETURN; END IF;
    state := 'active';
    canonical_path := asset_row.canonical_path;
    public_id := asset_row.public_id;
    representation_token := asset_row.representation_token;
    public_filename := asset_row.public_filename;
    public_content_type := asset_row.public_content_type;
    public_width := asset_row.public_width;
    public_height := asset_row.public_height;
    public_duration_seconds := asset_row.public_duration_seconds;
  END IF;
  RETURN NEXT;
END;
$_$;


ALTER FUNCTION public.resolve_public_route(p_route text) OWNER TO context_use_projection_owner;

--
-- Name: resolve_storage_route(text); Type: FUNCTION; Schema: public; Owner: context_use_storage_owner
--

CREATE FUNCTION public.resolve_storage_route(p_representation_token text) RETURNS TABLE(resource_kind public.publication_target, representation_token text, body_object_key text, body_size_bytes bigint, body_content_hash text)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $_$
BEGIN
  IF p_representation_token IS NULL
     OR p_representation_token !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'representation token must be exact lowercase hex'
      USING ERRCODE='22023';
  END IF;
  RETURN QUERY
  SELECT 'page'::publication_target,reservation.representation_token,
    artifact.body_object_key,artifact.body_size_bytes::bigint,
    artifact.body_content_hash
  FROM public_representation_token_reservations reservation
  JOIN public_page_artifacts artifact
    ON artifact.representation_token=reservation.representation_token
   AND artifact.artifact_id=reservation.artifact_id
   AND reservation.resource_kind='page'
  JOIN page_publications publication
    ON publication.public_id=artifact.public_id
   AND publication.artifact_id=artifact.artifact_id
  JOIN public_resources resource
    ON resource.public_id=publication.public_id
   AND resource.document_id IS NOT NULL
   AND resource.resource_kind='page'
  WHERE reservation.representation_token=p_representation_token
    AND NOT EXISTS (
      SELECT 1 FROM blocking_public_namespace_conflicts conflict
      WHERE conflict.namespace_uuid IN (artifact.public_id,artifact.artifact_id)
         OR conflict.public_id=artifact.public_id
    )
  UNION ALL
  SELECT 'asset'::publication_target,reservation.representation_token,
    artifact.body_object_key,artifact.body_size_bytes,
    artifact.body_content_hash
  FROM public_representation_token_reservations reservation
  JOIN public_asset_artifacts artifact
    ON artifact.representation_token=reservation.representation_token
   AND artifact.artifact_id=reservation.artifact_id
   AND reservation.resource_kind='asset'
  JOIN asset_publications publication
    ON publication.public_id=artifact.public_id
   AND publication.artifact_id=artifact.artifact_id
  JOIN public_resources resource
    ON resource.public_id=publication.public_id
   AND resource.document_id IS NOT NULL
   AND resource.resource_kind='asset'
  WHERE reservation.representation_token=p_representation_token
    AND NOT EXISTS (
      SELECT 1 FROM blocking_public_namespace_conflicts conflict
      WHERE conflict.namespace_uuid IN (artifact.public_id,artifact.artifact_id)
         OR conflict.public_id=artifact.public_id
    );
END;
$_$;


ALTER FUNCTION public.resolve_storage_route(p_representation_token text) OWNER TO context_use_storage_owner;

--
-- Name: search_private_document_catalog(text, real, bigint, uuid, boolean, integer, public.hypermedia_document_authority, public.hypermedia_document_representation, public.private_document_kind, public.private_document_lifecycle, text, public.private_document_operational_role); Type: FUNCTION; Schema: public; Owner: context_use_projection_owner
--

CREATE FUNCTION public.search_private_document_catalog(p_query text, p_after_rank real, p_after_updated_at_epoch_micros bigint, p_after_document_id uuid, p_include_retired boolean, p_limit integer, p_authority public.hypermedia_document_authority, p_representation public.hypermedia_document_representation, p_document_kind public.private_document_kind, p_lifecycle public.private_document_lifecycle, p_integration text, p_operational_role public.private_document_operational_role) RETURNS TABLE(document jsonb, search_rank real, search_updated_at_epoch_micros text, search_document_id uuid)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
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
      document_search_vector(catalog.title,catalog.summary,'')
    ) AS search_vector
    FROM private_document_catalog catalog
    LEFT JOIN knowledge_search search
      ON search.document_id=catalog.document_id
     AND search.revision_id=catalog.current_revision_id
    WHERE catalog.document_kind='knowledge'
  ), knowledge_term_vectors AS (
    SELECT base.document_id,base.search_vector
    FROM knowledge_base base
    UNION ALL
    SELECT chunk.document_id,chunk.search_vector
    FROM knowledge_search_chunks chunk
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
    FROM knowledge_search_chunks chunk
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


ALTER FUNCTION public.search_private_document_catalog(p_query text, p_after_rank real, p_after_updated_at_epoch_micros bigint, p_after_document_id uuid, p_include_retired boolean, p_limit integer, p_authority public.hypermedia_document_authority, p_representation public.hypermedia_document_representation, p_document_kind public.private_document_kind, p_lifecycle public.private_document_lifecycle, p_integration text, p_operational_role public.private_document_operational_role) OWNER TO context_use_projection_owner;

--
-- Name: set_publication_entrypoint(uuid); Type: FUNCTION; Schema: public; Owner: context_use_boundary_owner
--

CREATE FUNCTION public.set_publication_entrypoint(p_public_id uuid) RETURNS TABLE(public_id uuid, configured boolean, active boolean)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
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


ALTER FUNCTION public.set_publication_entrypoint(p_public_id uuid) OWNER TO context_use_boundary_owner;

--
-- Name: stage_publication_artifact(uuid, public.publication_target, bigint, text, text, text, timestamp with time zone, text, text, integer, integer, text, uuid[], uuid[], text); Type: FUNCTION; Schema: public; Owner: context_use_boundary_owner
--

CREATE FUNCTION public.stage_publication_artifact(p_intent_id uuid, p_target_kind public.publication_target, p_body_size_bytes bigint, p_body_content_hash text, p_public_title text, p_public_summary text, p_public_last_edited_at timestamp with time zone, p_public_filename text, p_public_content_type text, p_public_width integer, p_public_height integer, p_public_duration_seconds text, p_projected_target_public_ids uuid[], p_observed_public_uuid_tokens uuid[], p_projection_receipt_hash text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    SET jit TO 'off'
    SET "TimeZone" TO 'UTC'
    AS $_$
DECLARE
  preliminary record;
  intent publication_intents%ROWTYPE;
  existing publication_artifact_staging%ROWTYPE;
  source_title text;
  source_summary text;
  source_last_edited_at timestamptz;
  source_filename text;
  source_content_type text;
  source_size_bytes bigint;
  source_content_hash text;
  source_width integer;
  source_height integer;
  source_duration_seconds numeric;
  canonical_projected uuid[];
  canonical_observed uuid[];
  derived_representation_token text;
BEGIN
  IF p_intent_id IS NULL OR p_target_kind IS NULL
     OR p_body_size_bytes IS NULL OR p_body_size_bytes<0
     OR p_body_content_hash IS NULL
     OR p_body_content_hash !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'complete publication artifact receipt is required'
      USING ERRCODE='22023';
  END IF;
  canonical_projected := canonical_public_uuid_set(
    p_projected_target_public_ids
  );
  canonical_observed := canonical_public_uuid_set(
    p_observed_public_uuid_tokens
  );
  IF canonical_projected IS DISTINCT FROM p_projected_target_public_ids
     OR canonical_observed IS DISTINCT FROM p_observed_public_uuid_tokens THEN
    RAISE EXCEPTION 'public UUID receipts must be sorted and unique'
      USING ERRCODE='22023';
  END IF;

  -- Staging rows are immutable. A lost reply may therefore be answered from
  -- the exact receipt without waiting on a source that has since drifted or on
  -- confirmation that has already started. A different retry can never amend
  -- the frozen evidence.
  SELECT * INTO existing
  FROM publication_artifact_staging staging
  WHERE staging.intent_id=p_intent_id;
  IF FOUND THEN
    IF existing.target_kind IS DISTINCT FROM p_target_kind
       OR existing.body_size_bytes IS DISTINCT FROM p_body_size_bytes
       OR existing.body_content_hash IS DISTINCT FROM p_body_content_hash
       OR existing.public_title IS DISTINCT FROM p_public_title
       OR existing.public_summary IS DISTINCT FROM p_public_summary
       OR existing.public_last_edited_at IS DISTINCT FROM p_public_last_edited_at
       OR existing.public_filename IS DISTINCT FROM p_public_filename
       OR existing.public_content_type IS DISTINCT FROM p_public_content_type
       OR existing.public_width IS DISTINCT FROM p_public_width
       OR existing.public_height IS DISTINCT FROM p_public_height
       OR existing.public_duration_seconds::text IS DISTINCT FROM
         p_public_duration_seconds
       OR existing.projected_target_public_ids IS DISTINCT FROM
         p_projected_target_public_ids
       OR existing.observed_public_uuid_tokens IS DISTINCT FROM
         p_observed_public_uuid_tokens
       OR existing.projection_receipt_hash IS DISTINCT FROM
         p_projection_receipt_hash THEN
      RAISE EXCEPTION 'publication artifact staging retry does not match'
        USING ERRCODE='23505';
    END IF;
    RETURN;
  END IF;

  PERFORM pg_advisory_xact_lock_shared(
    hashtextextended('context-use:knowledge-lifecycle',0)
  );
  SELECT stored.target_kind,stored.target_document_id,stored.expected_revision_id,
    stored.action
  INTO preliminary
  FROM publication_intents stored WHERE stored.id=p_intent_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'canonical publication intent not found' USING ERRCODE='P0002';
  END IF;
  IF preliminary.action<>'publish'
     OR preliminary.target_kind IS DISTINCT FROM p_target_kind THEN
    RAISE EXCEPTION 'artifact receipt does not match publication intent'
      USING ERRCODE='22023';
  END IF;
  PERFORM lock_publication_context(
    preliminary.target_kind,preliminary.target_document_id,
    preliminary.expected_revision_id
  );
  PERFORM assert_publication_intent_current(p_intent_id,false);
  SELECT * INTO intent
  FROM publication_intents stored WHERE stored.id=p_intent_id;

  IF EXISTS (
    SELECT 1 FROM confirmation_challenges challenge
    WHERE challenge.intent_kind='publication' AND challenge.intent_id=intent.id
  ) THEN
    RAISE EXCEPTION 'publication artifact cannot be staged after challenge issuance'
      USING ERRCODE='55000';
  END IF;

  IF intent.target_kind='page' THEN
    SELECT version.title,version.summary,version.created_at,
      revision.body_size_bytes::bigint,revision.body_content_hash
    INTO source_title,source_summary,source_last_edited_at,
      source_size_bytes,source_content_hash
    FROM hypermedia_document_revisions revision
    JOIN knowledge_page_versions version
      ON version.id=revision.id AND version.page_id=revision.document_id
    WHERE revision.id=intent.expected_revision_id
      AND revision.document_id=intent.target_document_id;
    PERFORM assert_public_metadata_safe(
      'page',source_title,source_summary,NULL
    );
    IF p_body_size_bytes>4000000
       OR p_public_title IS DISTINCT FROM source_title
       OR p_public_summary IS DISTINCT FROM source_summary
       OR p_public_last_edited_at IS DISTINCT FROM source_last_edited_at
       OR p_public_filename IS NOT NULL OR p_public_content_type IS NOT NULL
       OR p_public_width IS NOT NULL OR p_public_height IS NOT NULL
       OR p_public_duration_seconds IS NOT NULL
       OR p_projected_target_public_ids IS DISTINCT FROM
         intent.projected_target_public_ids
       OR p_observed_public_uuid_tokens IS DISTINCT FROM
         intent.projected_target_public_ids
       OR p_projection_receipt_hash IS DISTINCT FROM
         intent.projection_receipt_hash THEN
      RAISE EXCEPTION 'page artifact receipt does not match frozen projection'
        USING ERRCODE='22023';
    END IF;
  ELSE
    SELECT asset.filename,asset.content_type,asset.size_bytes,
      asset.content_hash,asset.width,asset.height,asset.duration_seconds
    INTO source_filename,source_content_type,source_size_bytes,
      source_content_hash,source_width,source_height,source_duration_seconds
    FROM assets asset WHERE asset.id=intent.target_document_id;
    PERFORM assert_public_metadata_safe(
      'asset',NULL,NULL,source_filename
    );
    IF p_body_size_bytes>5000000000
       OR p_body_size_bytes IS DISTINCT FROM source_size_bytes
       OR p_body_content_hash IS DISTINCT FROM source_content_hash
       OR p_public_title IS NOT NULL OR p_public_summary IS NOT NULL
       OR p_public_last_edited_at IS NOT NULL
       OR p_public_filename IS DISTINCT FROM source_filename
       OR p_public_content_type IS DISTINCT FROM source_content_type
       OR NOT public_metadata_is_safe(source_content_type)
       OR length(source_content_type)>255
       OR NOT public_duration_is_safe(source_duration_seconds)
       OR p_public_width IS DISTINCT FROM source_width
       OR p_public_height IS DISTINCT FROM source_height
       OR p_public_duration_seconds IS DISTINCT FROM
         source_duration_seconds::text
       OR cardinality(p_projected_target_public_ids)<>0
       OR cardinality(p_observed_public_uuid_tokens)<>0
       OR p_projection_receipt_hash IS NOT NULL THEN
      RAISE EXCEPTION 'asset artifact receipt does not match frozen source'
        USING ERRCODE='22023';
    END IF;
  END IF;

  derived_representation_token := publication_representation_token(
    jsonb_build_object(
      'target_kind',intent.target_kind,
      'candidate_public_id',intent.candidate_public_id,
      'artifact_id',intent.candidate_artifact_id,
      'source_fingerprint',intent.expected_source_fingerprint,
      'body_object_key',intent.candidate_object_key,
      'body_size_bytes',p_body_size_bytes,
      'body_content_hash',p_body_content_hash,
      'public_title',source_title,
      'public_summary',source_summary,
      'public_last_edited_at',source_last_edited_at,
      'public_filename',source_filename,
      'public_content_type',source_content_type,
      'public_width',source_width,
      'public_height',source_height,
      'public_duration_seconds',source_duration_seconds,
      'projected_target_public_ids',intent.projected_target_public_ids,
      'observed_public_uuid_tokens',intent.projected_target_public_ids,
      'projection_receipt_hash',intent.projection_receipt_hash
    )
  );

  SELECT * INTO existing
  FROM publication_artifact_staging staging
  WHERE staging.intent_id=intent.id;
  IF FOUND THEN
    IF existing.target_kind IS DISTINCT FROM intent.target_kind
       OR existing.candidate_public_id IS DISTINCT FROM intent.candidate_public_id
       OR existing.artifact_id IS DISTINCT FROM intent.candidate_artifact_id
       OR existing.body_object_key IS DISTINCT FROM intent.candidate_object_key
       OR existing.body_size_bytes IS DISTINCT FROM p_body_size_bytes
       OR existing.body_content_hash IS DISTINCT FROM p_body_content_hash
       OR existing.public_title IS DISTINCT FROM p_public_title
       OR existing.public_summary IS DISTINCT FROM p_public_summary
       OR existing.public_last_edited_at IS DISTINCT FROM p_public_last_edited_at
       OR existing.public_filename IS DISTINCT FROM p_public_filename
       OR existing.public_content_type IS DISTINCT FROM p_public_content_type
       OR existing.public_width IS DISTINCT FROM p_public_width
       OR existing.public_height IS DISTINCT FROM p_public_height
       OR existing.public_duration_seconds::text IS DISTINCT FROM
         p_public_duration_seconds
       OR existing.projected_target_public_ids IS DISTINCT FROM
         p_projected_target_public_ids
       OR existing.observed_public_uuid_tokens IS DISTINCT FROM
         p_observed_public_uuid_tokens
       OR existing.projection_receipt_hash IS DISTINCT FROM
         p_projection_receipt_hash
       OR existing.representation_token IS DISTINCT FROM
         derived_representation_token THEN
      RAISE EXCEPTION 'publication artifact staging retry does not match'
        USING ERRCODE='23505';
    END IF;
    RETURN;
  END IF;

  PERFORM reserve_public_representation_token(
    derived_representation_token,intent.candidate_artifact_id,intent.target_kind
  );
  INSERT INTO publication_artifact_staging(
    intent_id,target_kind,candidate_public_id,artifact_id,body_object_key,
    body_size_bytes,body_content_hash,public_title,public_summary,
    public_last_edited_at,public_filename,public_content_type,public_width,
    public_height,public_duration_seconds,projected_target_public_ids,
    observed_public_uuid_tokens,projection_receipt_hash,
    allocation_kind,allocation_id,representation_token
  ) VALUES (
    intent.id,intent.target_kind,intent.candidate_public_id,
    intent.candidate_artifact_id,intent.candidate_object_key,
    p_body_size_bytes,p_body_content_hash,p_public_title,p_public_summary,
    p_public_last_edited_at,p_public_filename,p_public_content_type,
    p_public_width,p_public_height,p_public_duration_seconds::numeric,
    p_projected_target_public_ids,p_observed_public_uuid_tokens,
    p_projection_receipt_hash,'publication_intent',intent.id,
    derived_representation_token
  );
END;
$_$;


ALTER FUNCTION public.stage_publication_artifact(p_intent_id uuid, p_target_kind public.publication_target, p_body_size_bytes bigint, p_body_content_hash text, p_public_title text, p_public_summary text, p_public_last_edited_at timestamp with time zone, p_public_filename text, p_public_content_type text, p_public_width integer, p_public_height integer, p_public_duration_seconds text, p_projected_target_public_ids uuid[], p_observed_public_uuid_tokens uuid[], p_projection_receipt_hash text) OWNER TO context_use_boundary_owner;

--
-- Name: validate_active_publication_pin(); Type: FUNCTION; Schema: public; Owner: context_use_boundary_owner
--

CREATE FUNCTION public.validate_active_publication_pin() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
DECLARE target_document_id uuid;
BEGIN
  IF TG_OP='UPDATE' THEN
    RAISE EXCEPTION 'active canonical publication pins are immutable; unpublish first'
      USING ERRCODE='23514';
  END IF;
  SELECT document_id INTO target_document_id
  FROM public_resources WHERE public_id=NEW.public_id;
  IF TG_TABLE_NAME='page_publications' THEN
    PERFORM 1 FROM knowledge_pages page
    WHERE page.id=target_document_id AND page.archived_at IS NULL
    FOR SHARE OF page;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'a page pin requires an active mapped private page'
        USING ERRCODE='23514';
    END IF;
    PERFORM 1 FROM public_resources resource
    WHERE resource.public_id=NEW.public_id
      AND resource.document_id=target_document_id
      AND resource.resource_kind='page' FOR SHARE OF resource;
  ELSIF TG_TABLE_NAME='asset_publications' THEN
    PERFORM 1 FROM assets asset
    WHERE asset.id=target_document_id AND asset.deleted_at IS NULL
    FOR SHARE OF asset;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'an asset pin requires an active mapped private asset'
        USING ERRCODE='23514';
    END IF;
    PERFORM 1 FROM public_resources resource
    WHERE resource.public_id=NEW.public_id
      AND resource.document_id=target_document_id
      AND resource.resource_kind='asset' FOR SHARE OF resource;
  ELSE
    RAISE EXCEPTION 'canonical pin guard attached to an unsupported relation'
      USING ERRCODE='55000';
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'a publication pin requires its exact active mapping'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION public.validate_active_publication_pin() OWNER TO context_use_boundary_owner;

--
-- Name: validate_automation_registry_documents(); Type: FUNCTION; Schema: public; Owner: context_use_boundary_owner
--

CREATE FUNCTION public.validate_automation_registry_documents() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
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


ALTER FUNCTION public.validate_automation_registry_documents() OWNER TO context_use_boundary_owner;

--
-- Name: validate_global_knowledge_guide(); Type: FUNCTION; Schema: public; Owner: context_use_boundary_owner
--

CREATE FUNCTION public.validate_global_knowledge_guide() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
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


ALTER FUNCTION public.validate_global_knowledge_guide() OWNER TO context_use_boundary_owner;

--
-- Name: validate_knowledge_page_document_identity(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.validate_knowledge_page_document_identity() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM hypermedia_documents document
    WHERE document.id=NEW.id
      AND document.authority='knowledge'
      AND document.representation='markdown'
  ) THEN
    RAISE EXCEPTION 'knowledge page identity collides with a non-Markdown knowledge document'
      USING ERRCODE='23505';
  END IF;
  RETURN NULL;
END;
$$;


ALTER FUNCTION public.validate_knowledge_page_document_identity() OWNER TO postgres;

--
-- Name: validate_markdown_document_revision(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.validate_markdown_document_revision() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM hypermedia_documents document
    WHERE document.id=NEW.document_id
      AND document.representation='markdown'
  ) THEN
    RAISE EXCEPTION 'document revisions require Markdown document identity'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION public.validate_markdown_document_revision() OWNER TO postgres;

--
-- Name: validate_public_resource_mapping(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.validate_public_resource_mapping() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$
BEGIN
  IF NEW.document_id IS NULL THEN RETURN NEW; END IF;
  IF NEW.resource_kind='page' AND EXISTS (
    SELECT 1 FROM knowledge_pages WHERE id=NEW.document_id
  ) THEN
    RETURN NEW;
  END IF;
  IF NEW.resource_kind='asset' AND EXISTS (
    SELECT 1 FROM assets WHERE id=NEW.document_id
  ) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'public resource kind does not match its private document'
    USING ERRCODE='23514';
END;
$$;


ALTER FUNCTION public.validate_public_resource_mapping() OWNER TO postgres;

--
-- Name: validate_source_record_document_identity(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.validate_source_record_document_identity() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM hypermedia_documents document
    WHERE document.id=NEW.document_id
      AND document.authority='source'
      AND document.representation='markdown'
  ) THEN
    RAISE EXCEPTION 'source record identity collides with a non-source document'
      USING ERRCODE='23505';
  END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION public.validate_source_record_document_identity() OWNER TO postgres;

SET default_table_access_method = heap;

--
-- Name: account; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.account (
    id text NOT NULL,
    "accountId" text NOT NULL,
    "providerId" text NOT NULL,
    "userId" text NOT NULL,
    "accessToken" text,
    "refreshToken" text,
    "idToken" text,
    "accessTokenExpiresAt" timestamp with time zone,
    "refreshTokenExpiresAt" timestamp with time zone,
    scope text,
    password text,
    "createdAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL
);


ALTER TABLE public.account OWNER TO postgres;

--
-- Name: asset_publications; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.asset_publications (
    public_id uuid NOT NULL,
    resource_kind public.publication_target DEFAULT 'asset'::public.publication_target NOT NULL,
    artifact_id uuid NOT NULL,
    published_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT asset_publications_resource_kind_check CHECK ((resource_kind = 'asset'::public.publication_target))
);


ALTER TABLE public.asset_publications OWNER TO postgres;

--
-- Name: assets; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.assets (
    id uuid NOT NULL,
    filename text NOT NULL,
    content_type text NOT NULL,
    size_bytes bigint NOT NULL,
    content_hash text NOT NULL,
    s3_object_key text NOT NULL,
    width integer,
    height integer,
    duration_seconds numeric,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT assets_content_hash_check CHECK ((content_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT assets_content_type_check CHECK (((length(content_type) >= 1) AND (length(content_type) <= 255))),
    CONSTRAINT assets_duration_seconds_check CHECK (((duration_seconds IS NULL) OR (duration_seconds >= (0)::numeric))),
    CONSTRAINT assets_filename_check CHECK (((length(filename) >= 1) AND (length(filename) <= 1024))),
    CONSTRAINT assets_height_check CHECK (((height IS NULL) OR (height > 0))),
    CONSTRAINT assets_s3_object_key_check CHECK ((s3_object_key ~ '^objects/[a-f0-9-]+$'::text)),
    CONSTRAINT assets_size_bytes_check CHECK ((size_bytes >= 0)),
    CONSTRAINT assets_width_check CHECK (((width IS NULL) OR (width > 0)))
);


ALTER TABLE public.assets OWNER TO postgres;

--
-- Name: automation_registry; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.automation_registry (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    key text NOT NULL,
    name text NOT NULL,
    instructions_document_id uuid NOT NULL,
    state_document_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    disabled_at timestamp with time zone,
    CONSTRAINT automation_registry_check CHECK (((state_document_id IS NULL) OR (state_document_id <> instructions_document_id))),
    CONSTRAINT automation_registry_key_check CHECK ((key ~ '^[a-z0-9]+(-[a-z0-9]+)*$'::text)),
    CONSTRAINT automation_registry_name_check CHECK (((length(TRIM(BOTH FROM name)) >= 1) AND (length(TRIM(BOTH FROM name)) <= 160)))
);


ALTER TABLE public.automation_registry OWNER TO postgres;

--
-- Name: public_namespace_conflicts; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.public_namespace_conflicts (
    conflict_key text NOT NULL,
    namespace_uuid uuid NOT NULL,
    conflict_kind text NOT NULL,
    public_id uuid,
    alias_path text,
    conflicting_identity_kind text NOT NULL,
    conflict_lifecycle text NOT NULL,
    detected_at timestamp with time zone DEFAULT now() NOT NULL,
    resolved_at timestamp with time zone,
    CONSTRAINT public_namespace_conflicts_check CHECK (((resolved_at IS NULL) OR (resolved_at >= detected_at))),
    CONSTRAINT public_namespace_conflicts_conflict_kind_check CHECK ((conflict_kind = ANY (ARRAY['public_id_private_id'::text, 'public_id_artifact_id'::text, 'public_id_alias_token'::text, 'alias_token_private_id'::text, 'alias_token_artifact_id'::text, 'alias_token_public_mapping'::text, 'artifact_id_private_id'::text]))),
    CONSTRAINT public_namespace_conflicts_conflict_lifecycle_check CHECK ((conflict_lifecycle = 'permanent'::text))
);


ALTER TABLE public.public_namespace_conflicts OWNER TO postgres;

--
-- Name: blocking_public_namespace_conflicts; Type: VIEW; Schema: public; Owner: context_use_projection_owner
--

CREATE VIEW public.blocking_public_namespace_conflicts WITH (security_barrier='true', security_invoker='false') AS
 SELECT conflict_key,
    namespace_uuid,
    conflict_kind,
    public_id,
    alias_path,
    conflicting_identity_kind,
    conflict_lifecycle,
    detected_at
   FROM public.public_namespace_conflicts conflict
  WHERE (resolved_at IS NULL);


ALTER VIEW public.blocking_public_namespace_conflicts OWNER TO context_use_projection_owner;

--
-- Name: confirmation_challenges; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.confirmation_challenges (
    intent_kind public.confirmation_intent_kind NOT NULL,
    intent_id uuid NOT NULL,
    challenge text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT confirmation_challenges_challenge_check CHECK ((challenge ~ '^[A-Za-z0-9_-]{43,128}$'::text))
);


ALTER TABLE public.confirmation_challenges OWNER TO postgres;

--
-- Name: document_links; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.document_links (
    source_revision_id uuid NOT NULL,
    target_document_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.document_links OWNER TO postgres;

--
-- Name: hypermedia_bootstrap_allocations; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.hypermedia_bootstrap_allocations (
    document_kind text NOT NULL,
    document_id uuid NOT NULL,
    revision_id uuid NOT NULL,
    allocated_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT hypermedia_bootstrap_allocations_check CHECK (((completed_at IS NULL) OR (completed_at >= allocated_at))),
    CONSTRAINT hypermedia_bootstrap_allocations_document_kind_check CHECK ((document_kind = ANY (ARRAY['global_guide'::text, 'activity_distiller_instructions'::text, 'activity_distiller_state'::text, 'diary_composer_instructions'::text, 'diary_composer_state'::text])))
);


ALTER TABLE public.hypermedia_bootstrap_allocations OWNER TO postgres;

--
-- Name: hypermedia_document_revisions; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.hypermedia_document_revisions (
    id uuid NOT NULL,
    document_id uuid NOT NULL,
    revision_number integer NOT NULL,
    body_object_key text NOT NULL,
    body_size_bytes integer NOT NULL,
    body_content_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    links_indexed_at timestamp with time zone,
    links_index_attempted_at timestamp with time zone,
    CONSTRAINT hypermedia_document_revisions_body_content_hash_check CHECK ((body_content_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT hypermedia_document_revisions_body_object_key_check CHECK ((body_object_key ~ '^documents/private/[0-9a-f-]{36}\.md$'::text)),
    CONSTRAINT hypermedia_document_revisions_body_size_bytes_check CHECK (((body_size_bytes >= 0) AND (body_size_bytes <= 67108864))),
    CONSTRAINT hypermedia_document_revisions_revision_number_check CHECK ((revision_number > 0))
);


ALTER TABLE public.hypermedia_document_revisions OWNER TO postgres;

--
-- Name: hypermedia_documents; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.hypermedia_documents (
    id uuid NOT NULL,
    authority public.hypermedia_document_authority NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    representation public.hypermedia_document_representation DEFAULT 'markdown'::public.hypermedia_document_representation NOT NULL,
    CONSTRAINT hypermedia_documents_authority_representation_check CHECK ((((authority = 'source'::public.hypermedia_document_authority) AND (representation = 'markdown'::public.hypermedia_document_representation)) OR (authority = 'knowledge'::public.hypermedia_document_authority)))
);


ALTER TABLE public.hypermedia_documents OWNER TO postgres;

--
-- Name: jwks; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.jwks (
    id text NOT NULL,
    "publicKey" text NOT NULL,
    "privateKey" text NOT NULL,
    "createdAt" timestamp with time zone NOT NULL,
    "expiresAt" timestamp with time zone,
    alg text,
    crv text
);


ALTER TABLE public.jwks OWNER TO postgres;

--
-- Name: knowledge_asset_links; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.knowledge_asset_links (
    source_version_id uuid NOT NULL,
    target_asset_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.knowledge_asset_links OWNER TO postgres;

--
-- Name: knowledge_export_intents; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.knowledge_export_intents (
    id uuid NOT NULL,
    owner_user_id text NOT NULL,
    session_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    confirmed_at timestamp with time zone,
    download_started_at timestamp with time zone,
    CONSTRAINT knowledge_export_intents_confirmation CHECK (((confirmed_at IS NOT NULL) OR (download_started_at IS NULL))),
    CONSTRAINT knowledge_export_intents_expiry CHECK (((expires_at > created_at) AND (((confirmed_at IS NULL) AND (expires_at <= (created_at + '00:05:00'::interval))) OR ((confirmed_at IS NOT NULL) AND (expires_at <= (confirmed_at + '24:00:00'::interval)))))),
    CONSTRAINT knowledge_export_intents_owner CHECK ((owner_user_id = 'context-use-owner'::text)),
    CONSTRAINT knowledge_export_intents_session_id_check CHECK (((length(session_id) >= 1) AND (length(session_id) <= 512)))
);


ALTER TABLE public.knowledge_export_intents OWNER TO postgres;

--
-- Name: knowledge_page_changes; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.knowledge_page_changes (
    change_sequence bigint NOT NULL,
    page_id uuid NOT NULL,
    version_id uuid NOT NULL,
    version_number integer NOT NULL,
    change_kind text NOT NULL,
    title text NOT NULL,
    commit_message text NOT NULL,
    actor_kind public.actor_kind,
    actor_subject text,
    changed_at timestamp with time zone NOT NULL,
    CONSTRAINT knowledge_page_changes_change_kind_check CHECK ((change_kind = ANY (ARRAY['created'::text, 'updated'::text, 'archived'::text, 'deleted'::text]))),
    CONSTRAINT knowledge_page_changes_version_number_check CHECK ((version_number > 0))
);


ALTER TABLE public.knowledge_page_changes OWNER TO postgres;

--
-- Name: knowledge_page_changes_change_sequence_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

ALTER TABLE public.knowledge_page_changes ALTER COLUMN change_sequence ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.knowledge_page_changes_change_sequence_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: knowledge_page_versions; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.knowledge_page_versions (
    id uuid NOT NULL,
    page_id uuid NOT NULL,
    version_number integer NOT NULL,
    title text NOT NULL,
    summary text NOT NULL,
    commit_message text NOT NULL,
    actor_kind public.actor_kind NOT NULL,
    actor_subject text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT knowledge_page_versions_actor_subject_check CHECK (((length(actor_subject) >= 1) AND (length(actor_subject) <= 512))),
    CONSTRAINT knowledge_page_versions_commit_message_check CHECK (((length(TRIM(BOTH FROM commit_message)) >= 3) AND (length(TRIM(BOTH FROM commit_message)) <= 240))),
    CONSTRAINT knowledge_page_versions_summary_check CHECK ((((length(TRIM(BOTH FROM summary)) >= 1) AND (length(TRIM(BOTH FROM summary)) <= 320)) AND (summary !~ E'[\r\n]'::text))),
    CONSTRAINT knowledge_page_versions_title_check CHECK (((length(title) >= 1) AND (length(title) <= 240))),
    CONSTRAINT knowledge_page_versions_version_number_check CHECK ((version_number > 0))
);


ALTER TABLE public.knowledge_page_versions OWNER TO postgres;

--
-- Name: knowledge_pages; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.knowledge_pages (
    id uuid NOT NULL,
    current_version_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    archived_at timestamp with time zone,
    search_vector tsvector DEFAULT ''::tsvector NOT NULL
);


ALTER TABLE public.knowledge_pages OWNER TO postgres;

--
-- Name: knowledge_revision_contracts; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.knowledge_revision_contracts (
    revision_id uuid NOT NULL,
    document_id uuid NOT NULL,
    link_contract public.knowledge_revision_link_contract DEFAULT 'generic_document_v1'::public.knowledge_revision_link_contract NOT NULL,
    provenance public.knowledge_revision_contract_provenance NOT NULL,
    body_content_hash text NOT NULL,
    target_document_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    registered_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT knowledge_revision_contracts_body_content_hash_check CHECK ((body_content_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT knowledge_revision_contracts_target_document_ids_check CHECK (((cardinality(target_document_ids) <= 100000) AND (array_position(target_document_ids, NULL::uuid) IS NULL)))
);


ALTER TABLE public.knowledge_revision_contracts OWNER TO postgres;

--
-- Name: knowledge_search; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.knowledge_search (
    document_id uuid NOT NULL,
    revision_id uuid NOT NULL,
    search_vector tsvector NOT NULL,
    indexed_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.knowledge_search OWNER TO postgres;

--
-- Name: knowledge_search_chunks; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.knowledge_search_chunks (
    document_id uuid NOT NULL,
    revision_id uuid NOT NULL,
    chunk_number integer NOT NULL,
    search_vector tsvector NOT NULL,
    CONSTRAINT knowledge_search_chunks_chunk_number_check CHECK ((chunk_number >= 0))
);


ALTER TABLE public.knowledge_search_chunks OWNER TO postgres;

--
-- Name: knowledge_settings; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.knowledge_settings (
    singleton boolean DEFAULT true NOT NULL,
    global_guide_document_id uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT knowledge_settings_singleton_check CHECK (singleton)
);


ALTER TABLE public.knowledge_settings OWNER TO postgres;

--
-- Name: public_artifact_id_reservations; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.public_artifact_id_reservations (
    artifact_id uuid NOT NULL,
    body_object_key text NOT NULL,
    allocation_kind public.public_artifact_allocation_kind NOT NULL,
    allocation_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.public_artifact_id_reservations OWNER TO postgres;

--
-- Name: public_resources; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.public_resources (
    public_id uuid DEFAULT gen_random_uuid() NOT NULL,
    document_id uuid,
    resource_kind public.publication_target NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    original_document_id uuid,
    CONSTRAINT public_resources_original_mapping CHECK (((document_id IS NULL) OR ((original_document_id IS NOT NULL) AND (document_id = original_document_id))))
);


ALTER TABLE public.public_resources OWNER TO postgres;

--
-- Name: public_route_aliases; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.public_route_aliases (
    alias_path text NOT NULL,
    route_kind public.public_route_kind NOT NULL,
    public_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT public_route_aliases_exact_path CHECK (
CASE route_kind
    WHEN 'page'::public.public_route_kind THEN (alias_path ~ '^/p/[a-z0-9][a-z0-9/_-]*$'::text)
    WHEN 'directory'::public.public_route_kind THEN ((alias_path = '/p/'::text) OR ((alias_path ~ '^/p/[a-z0-9][a-z0-9/_-]*/$'::text) AND (alias_path !~ '//'::text)))
    WHEN 'markdown'::public.public_route_kind THEN (alias_path ~ '^/p/[a-z0-9][a-z0-9/_-]*[.]md$'::text)
    WHEN 'asset'::public.public_route_kind THEN (alias_path ~ '^/a/[a-z0-9][a-z0-9/_-]*$'::text)
    ELSE NULL::boolean
END)
);


ALTER TABLE public.public_route_aliases OWNER TO postgres;

--
-- Name: live_public_namespace_conflicts; Type: VIEW; Schema: public; Owner: context_use_projection_owner
--

CREATE VIEW public.live_public_namespace_conflicts WITH (security_barrier='true', security_invoker='false') AS
 WITH private_identity(kind, id) AS (
         SELECT 'document'::text AS "?column?",
            hypermedia_documents.id
           FROM public.hypermedia_documents
        UNION ALL
         SELECT 'revision'::text,
            hypermedia_document_revisions.id
           FROM public.hypermedia_document_revisions
        UNION ALL
         SELECT 'historical_document'::text,
            public_resources.original_document_id
           FROM public.public_resources
          WHERE (public_resources.original_document_id IS NOT NULL)
        ), public_candidate(public_id, document_id, resource_kind) AS (
         SELECT public_resources.public_id,
            public_resources.original_document_id,
            public_resources.resource_kind
           FROM public.public_resources
        ), alias_token AS (
         SELECT public_route_aliases.alias_path,
            public_route_aliases.route_kind,
            public_route_aliases.public_id,
            public.canonical_legacy_alias_uuid(public_route_aliases.alias_path) AS token,
            public.canonical_legacy_alias_kind(public_route_aliases.alias_path) AS expected_route_kind
           FROM public.public_route_aliases
          WHERE (public.canonical_legacy_alias_uuid(public_route_aliases.alias_path) IS NOT NULL)
        ), detected AS (
         SELECT DISTINCT ((('public:resource:'::text || (candidate.public_id)::text) || ':private:'::text) || private.kind) AS conflict_key,
            candidate.public_id AS namespace_uuid,
            'public_id_private_id'::text AS conflict_kind,
            candidate.public_id,
            NULL::text AS alias_path,
            private.kind AS identity_kind
           FROM (public_candidate candidate
             JOIN private_identity private ON ((private.id = candidate.public_id)))
        UNION
         SELECT DISTINCT (('public:resource:'::text || (candidate.public_id)::text) || ':artifact'::text),
            candidate.public_id,
            'public_id_artifact_id'::text,
            candidate.public_id,
            NULL::text AS text,
            'public_artifact'::text
           FROM (public_candidate candidate
             JOIN public.public_artifact_id_reservations artifact ON ((artifact.artifact_id = candidate.public_id)))
        UNION
         SELECT DISTINCT ((('public:resource:'::text || (candidate.public_id)::text) || ':alias:'::text) || alias.alias_path),
            candidate.public_id,
            'public_id_alias_token'::text,
            candidate.public_id,
            alias.alias_path,
            'legacy_alias_token'::text
           FROM (public_candidate candidate
             JOIN alias_token alias ON ((alias.token = candidate.public_id)))
          WHERE ((alias.public_id <> candidate.public_id) OR (alias.route_kind <> alias.expected_route_kind) OR ((candidate.resource_kind = 'page'::public.publication_target) AND (alias.route_kind <> ALL (ARRAY['page'::public.public_route_kind, 'markdown'::public.public_route_kind]))) OR ((candidate.resource_kind = 'asset'::public.publication_target) AND (alias.route_kind <> 'asset'::public.public_route_kind)))
        UNION
         SELECT DISTINCT ((('alias:'::text || alias.alias_path) || ':private:'::text) || private.kind),
            alias.token,
            'alias_token_private_id'::text,
            alias.public_id,
            alias.alias_path,
            private.kind
           FROM (alias_token alias
             JOIN private_identity private ON ((private.id = alias.token)))
        UNION
         SELECT DISTINCT (('alias:'::text || alias.alias_path) || ':artifact'::text),
            alias.token,
            'alias_token_artifact_id'::text,
            alias.public_id,
            alias.alias_path,
            'public_artifact'::text
           FROM (alias_token alias
             JOIN public.public_artifact_id_reservations artifact ON ((artifact.artifact_id = alias.token)))
        UNION
         SELECT DISTINCT ((('artifact:'::text || (artifact.artifact_id)::text) || ':private:'::text) || private.kind),
            artifact.artifact_id,
            'artifact_id_private_id'::text,
            NULL::uuid AS uuid,
            NULL::text AS text,
            private.kind
           FROM (public.public_artifact_id_reservations artifact
             JOIN private_identity private ON ((private.id = artifact.artifact_id)))
        UNION
         SELECT DISTINCT (('alias:'::text || alias.alias_path) || ':mapping'::text),
            alias.token,
            'alias_token_public_mapping'::text,
            alias.public_id,
            alias.alias_path,
            'public_resource'::text
           FROM (alias_token alias
             LEFT JOIN public.public_resources resource ON ((resource.public_id = alias.token)))
          WHERE ((resource.public_id IS NULL) OR (alias.public_id <> alias.token) OR (alias.route_kind <> alias.expected_route_kind) OR ((resource.resource_kind = 'page'::public.publication_target) AND (alias.route_kind <> ALL (ARRAY['page'::public.public_route_kind, 'markdown'::public.public_route_kind]))) OR ((resource.resource_kind = 'asset'::public.publication_target) AND (alias.route_kind <> 'asset'::public.public_route_kind)))
        )
 SELECT conflict_key,
    namespace_uuid,
    conflict_kind,
    public_id,
    alias_path,
    identity_kind AS conflicting_identity_kind,
    'permanent'::text AS conflict_lifecycle
   FROM detected;


ALTER VIEW public.live_public_namespace_conflicts OWNER TO context_use_projection_owner;

--
-- Name: oauthAccessToken; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public."oauthAccessToken" (
    id text NOT NULL,
    token text NOT NULL,
    "clientId" text NOT NULL,
    "sessionId" text,
    "userId" text,
    "referenceId" text,
    "refreshId" text,
    "expiresAt" timestamp with time zone NOT NULL,
    "createdAt" timestamp with time zone NOT NULL,
    scopes jsonb NOT NULL,
    "authorizationCodeId" text,
    resources jsonb,
    "requestedUserInfoClaims" jsonb,
    revoked timestamp with time zone,
    confirmation jsonb
);


ALTER TABLE public."oauthAccessToken" OWNER TO postgres;

--
-- Name: oauthClient; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public."oauthClient" (
    id text NOT NULL,
    "clientId" text NOT NULL,
    "clientSecret" text,
    disabled boolean,
    "skipConsent" boolean,
    "enableEndSession" boolean,
    "subjectType" text,
    scopes jsonb,
    "userId" text,
    "createdAt" timestamp with time zone,
    "updatedAt" timestamp with time zone,
    name text,
    uri text,
    icon text,
    contacts jsonb,
    tos text,
    policy text,
    "softwareId" text,
    "softwareVersion" text,
    "softwareStatement" text,
    "redirectUris" jsonb NOT NULL,
    "postLogoutRedirectUris" jsonb,
    "tokenEndpointAuthMethod" text,
    "grantTypes" jsonb,
    "responseTypes" jsonb,
    public boolean,
    type text,
    "requirePKCE" boolean,
    "referenceId" text,
    metadata jsonb,
    "dpopBoundAccessTokens" boolean DEFAULT false NOT NULL
);


ALTER TABLE public."oauthClient" OWNER TO postgres;

--
-- Name: oauthClientAssertion; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public."oauthClientAssertion" (
    id text NOT NULL,
    "expiresAt" timestamp with time zone NOT NULL
);


ALTER TABLE public."oauthClientAssertion" OWNER TO postgres;

--
-- Name: oauthClientResource; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public."oauthClientResource" (
    id text NOT NULL,
    "clientId" text NOT NULL,
    "resourceId" text NOT NULL,
    metadata jsonb,
    "createdAt" timestamp with time zone
);


ALTER TABLE public."oauthClientResource" OWNER TO postgres;

--
-- Name: oauthConsent; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public."oauthConsent" (
    id text NOT NULL,
    "clientId" text NOT NULL,
    "userId" text,
    "referenceId" text,
    scopes jsonb NOT NULL,
    "createdAt" timestamp with time zone NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL,
    resources jsonb,
    "requestedUserInfoClaims" jsonb
);


ALTER TABLE public."oauthConsent" OWNER TO postgres;

--
-- Name: oauthRefreshToken; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public."oauthRefreshToken" (
    id text NOT NULL,
    token text NOT NULL,
    "clientId" text NOT NULL,
    "sessionId" text,
    "userId" text NOT NULL,
    "referenceId" text,
    "expiresAt" timestamp with time zone NOT NULL,
    "createdAt" timestamp with time zone NOT NULL,
    revoked timestamp with time zone,
    "authTime" timestamp with time zone,
    scopes jsonb NOT NULL,
    "authorizationCodeId" text,
    resources jsonb,
    "requestedUserInfoClaims" jsonb,
    "rotatedAt" timestamp with time zone,
    "rotationReplayResponse" text,
    "rotationReplayExpiresAt" timestamp with time zone,
    confirmation jsonb
);


ALTER TABLE public."oauthRefreshToken" OWNER TO postgres;

--
-- Name: oauthResource; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public."oauthResource" (
    id text NOT NULL,
    identifier text NOT NULL,
    name text NOT NULL,
    "accessTokenTtl" integer,
    "refreshTokenTtl" integer,
    "signingAlgorithm" text,
    "signingKeyId" text,
    "allowedScopes" jsonb,
    "customClaims" jsonb,
    "dpopBoundAccessTokensRequired" boolean DEFAULT false NOT NULL,
    disabled boolean DEFAULT false NOT NULL,
    "createdAt" timestamp with time zone,
    "updatedAt" timestamp with time zone,
    "policyVersion" integer DEFAULT 1 NOT NULL,
    metadata jsonb
);


ALTER TABLE public."oauthResource" OWNER TO postgres;

--
-- Name: page_deletion_intents; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.page_deletion_intents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    page_id uuid NOT NULL,
    expected_version_id uuid NOT NULL,
    owner_user_id text NOT NULL,
    session_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    CONSTRAINT page_deletion_intents_expiry CHECK (((expires_at > created_at) AND (expires_at <= (created_at + '00:05:00'::interval)))),
    CONSTRAINT page_deletion_intents_owner CHECK ((owner_user_id = 'context-use-owner'::text)),
    CONSTRAINT page_deletion_intents_session_id_check CHECK (((length(session_id) >= 1) AND (length(session_id) <= 512)))
);


ALTER TABLE public.page_deletion_intents OWNER TO postgres;

--
-- Name: page_publications; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.page_publications (
    public_id uuid NOT NULL,
    resource_kind public.publication_target DEFAULT 'page'::public.publication_target NOT NULL,
    artifact_id uuid NOT NULL,
    published_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT page_publications_resource_kind_check CHECK ((resource_kind = 'page'::public.publication_target))
);


ALTER TABLE public.page_publications OWNER TO postgres;

--
-- Name: passkey; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.passkey (
    id text NOT NULL,
    name text,
    "publicKey" text NOT NULL,
    "userId" text NOT NULL,
    "credentialID" text NOT NULL,
    counter integer NOT NULL,
    "deviceType" text NOT NULL,
    "backedUp" boolean NOT NULL,
    transports text,
    "createdAt" timestamp with time zone,
    aaguid text,
    CONSTRAINT passkey_name_length_check CHECK (((name IS NULL) OR ((length(TRIM(BOTH FROM name)) >= 1) AND (length(TRIM(BOTH FROM name)) <= 80))))
);


ALTER TABLE public.passkey OWNER TO postgres;

--
-- Name: passkey_management_intents; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.passkey_management_intents (
    id uuid NOT NULL,
    action text NOT NULL,
    owner_user_id text NOT NULL,
    session_id text NOT NULL,
    target_passkey_id text,
    name text,
    authenticator_attachment text,
    challenge text NOT NULL,
    token_hash text,
    authorizing_credential_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    confirmed_at timestamp with time zone,
    consumed_at timestamp with time zone,
    CONSTRAINT passkey_management_intents_action_check CHECK ((action = ANY (ARRAY['enroll'::text, 'delete'::text]))),
    CONSTRAINT passkey_management_intents_authenticator_attachment_check CHECK (((authenticator_attachment IS NULL) OR (authenticator_attachment = 'cross-platform'::text))),
    CONSTRAINT passkey_management_intents_challenge_check CHECK ((challenge ~ '^[A-Za-z0-9_-]{43,128}$'::text)),
    CONSTRAINT passkey_management_intents_confirmation CHECK ((((confirmed_at IS NULL) AND (token_hash IS NULL) AND (authorizing_credential_id IS NULL)) OR ((confirmed_at IS NOT NULL) AND (authorizing_credential_id IS NOT NULL) AND ((action = 'delete'::text) OR (token_hash IS NOT NULL))))),
    CONSTRAINT passkey_management_intents_consumption CHECK (((consumed_at IS NULL) OR (confirmed_at IS NOT NULL))),
    CONSTRAINT passkey_management_intents_expiry CHECK (((expires_at > created_at) AND (expires_at <= (created_at + '00:05:00'::interval)))),
    CONSTRAINT passkey_management_intents_owner_user_id_check CHECK ((owner_user_id = 'context-use-owner'::text)),
    CONSTRAINT passkey_management_intents_shape CHECK ((((action = 'enroll'::text) AND (target_passkey_id IS NULL) AND (name IS NOT NULL) AND ((length(TRIM(BOTH FROM name)) >= 1) AND (length(TRIM(BOTH FROM name)) <= 80))) OR ((action = 'delete'::text) AND (target_passkey_id IS NOT NULL) AND (name IS NULL) AND (authenticator_attachment IS NULL)))),
    CONSTRAINT passkey_management_intents_token_hash_check CHECK (((token_hash IS NULL) OR (token_hash ~ '^[a-f0-9]{64}$'::text)))
);


ALTER TABLE public.passkey_management_intents OWNER TO postgres;

--
-- Name: source_records; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.source_records (
    document_id uuid NOT NULL,
    current_revision_id uuid,
    integration text NOT NULL,
    connection_id text NOT NULL,
    model text NOT NULL,
    source_record_id text NOT NULL,
    source_created_at timestamp with time zone,
    source_updated_at timestamp with time zone NOT NULL,
    search_vector tsvector DEFAULT ''::tsvector NOT NULL,
    deleted_at timestamp with time zone,
    connection_instance_id bigint,
    CONSTRAINT source_records_connection_id_check CHECK (((length(connection_id) >= 1) AND (length(connection_id) <= 512))),
    CONSTRAINT source_records_connection_instance_id_check CHECK (((connection_instance_id IS NULL) OR ((connection_instance_id >= 1) AND (connection_instance_id <= '9007199254740991'::bigint)))),
    CONSTRAINT source_records_integration_check CHECK (((length(integration) >= 1) AND (length(integration) <= 255))),
    CONSTRAINT source_records_model_check CHECK (((length(model) >= 1) AND (length(model) <= 255))),
    CONSTRAINT source_records_source_record_id_check CHECK (((length(source_record_id) >= 1) AND (length(source_record_id) <= 1024)))
);


ALTER TABLE public.source_records OWNER TO postgres;

--
-- Name: private_document_catalog; Type: VIEW; Schema: public; Owner: context_use_projection_owner
--

CREATE VIEW public.private_document_catalog WITH (security_barrier='true', security_invoker='false') AS
 SELECT document.id AS document_id,
    'knowledge'::text AS document_kind,
    document.authority,
    document.representation,
        CASE
            WHEN (page.archived_at IS NULL) THEN 'active'::text
            ELSE 'archived'::text
        END AS lifecycle,
    page.current_version_id AS current_revision_id,
    revision.revision_number AS current_revision_number,
    version.title,
    version.summary,
    NULL::text AS filename,
    NULL::text AS content_type,
    (revision.body_size_bytes)::bigint AS size_bytes,
    revision.body_content_hash AS content_hash,
    NULL::integer AS width,
    NULL::integer AS height,
    NULL::numeric AS duration_seconds,
    NULL::text AS integration,
    NULL::bigint AS connection_instance_id,
    NULL::text AS connection_id,
    NULL::text AS source_model,
    NULL::text AS source_record_id,
    array_remove(ARRAY[
        CASE
            WHEN (settings.global_guide_document_id = page.id) THEN 'global_guide'::text
            ELSE NULL::text
        END,
        CASE
            WHEN (EXISTS ( SELECT 1
               FROM public.automation_registry registry
              WHERE (registry.instructions_document_id = page.id))) THEN 'automation_instructions'::text
            ELSE NULL::text
        END,
        CASE
            WHEN (EXISTS ( SELECT 1
               FROM public.automation_registry registry
              WHERE (registry.state_document_id = page.id))) THEN 'automation_state'::text
            ELSE NULL::text
        END], NULL::text) AS operational_roles,
    resource.public_id,
    (contract.link_contract)::text AS current_link_contract,
    revision.links_indexed_at,
    COALESCE((search.revision_id = page.current_version_id), false) AS search_ready,
    document.created_at,
    document.updated_at
   FROM (((((((public.hypermedia_documents document
     JOIN public.knowledge_pages page ON ((page.id = document.id)))
     JOIN public.knowledge_page_versions version ON (((version.id = page.current_version_id) AND (version.page_id = page.id))))
     JOIN public.hypermedia_document_revisions revision ON (((revision.id = page.current_version_id) AND (revision.document_id = page.id))))
     LEFT JOIN public.knowledge_settings settings ON (settings.singleton))
     LEFT JOIN public.public_resources resource ON ((resource.document_id = page.id)))
     LEFT JOIN public.knowledge_revision_contracts contract ON ((contract.revision_id = page.current_version_id)))
     LEFT JOIN public.knowledge_search search ON ((search.document_id = page.id)))
  WHERE ((document.authority = 'knowledge'::public.hypermedia_document_authority) AND (document.representation = 'markdown'::public.hypermedia_document_representation))
UNION ALL
 SELECT document.id AS document_id,
    'record'::text AS document_kind,
    document.authority,
    document.representation,
        CASE
            WHEN (record.deleted_at IS NULL) THEN 'active'::text
            ELSE 'deleted'::text
        END AS lifecycle,
    record.current_revision_id,
    revision.revision_number AS current_revision_number,
    NULL::text AS title,
    NULL::text AS summary,
    NULL::text AS filename,
    NULL::text AS content_type,
    (revision.body_size_bytes)::bigint AS size_bytes,
    revision.body_content_hash AS content_hash,
    NULL::integer AS width,
    NULL::integer AS height,
    NULL::numeric AS duration_seconds,
    record.integration,
    record.connection_instance_id,
    record.connection_id,
    record.model AS source_model,
    record.source_record_id,
    '{}'::text[] AS operational_roles,
    NULL::uuid AS public_id,
    NULL::text AS current_link_contract,
    revision.links_indexed_at,
        CASE
            WHEN (record.current_revision_id IS NULL) THEN (record.deleted_at IS NOT NULL)
            ELSE ((revision.id IS NOT NULL) AND (revision.links_indexed_at IS NOT NULL))
        END AS search_ready,
    document.created_at,
    document.updated_at
   FROM ((public.hypermedia_documents document
     JOIN public.source_records record ON ((record.document_id = document.id)))
     LEFT JOIN public.hypermedia_document_revisions revision ON (((revision.id = record.current_revision_id) AND (revision.document_id = record.document_id))))
  WHERE ((document.authority = 'source'::public.hypermedia_document_authority) AND (document.representation = 'markdown'::public.hypermedia_document_representation))
UNION ALL
 SELECT document.id AS document_id,
    'asset'::text AS document_kind,
    document.authority,
    document.representation,
        CASE
            WHEN (asset.deleted_at IS NULL) THEN 'active'::text
            ELSE 'deleted'::text
        END AS lifecycle,
    NULL::uuid AS current_revision_id,
    NULL::integer AS current_revision_number,
    NULL::text AS title,
    NULL::text AS summary,
    asset.filename,
    asset.content_type,
    asset.size_bytes,
    asset.content_hash,
    asset.width,
    asset.height,
    asset.duration_seconds,
    NULL::text AS integration,
    NULL::bigint AS connection_instance_id,
    NULL::text AS connection_id,
    NULL::text AS source_model,
    NULL::text AS source_record_id,
    '{}'::text[] AS operational_roles,
    resource.public_id,
    NULL::text AS current_link_contract,
    NULL::timestamp with time zone AS links_indexed_at,
    true AS search_ready,
    document.created_at,
    document.updated_at
   FROM ((public.hypermedia_documents document
     JOIN public.assets asset ON ((asset.id = document.id)))
     LEFT JOIN public.public_resources resource ON ((resource.document_id = asset.id)))
  WHERE ((document.authority = 'knowledge'::public.hypermedia_document_authority) AND (document.representation = 'asset'::public.hypermedia_document_representation));


ALTER VIEW public.private_document_catalog OWNER TO context_use_projection_owner;

--
-- Name: public_asset_artifacts; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.public_asset_artifacts (
    artifact_id uuid NOT NULL,
    public_id uuid NOT NULL,
    resource_kind public.publication_target DEFAULT 'asset'::public.publication_target NOT NULL,
    source_document_id uuid NOT NULL,
    body_object_key text NOT NULL,
    body_size_bytes bigint NOT NULL,
    body_content_hash text NOT NULL,
    public_filename text NOT NULL,
    public_content_type text NOT NULL,
    public_width integer,
    public_height integer,
    public_duration_seconds numeric,
    origin public.public_artifact_origin NOT NULL,
    source_intent_id uuid,
    retained_source_id uuid,
    retained_source_kind public.retained_public_artifact_kind,
    representation_token text NOT NULL,
    reservation_allocation_kind public.public_artifact_allocation_kind NOT NULL,
    reservation_allocation_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT public_asset_artifacts_body_content_hash_check CHECK ((body_content_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT public_asset_artifacts_body_size_bytes_check CHECK ((body_size_bytes >= 0)),
    CONSTRAINT public_asset_artifacts_check CHECK ((body_object_key = ('artifacts/public/'::text || (artifact_id)::text))),
    CONSTRAINT public_asset_artifacts_check1 CHECK (((public_id <> artifact_id) AND (source_document_id <> artifact_id))),
    CONSTRAINT public_asset_artifacts_check2 CHECK ((((origin = 'ordinary'::public.public_artifact_origin) AND (source_intent_id IS NOT NULL) AND (retained_source_id IS NULL) AND (retained_source_kind IS NULL) AND (reservation_allocation_kind = 'publication_intent'::public.public_artifact_allocation_kind) AND (reservation_allocation_id = source_intent_id)) OR ((origin = 'retained'::public.public_artifact_origin) AND (source_intent_id IS NULL) AND (retained_source_id IS NOT NULL) AND (retained_source_kind = 'asset'::public.retained_public_artifact_kind) AND (reservation_allocation_kind = 'retained_publication'::public.public_artifact_allocation_kind) AND (reservation_allocation_id = retained_source_id)))),
    CONSTRAINT public_asset_artifacts_origin_check CHECK ((origin <> 'alias_hub'::public.public_artifact_origin)),
    CONSTRAINT public_asset_artifacts_public_content_type_check CHECK (((length(public_content_type) >= 1) AND (length(public_content_type) <= 255))),
    CONSTRAINT public_asset_artifacts_public_duration_seconds_check CHECK (((public_duration_seconds IS NULL) OR (public_duration_seconds >= (0)::numeric))),
    CONSTRAINT public_asset_artifacts_public_filename_check CHECK (((length(public_filename) >= 1) AND (length(public_filename) <= 1024))),
    CONSTRAINT public_asset_artifacts_public_height_check CHECK (((public_height IS NULL) OR (public_height > 0))),
    CONSTRAINT public_asset_artifacts_public_width_check CHECK (((public_width IS NULL) OR (public_width > 0))),
    CONSTRAINT public_asset_artifacts_representation_token_check CHECK ((representation_token ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT public_asset_artifacts_resource_kind_check CHECK ((resource_kind = 'asset'::public.publication_target))
);


ALTER TABLE public.public_asset_artifacts OWNER TO postgres;

--
-- Name: public_assets; Type: VIEW; Schema: public; Owner: context_use_projection_owner
--

CREATE VIEW public.public_assets WITH (security_barrier='true', security_invoker='false') AS
 SELECT artifact.public_id,
    ('/a/'::text || (artifact.public_id)::text) AS canonical_path,
    artifact.public_filename,
    artifact.public_content_type,
    artifact.public_width,
    artifact.public_height,
    (artifact.public_duration_seconds)::text AS public_duration_seconds,
    artifact.representation_token
   FROM ((public.asset_publications publication
     JOIN public.public_asset_artifacts artifact ON (((artifact.public_id = publication.public_id) AND (artifact.artifact_id = publication.artifact_id))))
     JOIN public.public_resources resource ON (((resource.public_id = publication.public_id) AND (resource.resource_kind = 'asset'::public.publication_target) AND (resource.document_id IS NOT NULL))))
  WHERE (NOT (EXISTS ( SELECT 1
           FROM public.blocking_public_namespace_conflicts conflict
          WHERE ((conflict.namespace_uuid = ANY (ARRAY[artifact.public_id, artifact.artifact_id])) OR (conflict.public_id = artifact.public_id)))));


ALTER VIEW public.public_assets OWNER TO context_use_projection_owner;

--
-- Name: public_page_artifacts; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.public_page_artifacts (
    artifact_id uuid NOT NULL,
    public_id uuid NOT NULL,
    resource_kind public.publication_target DEFAULT 'page'::public.publication_target NOT NULL,
    source_document_id uuid NOT NULL,
    source_revision_id uuid NOT NULL,
    source_body_size_bytes integer NOT NULL,
    source_body_content_hash text NOT NULL,
    body_object_key text NOT NULL,
    body_size_bytes integer NOT NULL,
    body_content_hash text NOT NULL,
    public_title text NOT NULL,
    public_summary text NOT NULL,
    public_last_edited_at timestamp with time zone NOT NULL,
    projected_target_public_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    observed_public_uuid_tokens uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    projection_receipt_hash text NOT NULL,
    origin public.public_artifact_origin NOT NULL,
    source_intent_id uuid,
    retained_source_id uuid,
    retained_source_kind public.retained_public_artifact_kind,
    retained_source_artifact_id uuid,
    retained_projection_generation bigint,
    representation_token text NOT NULL,
    reservation_allocation_kind public.public_artifact_allocation_kind NOT NULL,
    reservation_allocation_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT public_page_artifacts_body_content_hash_check CHECK ((body_content_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT public_page_artifacts_body_size_bytes_check CHECK (((body_size_bytes >= 0) AND (body_size_bytes <= 4000000))),
    CONSTRAINT public_page_artifacts_check CHECK ((body_object_key = (('documents/public/'::text || (artifact_id)::text) || '.md'::text))),
    CONSTRAINT public_page_artifacts_check1 CHECK (((public_id <> artifact_id) AND (source_document_id <> artifact_id) AND (source_revision_id <> artifact_id))),
    CONSTRAINT public_page_artifacts_check2 CHECK ((((origin = 'ordinary'::public.public_artifact_origin) AND (source_intent_id IS NOT NULL) AND (retained_source_id IS NULL) AND (retained_source_kind IS NULL) AND (retained_source_artifact_id IS NULL) AND (retained_projection_generation IS NULL) AND (reservation_allocation_kind = 'publication_intent'::public.public_artifact_allocation_kind) AND (reservation_allocation_id = source_intent_id)) OR ((origin = 'retained'::public.public_artifact_origin) AND (source_intent_id IS NULL) AND (retained_source_id IS NOT NULL) AND (retained_source_kind = 'page'::public.retained_public_artifact_kind) AND (retained_source_artifact_id IS NOT NULL) AND (retained_projection_generation IS NOT NULL) AND (reservation_allocation_kind = 'retained_publication'::public.public_artifact_allocation_kind) AND (reservation_allocation_id = retained_source_id)) OR ((origin = 'alias_hub'::public.public_artifact_origin) AND (source_intent_id IS NULL) AND (retained_source_id IS NOT NULL) AND (retained_source_kind = 'alias_hub'::public.retained_public_artifact_kind) AND (retained_source_artifact_id IS NULL) AND (retained_projection_generation IS NULL) AND (reservation_allocation_kind = 'retained_publication'::public.public_artifact_allocation_kind) AND (reservation_allocation_id = retained_source_id)))),
    CONSTRAINT public_page_artifacts_observed_public_uuid_tokens_check CHECK (((cardinality(observed_public_uuid_tokens) <= 100000) AND (array_position(observed_public_uuid_tokens, NULL::uuid) IS NULL))),
    CONSTRAINT public_page_artifacts_projected_target_public_ids_check CHECK (((cardinality(projected_target_public_ids) <= 100000) AND (array_position(projected_target_public_ids, NULL::uuid) IS NULL))),
    CONSTRAINT public_page_artifacts_projection_receipt_hash_check CHECK ((projection_receipt_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT public_page_artifacts_public_summary_check CHECK (((length(TRIM(BOTH FROM public_summary)) >= 1) AND (length(TRIM(BOTH FROM public_summary)) <= 320))),
    CONSTRAINT public_page_artifacts_public_title_check CHECK (((length(TRIM(BOTH FROM public_title)) >= 1) AND (length(TRIM(BOTH FROM public_title)) <= 240))),
    CONSTRAINT public_page_artifacts_representation_token_check CHECK ((representation_token ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT public_page_artifacts_resource_kind_check CHECK ((resource_kind = 'page'::public.publication_target)),
    CONSTRAINT public_page_artifacts_retained_projection_generation_check CHECK (((retained_projection_generation IS NULL) OR (retained_projection_generation > 0))),
    CONSTRAINT public_page_artifacts_source_body_content_hash_check CHECK ((source_body_content_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT public_page_artifacts_source_body_size_bytes_check CHECK (((source_body_size_bytes >= 0) AND (source_body_size_bytes <= 4000000)))
);


ALTER TABLE public.public_page_artifacts OWNER TO postgres;

--
-- Name: public_pages; Type: VIEW; Schema: public; Owner: context_use_projection_owner
--

CREATE VIEW public.public_pages WITH (security_barrier='true', security_invoker='false') AS
 SELECT artifact.public_id,
    ('/p/'::text || (artifact.public_id)::text) AS canonical_path,
    (('/p/'::text || (artifact.public_id)::text) || '.md'::text) AS markdown_path,
    artifact.public_title,
    artifact.public_summary,
    to_char((artifact.public_last_edited_at AT TIME ZONE 'UTC'::text), 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'::text) AS public_last_edited_at,
    artifact.representation_token
   FROM ((public.page_publications publication
     JOIN public.public_page_artifacts artifact ON (((artifact.public_id = publication.public_id) AND (artifact.artifact_id = publication.artifact_id))))
     JOIN public.public_resources resource ON (((resource.public_id = publication.public_id) AND (resource.resource_kind = 'page'::public.publication_target) AND (resource.document_id IS NOT NULL))))
  WHERE (NOT (EXISTS ( SELECT 1
           FROM public.blocking_public_namespace_conflicts conflict
          WHERE ((conflict.namespace_uuid = ANY (ARRAY[artifact.public_id, artifact.artifact_id])) OR (conflict.public_id = artifact.public_id)))));


ALTER VIEW public.public_pages OWNER TO context_use_projection_owner;

--
-- Name: public_representation_token_reservations; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.public_representation_token_reservations (
    representation_token text NOT NULL,
    artifact_id uuid NOT NULL,
    resource_kind public.publication_target NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT public_representation_token_reservat_representation_token_check CHECK ((representation_token ~ '^[a-f0-9]{64}$'::text))
);


ALTER TABLE public.public_representation_token_reservations OWNER TO postgres;

--
-- Name: public_visibility_generations; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.public_visibility_generations (
    public_id uuid NOT NULL,
    generation bigint NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT public_visibility_generations_generation_check CHECK ((generation > 0))
);


ALTER TABLE public.public_visibility_generations OWNER TO postgres;

--
-- Name: publication_artifact_staging; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.publication_artifact_staging (
    intent_id uuid NOT NULL,
    target_kind public.publication_target NOT NULL,
    candidate_public_id uuid NOT NULL,
    artifact_id uuid NOT NULL,
    body_object_key text NOT NULL,
    body_size_bytes bigint NOT NULL,
    body_content_hash text NOT NULL,
    public_title text,
    public_summary text,
    public_last_edited_at timestamp with time zone,
    public_filename text,
    public_content_type text,
    public_width integer,
    public_height integer,
    public_duration_seconds numeric,
    projected_target_public_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    observed_public_uuid_tokens uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    projection_receipt_hash text,
    allocation_kind public.public_artifact_allocation_kind DEFAULT 'publication_intent'::public.public_artifact_allocation_kind NOT NULL,
    allocation_id uuid NOT NULL,
    staged_at timestamp with time zone DEFAULT now() NOT NULL,
    representation_token text NOT NULL,
    CONSTRAINT publication_artifact_observed_public_uuid_tokens_check CHECK (((cardinality(observed_public_uuid_tokens) <= 100000) AND (array_position(observed_public_uuid_tokens, NULL::uuid) IS NULL))),
    CONSTRAINT publication_artifact_projected_target_public_ids_check CHECK (((cardinality(projected_target_public_ids) <= 100000) AND (array_position(projected_target_public_ids, NULL::uuid) IS NULL))),
    CONSTRAINT publication_artifact_staging_allocation_kind_check CHECK ((allocation_kind = 'publication_intent'::public.public_artifact_allocation_kind)),
    CONSTRAINT publication_artifact_staging_body_content_hash_check CHECK ((body_content_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT publication_artifact_staging_body_size_bytes_check CHECK ((body_size_bytes >= 0)),
    CONSTRAINT publication_artifact_staging_check CHECK ((allocation_id = intent_id)),
    CONSTRAINT publication_artifact_staging_check1 CHECK ((((target_kind = 'page'::public.publication_target) AND (body_size_bytes <= 4000000) AND (public_title IS NOT NULL) AND ((length(TRIM(BOTH FROM public_title)) >= 1) AND (length(TRIM(BOTH FROM public_title)) <= 240)) AND (public_summary IS NOT NULL) AND ((length(TRIM(BOTH FROM public_summary)) >= 1) AND (length(TRIM(BOTH FROM public_summary)) <= 320)) AND (public_last_edited_at IS NOT NULL) AND (public_filename IS NULL) AND (public_content_type IS NULL) AND (public_width IS NULL) AND (public_height IS NULL) AND (public_duration_seconds IS NULL) AND (projection_receipt_hash IS NOT NULL) AND (projection_receipt_hash ~ '^[a-f0-9]{64}$'::text)) OR ((target_kind = 'asset'::public.publication_target) AND (public_title IS NULL) AND (public_summary IS NULL) AND (public_last_edited_at IS NULL) AND (public_filename IS NOT NULL) AND ((length(public_filename) >= 1) AND (length(public_filename) <= 1024)) AND (public_content_type IS NOT NULL) AND ((length(public_content_type) >= 1) AND (length(public_content_type) <= 255)) AND ((public_width IS NULL) OR (public_width > 0)) AND ((public_height IS NULL) OR (public_height > 0)) AND ((public_duration_seconds IS NULL) OR (public_duration_seconds >= (0)::numeric)) AND (cardinality(projected_target_public_ids) = 0) AND (cardinality(observed_public_uuid_tokens) = 0) AND (projection_receipt_hash IS NULL)))),
    CONSTRAINT publication_staging_representation_token_check CHECK ((representation_token ~ '^[a-f0-9]{64}$'::text))
);


ALTER TABLE public.publication_artifact_staging OWNER TO postgres;

--
-- Name: publication_intent_id_reservations; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.publication_intent_id_reservations (
    intent_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.publication_intent_id_reservations OWNER TO postgres;

--
-- Name: publication_intents; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.publication_intents (
    id uuid NOT NULL,
    action public.publication_action NOT NULL,
    target_kind public.publication_target NOT NULL,
    target_document_id uuid NOT NULL,
    expected_revision_id uuid,
    candidate_public_id uuid,
    candidate_artifact_id uuid,
    candidate_object_key text,
    artifact_allocation_kind public.public_artifact_allocation_kind,
    artifact_allocation_id uuid,
    projected_target_public_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    projection_receipt_hash text,
    owner_user_id text NOT NULL,
    session_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    confirmed_at timestamp with time zone,
    cancelled_at timestamp with time zone,
    expected_visibility_generation bigint NOT NULL,
    expected_visibility_state_hash text NOT NULL,
    expected_target_generation bigint NOT NULL,
    expected_source_fingerprint text,
    CONSTRAINT publication_intents_check CHECK (((expires_at > created_at) AND (expires_at <= (created_at + '00:05:00'::interval)))),
    CONSTRAINT publication_intents_check1 CHECK (((confirmed_at IS NULL) OR (cancelled_at IS NULL))),
    CONSTRAINT publication_intents_check2 CHECK (((candidate_public_id IS NULL) OR (candidate_artifact_id IS NULL) OR (candidate_public_id <> candidate_artifact_id))),
    CONSTRAINT publication_intents_check3 CHECK ((((action = 'unpublish'::public.publication_action) AND (expected_revision_id IS NULL) AND (candidate_public_id IS NULL) AND (candidate_artifact_id IS NULL) AND (candidate_object_key IS NULL) AND (artifact_allocation_kind IS NULL) AND (artifact_allocation_id IS NULL) AND (cardinality(projected_target_public_ids) = 0) AND (projection_receipt_hash IS NULL)) OR ((action = 'publish'::public.publication_action) AND (candidate_public_id IS NOT NULL) AND (candidate_artifact_id IS NOT NULL) AND (candidate_object_key IS NOT NULL) AND (artifact_allocation_kind = 'publication_intent'::public.public_artifact_allocation_kind) AND (artifact_allocation_id = id) AND (((target_kind = 'page'::public.publication_target) AND (expected_revision_id IS NOT NULL) AND (candidate_object_key = (('documents/public/'::text || (candidate_artifact_id)::text) || '.md'::text)) AND (projection_receipt_hash IS NOT NULL)) OR ((target_kind = 'asset'::public.publication_target) AND (expected_revision_id IS NULL) AND (candidate_object_key = ('artifacts/public/'::text || (candidate_artifact_id)::text)) AND (cardinality(projected_target_public_ids) = 0) AND (projection_receipt_hash IS NULL)))))),
    CONSTRAINT publication_intents_owner_user_id_check CHECK ((owner_user_id = 'context-use-owner'::text)),
    CONSTRAINT publication_intents_projected_target_public_ids_check CHECK (((cardinality(projected_target_public_ids) <= 100000) AND (array_position(projected_target_public_ids, NULL::uuid) IS NULL))),
    CONSTRAINT publication_intents_projection_receipt_hash_check CHECK (((projection_receipt_hash IS NULL) OR (projection_receipt_hash ~ '^[a-f0-9]{64}$'::text))),
    CONSTRAINT publication_intents_session_id_check CHECK (((length(session_id) >= 1) AND (length(session_id) <= 512))),
    CONSTRAINT publication_intents_source_fingerprint_check CHECK ((((action = 'publish'::public.publication_action) AND (expected_source_fingerprint IS NOT NULL) AND (expected_source_fingerprint ~ '^[a-f0-9]{64}$'::text)) OR ((action = 'unpublish'::public.publication_action) AND (expected_source_fingerprint IS NULL)))),
    CONSTRAINT publication_intents_target_generation_check CHECK ((expected_target_generation >= 0)),
    CONSTRAINT publication_intents_visibility_generation_check CHECK ((expected_visibility_generation >= 0)),
    CONSTRAINT publication_intents_visibility_hash_check CHECK ((expected_visibility_state_hash ~ '^[a-f0-9]{64}$'::text))
);


ALTER TABLE public.publication_intents OWNER TO postgres;

--
-- Name: publication_object_claims; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.publication_object_claims (
    allocation_kind public.public_artifact_allocation_kind NOT NULL,
    allocation_id uuid NOT NULL,
    artifact_id uuid NOT NULL,
    body_object_key text NOT NULL,
    claim_token uuid NOT NULL,
    claimed_at timestamp with time zone DEFAULT now() NOT NULL,
    finalized_at timestamp with time zone,
    body_size_bytes bigint,
    body_content_hash text,
    CONSTRAINT publication_object_claims_allocation_kind_check CHECK ((allocation_kind = 'publication_intent'::public.public_artifact_allocation_kind)),
    CONSTRAINT publication_object_claims_check CHECK ((((finalized_at IS NULL) AND (body_size_bytes IS NULL) AND (body_content_hash IS NULL)) OR ((finalized_at IS NOT NULL) AND (body_size_bytes IS NOT NULL) AND (body_size_bytes >= 0) AND (body_content_hash ~ '^[a-f0-9]{64}$'::text))))
);


ALTER TABLE public.publication_object_claims OWNER TO postgres;

--
-- Name: publication_settings; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.publication_settings (
    singleton boolean DEFAULT true NOT NULL,
    entrypoint_public_id uuid,
    entrypoint_resource_kind public.publication_target DEFAULT 'page'::public.publication_target NOT NULL,
    updated_at timestamp with time zone,
    CONSTRAINT publication_settings_entrypoint_resource_kind_check CHECK ((entrypoint_resource_kind = 'page'::public.publication_target)),
    CONSTRAINT publication_settings_singleton_check CHECK (singleton)
);


ALTER TABLE public.publication_settings OWNER TO postgres;

--
-- Name: publication_target_generations; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.publication_target_generations (
    target_kind public.publication_target NOT NULL,
    target_document_id uuid NOT NULL,
    generation bigint NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT publication_target_generations_generation_check CHECK ((generation > 0))
);


ALTER TABLE public.publication_target_generations OWNER TO postgres;

--
-- Name: retained_page_artifacts; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.retained_page_artifacts (
    page_id uuid NOT NULL,
    version_id uuid NOT NULL,
    projection_generation bigint NOT NULL,
    artifact_id uuid NOT NULL,
    body_object_key text NOT NULL,
    body_size_bytes integer NOT NULL,
    body_content_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT retained_page_artifacts_body_content_hash_check CHECK ((body_content_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT retained_page_artifacts_body_object_key_check CHECK ((body_object_key ~ '^documents/public/[0-9a-f-]{36}\.md$'::text)),
    CONSTRAINT retained_page_artifacts_body_size_bytes_check CHECK (((body_size_bytes >= 0) AND (body_size_bytes <= 4000000))),
    CONSTRAINT retained_page_artifacts_projection_generation_check CHECK ((projection_generation > 0))
);


ALTER TABLE public.retained_page_artifacts OWNER TO postgres;

--
-- Name: session; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.session (
    id text NOT NULL,
    "expiresAt" timestamp with time zone NOT NULL,
    token text NOT NULL,
    "createdAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL,
    "ipAddress" text,
    "userAgent" text,
    "userId" text NOT NULL
);


ALTER TABLE public.session OWNER TO postgres;

--
-- Name: source_record_search_chunks; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.source_record_search_chunks (
    document_id uuid NOT NULL,
    chunk_number integer NOT NULL,
    search_vector tsvector NOT NULL,
    CONSTRAINT source_record_search_chunks_chunk_number_check CHECK ((chunk_number >= 0))
);


ALTER TABLE public.source_record_search_chunks OWNER TO postgres;

--
-- Name: user; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public."user" (
    id text NOT NULL,
    name text NOT NULL,
    email text NOT NULL,
    "emailVerified" boolean NOT NULL,
    image text,
    "createdAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT user_single_owner_check CHECK (((id = 'context-use-owner'::text) AND ("emailVerified" = true)))
);


ALTER TABLE public."user" OWNER TO postgres;

--
-- Name: verification; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.verification (
    id text NOT NULL,
    identifier text NOT NULL,
    value text NOT NULL,
    "expiresAt" timestamp with time zone NOT NULL,
    "createdAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


ALTER TABLE public.verification OWNER TO postgres;

--
-- Name: account account_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.account
    ADD CONSTRAINT account_pkey PRIMARY KEY (id);


--
-- Name: asset_publications asset_publications_artifact_id_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.asset_publications
    ADD CONSTRAINT asset_publications_artifact_id_key UNIQUE (artifact_id);


--
-- Name: asset_publications asset_publications_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.asset_publications
    ADD CONSTRAINT asset_publications_pkey PRIMARY KEY (public_id);


--
-- Name: assets assets_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.assets
    ADD CONSTRAINT assets_pkey PRIMARY KEY (id);


--
-- Name: assets assets_s3_object_key_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.assets
    ADD CONSTRAINT assets_s3_object_key_key UNIQUE (s3_object_key);


--
-- Name: automation_registry automation_registry_instructions_document_id_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.automation_registry
    ADD CONSTRAINT automation_registry_instructions_document_id_key UNIQUE (instructions_document_id);


--
-- Name: automation_registry automation_registry_key_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.automation_registry
    ADD CONSTRAINT automation_registry_key_key UNIQUE (key);


--
-- Name: automation_registry automation_registry_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.automation_registry
    ADD CONSTRAINT automation_registry_pkey PRIMARY KEY (id);


--
-- Name: automation_registry automation_registry_state_document_id_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.automation_registry
    ADD CONSTRAINT automation_registry_state_document_id_key UNIQUE (state_document_id);


--
-- Name: confirmation_challenges confirmation_challenges_challenge_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.confirmation_challenges
    ADD CONSTRAINT confirmation_challenges_challenge_key UNIQUE (challenge);


--
-- Name: confirmation_challenges confirmation_challenges_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.confirmation_challenges
    ADD CONSTRAINT confirmation_challenges_pkey PRIMARY KEY (intent_kind, intent_id);


--
-- Name: document_links document_links_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.document_links
    ADD CONSTRAINT document_links_pkey PRIMARY KEY (source_revision_id, target_document_id);


--
-- Name: hypermedia_bootstrap_allocations hypermedia_bootstrap_allocations_document_id_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.hypermedia_bootstrap_allocations
    ADD CONSTRAINT hypermedia_bootstrap_allocations_document_id_key UNIQUE (document_id);


--
-- Name: hypermedia_bootstrap_allocations hypermedia_bootstrap_allocations_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.hypermedia_bootstrap_allocations
    ADD CONSTRAINT hypermedia_bootstrap_allocations_pkey PRIMARY KEY (document_kind);


--
-- Name: hypermedia_bootstrap_allocations hypermedia_bootstrap_allocations_revision_id_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.hypermedia_bootstrap_allocations
    ADD CONSTRAINT hypermedia_bootstrap_allocations_revision_id_key UNIQUE (revision_id);


--
-- Name: hypermedia_document_revisions hypermedia_document_revisions_body_object_key_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.hypermedia_document_revisions
    ADD CONSTRAINT hypermedia_document_revisions_body_object_key_key UNIQUE (body_object_key);


--
-- Name: hypermedia_document_revisions hypermedia_document_revisions_document_id_revision_number_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.hypermedia_document_revisions
    ADD CONSTRAINT hypermedia_document_revisions_document_id_revision_number_key UNIQUE (document_id, revision_number);


--
-- Name: hypermedia_document_revisions hypermedia_document_revisions_id_document_id_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.hypermedia_document_revisions
    ADD CONSTRAINT hypermedia_document_revisions_id_document_id_key UNIQUE (id, document_id);


--
-- Name: hypermedia_document_revisions hypermedia_document_revisions_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.hypermedia_document_revisions
    ADD CONSTRAINT hypermedia_document_revisions_pkey PRIMARY KEY (id);


--
-- Name: hypermedia_documents hypermedia_documents_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.hypermedia_documents
    ADD CONSTRAINT hypermedia_documents_pkey PRIMARY KEY (id);


--
-- Name: jwks jwks_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.jwks
    ADD CONSTRAINT jwks_pkey PRIMARY KEY (id);


--
-- Name: knowledge_asset_links knowledge_asset_links_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.knowledge_asset_links
    ADD CONSTRAINT knowledge_asset_links_pkey PRIMARY KEY (source_version_id, target_asset_id);


--
-- Name: knowledge_export_intents knowledge_export_intents_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.knowledge_export_intents
    ADD CONSTRAINT knowledge_export_intents_pkey PRIMARY KEY (id);


--
-- Name: knowledge_page_changes knowledge_page_changes_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.knowledge_page_changes
    ADD CONSTRAINT knowledge_page_changes_pkey PRIMARY KEY (change_sequence);


--
-- Name: knowledge_page_changes knowledge_page_changes_version_id_change_kind_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.knowledge_page_changes
    ADD CONSTRAINT knowledge_page_changes_version_id_change_kind_key UNIQUE (version_id, change_kind);


--
-- Name: knowledge_page_versions knowledge_page_versions_id_page_id_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.knowledge_page_versions
    ADD CONSTRAINT knowledge_page_versions_id_page_id_key UNIQUE (id, page_id);


--
-- Name: knowledge_page_versions knowledge_page_versions_page_id_version_number_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.knowledge_page_versions
    ADD CONSTRAINT knowledge_page_versions_page_id_version_number_key UNIQUE (page_id, version_number);


--
-- Name: knowledge_page_versions knowledge_page_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.knowledge_page_versions
    ADD CONSTRAINT knowledge_page_versions_pkey PRIMARY KEY (id);


--
-- Name: knowledge_pages knowledge_pages_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.knowledge_pages
    ADD CONSTRAINT knowledge_pages_pkey PRIMARY KEY (id);


--
-- Name: knowledge_revision_contracts knowledge_revision_contracts_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.knowledge_revision_contracts
    ADD CONSTRAINT knowledge_revision_contracts_pkey PRIMARY KEY (revision_id);


--
-- Name: knowledge_search_chunks knowledge_search_chunks_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.knowledge_search_chunks
    ADD CONSTRAINT knowledge_search_chunks_pkey PRIMARY KEY (document_id, revision_id, chunk_number);


--
-- Name: knowledge_search knowledge_search_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.knowledge_search
    ADD CONSTRAINT knowledge_search_pkey PRIMARY KEY (document_id);


--
-- Name: knowledge_search knowledge_search_revision_id_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.knowledge_search
    ADD CONSTRAINT knowledge_search_revision_id_key UNIQUE (revision_id);


--
-- Name: knowledge_settings knowledge_settings_global_guide_document_id_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.knowledge_settings
    ADD CONSTRAINT knowledge_settings_global_guide_document_id_key UNIQUE (global_guide_document_id);


--
-- Name: knowledge_settings knowledge_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.knowledge_settings
    ADD CONSTRAINT knowledge_settings_pkey PRIMARY KEY (singleton);


--
-- Name: oauthAccessToken oauthAccessToken_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public."oauthAccessToken"
    ADD CONSTRAINT "oauthAccessToken_pkey" PRIMARY KEY (id);


--
-- Name: oauthAccessToken oauthAccessToken_token_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public."oauthAccessToken"
    ADD CONSTRAINT "oauthAccessToken_token_key" UNIQUE (token);


--
-- Name: oauthClientAssertion oauthClientAssertion_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public."oauthClientAssertion"
    ADD CONSTRAINT "oauthClientAssertion_pkey" PRIMARY KEY (id);


--
-- Name: oauthClientResource oauthClientResource_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public."oauthClientResource"
    ADD CONSTRAINT "oauthClientResource_pkey" PRIMARY KEY (id);


--
-- Name: oauthClient oauthClient_clientId_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public."oauthClient"
    ADD CONSTRAINT "oauthClient_clientId_key" UNIQUE ("clientId");


--
-- Name: oauthClient oauthClient_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public."oauthClient"
    ADD CONSTRAINT "oauthClient_pkey" PRIMARY KEY (id);


--
-- Name: oauthConsent oauthConsent_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public."oauthConsent"
    ADD CONSTRAINT "oauthConsent_pkey" PRIMARY KEY (id);


--
-- Name: oauthRefreshToken oauthRefreshToken_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public."oauthRefreshToken"
    ADD CONSTRAINT "oauthRefreshToken_pkey" PRIMARY KEY (id);


--
-- Name: oauthRefreshToken oauthRefreshToken_token_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public."oauthRefreshToken"
    ADD CONSTRAINT "oauthRefreshToken_token_key" UNIQUE (token);


--
-- Name: oauthResource oauthResource_identifier_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public."oauthResource"
    ADD CONSTRAINT "oauthResource_identifier_key" UNIQUE (identifier);


--
-- Name: oauthResource oauthResource_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public."oauthResource"
    ADD CONSTRAINT "oauthResource_pkey" PRIMARY KEY (id);


--
-- Name: page_deletion_intents page_deletion_intents_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.page_deletion_intents
    ADD CONSTRAINT page_deletion_intents_pkey PRIMARY KEY (id);


--
-- Name: page_publications page_publications_artifact_id_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.page_publications
    ADD CONSTRAINT page_publications_artifact_id_key UNIQUE (artifact_id);


--
-- Name: page_publications page_publications_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.page_publications
    ADD CONSTRAINT page_publications_pkey PRIMARY KEY (public_id);


--
-- Name: passkey_management_intents passkey_management_intents_challenge_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.passkey_management_intents
    ADD CONSTRAINT passkey_management_intents_challenge_key UNIQUE (challenge);


--
-- Name: passkey_management_intents passkey_management_intents_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.passkey_management_intents
    ADD CONSTRAINT passkey_management_intents_pkey PRIMARY KEY (id);


--
-- Name: passkey passkey_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.passkey
    ADD CONSTRAINT passkey_pkey PRIMARY KEY (id);


--
-- Name: public_artifact_id_reservations public_artifact_id_reservatio_allocation_kind_allocation_id_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.public_artifact_id_reservations
    ADD CONSTRAINT public_artifact_id_reservatio_allocation_kind_allocation_id_key UNIQUE (allocation_kind, allocation_id);


--
-- Name: public_artifact_id_reservations public_artifact_id_reservatio_artifact_id_body_object_key_a_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.public_artifact_id_reservations
    ADD CONSTRAINT public_artifact_id_reservatio_artifact_id_body_object_key_a_key UNIQUE (artifact_id, body_object_key, allocation_kind, allocation_id);


--
-- Name: public_artifact_id_reservations public_artifact_id_reservations_body_object_key_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.public_artifact_id_reservations
    ADD CONSTRAINT public_artifact_id_reservations_body_object_key_key UNIQUE (body_object_key);


--
-- Name: public_artifact_id_reservations public_artifact_id_reservations_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.public_artifact_id_reservations
    ADD CONSTRAINT public_artifact_id_reservations_pkey PRIMARY KEY (artifact_id);


--
-- Name: public_asset_artifacts public_asset_artifacts_body_object_key_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.public_asset_artifacts
    ADD CONSTRAINT public_asset_artifacts_body_object_key_key UNIQUE (body_object_key);


--
-- Name: public_asset_artifacts public_asset_artifacts_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.public_asset_artifacts
    ADD CONSTRAINT public_asset_artifacts_pkey PRIMARY KEY (artifact_id);


--
-- Name: public_asset_artifacts public_asset_artifacts_public_id_artifact_id_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.public_asset_artifacts
    ADD CONSTRAINT public_asset_artifacts_public_id_artifact_id_key UNIQUE (public_id, artifact_id);


--
-- Name: public_asset_artifacts public_asset_artifacts_representation_token_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.public_asset_artifacts
    ADD CONSTRAINT public_asset_artifacts_representation_token_key UNIQUE (representation_token);


--
-- Name: public_asset_artifacts public_asset_artifacts_retained_source_id_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.public_asset_artifacts
    ADD CONSTRAINT public_asset_artifacts_retained_source_id_key UNIQUE (retained_source_id);


--
-- Name: public_asset_artifacts public_asset_artifacts_source_intent_id_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.public_asset_artifacts
    ADD CONSTRAINT public_asset_artifacts_source_intent_id_key UNIQUE (source_intent_id);


--
-- Name: public_namespace_conflicts public_namespace_conflicts_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.public_namespace_conflicts
    ADD CONSTRAINT public_namespace_conflicts_pkey PRIMARY KEY (conflict_key);


--
-- Name: public_page_artifacts public_page_artifacts_body_object_key_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.public_page_artifacts
    ADD CONSTRAINT public_page_artifacts_body_object_key_key UNIQUE (body_object_key);


--
-- Name: public_page_artifacts public_page_artifacts_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.public_page_artifacts
    ADD CONSTRAINT public_page_artifacts_pkey PRIMARY KEY (artifact_id);


--
-- Name: public_page_artifacts public_page_artifacts_public_id_artifact_id_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.public_page_artifacts
    ADD CONSTRAINT public_page_artifacts_public_id_artifact_id_key UNIQUE (public_id, artifact_id);


--
-- Name: public_page_artifacts public_page_artifacts_representation_token_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.public_page_artifacts
    ADD CONSTRAINT public_page_artifacts_representation_token_key UNIQUE (representation_token);


--
-- Name: public_page_artifacts public_page_artifacts_retained_source_id_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.public_page_artifacts
    ADD CONSTRAINT public_page_artifacts_retained_source_id_key UNIQUE (retained_source_id);


--
-- Name: public_page_artifacts public_page_artifacts_source_intent_id_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.public_page_artifacts
    ADD CONSTRAINT public_page_artifacts_source_intent_id_key UNIQUE (source_intent_id);


--
-- Name: public_representation_token_reservations public_representation_token_r_representation_token_artifact_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.public_representation_token_reservations
    ADD CONSTRAINT public_representation_token_r_representation_token_artifact_key UNIQUE (representation_token, artifact_id, resource_kind);


--
-- Name: public_representation_token_reservations public_representation_token_reservations_artifact_id_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.public_representation_token_reservations
    ADD CONSTRAINT public_representation_token_reservations_artifact_id_key UNIQUE (artifact_id);


--
-- Name: public_representation_token_reservations public_representation_token_reservations_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.public_representation_token_reservations
    ADD CONSTRAINT public_representation_token_reservations_pkey PRIMARY KEY (representation_token);


--
-- Name: public_resources public_resources_document_id_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.public_resources
    ADD CONSTRAINT public_resources_document_id_key UNIQUE (document_id);


--
-- Name: public_resources public_resources_kind_identity_unique; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.public_resources
    ADD CONSTRAINT public_resources_kind_identity_unique UNIQUE (public_id, resource_kind);


--
-- Name: public_resources public_resources_original_kind_unique; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.public_resources
    ADD CONSTRAINT public_resources_original_kind_unique UNIQUE (public_id, original_document_id, resource_kind);


--
-- Name: public_resources public_resources_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.public_resources
    ADD CONSTRAINT public_resources_pkey PRIMARY KEY (public_id);


--
-- Name: public_route_aliases public_route_aliases_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.public_route_aliases
    ADD CONSTRAINT public_route_aliases_pkey PRIMARY KEY (alias_path);


--
-- Name: public_visibility_generations public_visibility_generations_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.public_visibility_generations
    ADD CONSTRAINT public_visibility_generations_pkey PRIMARY KEY (public_id);


--
-- Name: publication_artifact_staging publication_artifact_intent_id_target_kind_candida_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.publication_artifact_staging
    ADD CONSTRAINT publication_artifact_intent_id_target_kind_candida_key UNIQUE (intent_id, target_kind, candidate_public_id, artifact_id, body_object_key);


--
-- Name: publication_artifact_staging publication_artifact_staging_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.publication_artifact_staging
    ADD CONSTRAINT publication_artifact_staging_pkey PRIMARY KEY (intent_id);


--
-- Name: publication_intent_id_reservations publication_intent_id_reservations_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.publication_intent_id_reservations
    ADD CONSTRAINT publication_intent_id_reservations_pkey PRIMARY KEY (intent_id);


--
-- Name: publication_intents publication_intents_id_target_kind_candidate_publi_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.publication_intents
    ADD CONSTRAINT publication_intents_id_target_kind_candidate_publi_key UNIQUE (id, target_kind, candidate_public_id, candidate_artifact_id, candidate_object_key);


--
-- Name: publication_intents publication_intents_id_target_kind_target_documen_key1; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.publication_intents
    ADD CONSTRAINT publication_intents_id_target_kind_target_documen_key1 UNIQUE (id, target_kind, target_document_id, candidate_public_id, candidate_artifact_id, candidate_object_key);


--
-- Name: publication_intents publication_intents_id_target_kind_target_document_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.publication_intents
    ADD CONSTRAINT publication_intents_id_target_kind_target_document_key UNIQUE (id, target_kind, target_document_id, expected_revision_id, candidate_public_id, candidate_artifact_id, candidate_object_key);


--
-- Name: publication_intents publication_intents_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.publication_intents
    ADD CONSTRAINT publication_intents_pkey PRIMARY KEY (id);


--
-- Name: publication_object_claims publication_object_claims_artifact_id_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.publication_object_claims
    ADD CONSTRAINT publication_object_claims_artifact_id_key UNIQUE (artifact_id);


--
-- Name: publication_object_claims publication_object_claims_body_object_key_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.publication_object_claims
    ADD CONSTRAINT publication_object_claims_body_object_key_key UNIQUE (body_object_key);


--
-- Name: publication_object_claims publication_object_claims_claim_token_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.publication_object_claims
    ADD CONSTRAINT publication_object_claims_claim_token_key UNIQUE (claim_token);


--
-- Name: publication_object_claims publication_object_claims_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.publication_object_claims
    ADD CONSTRAINT publication_object_claims_pkey PRIMARY KEY (allocation_kind, allocation_id);


--
-- Name: publication_settings publication_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.publication_settings
    ADD CONSTRAINT publication_settings_pkey PRIMARY KEY (singleton);


--
-- Name: publication_artifact_staging publication_staging_representation_token_unique; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.publication_artifact_staging
    ADD CONSTRAINT publication_staging_representation_token_unique UNIQUE (representation_token);


--
-- Name: publication_target_generations publication_target_generations_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.publication_target_generations
    ADD CONSTRAINT publication_target_generations_pkey PRIMARY KEY (target_kind, target_document_id);


--
-- Name: retained_page_artifacts retained_page_artifacts_artifact_id_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.retained_page_artifacts
    ADD CONSTRAINT retained_page_artifacts_artifact_id_key UNIQUE (artifact_id);


--
-- Name: retained_page_artifacts retained_page_artifacts_body_object_key_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.retained_page_artifacts
    ADD CONSTRAINT retained_page_artifacts_body_object_key_key UNIQUE (body_object_key);


--
-- Name: retained_page_artifacts retained_page_artifacts_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.retained_page_artifacts
    ADD CONSTRAINT retained_page_artifacts_pkey PRIMARY KEY (page_id, version_id, projection_generation);


--
-- Name: session session_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.session
    ADD CONSTRAINT session_pkey PRIMARY KEY (id);


--
-- Name: session session_token_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.session
    ADD CONSTRAINT session_token_key UNIQUE (token);


--
-- Name: source_record_search_chunks source_record_search_chunks_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.source_record_search_chunks
    ADD CONSTRAINT source_record_search_chunks_pkey PRIMARY KEY (document_id, chunk_number);


--
-- Name: source_records source_records_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.source_records
    ADD CONSTRAINT source_records_pkey PRIMARY KEY (document_id);


--
-- Name: user user_email_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public."user"
    ADD CONSTRAINT user_email_key UNIQUE (email);


--
-- Name: user user_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public."user"
    ADD CONSTRAINT user_pkey PRIMARY KEY (id);


--
-- Name: verification verification_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.verification
    ADD CONSTRAINT verification_pkey PRIMARY KEY (id);


--
-- Name: account_userId_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "account_userId_idx" ON public.account USING btree ("userId");


--
-- Name: assets_active_created_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX assets_active_created_idx ON public.assets USING btree (created_at DESC) WHERE (deleted_at IS NULL);


--
-- Name: automation_registry_active_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX automation_registry_active_idx ON public.automation_registry USING btree (key) WHERE (disabled_at IS NULL);


--
-- Name: document_links_target_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX document_links_target_idx ON public.document_links USING btree (target_document_id, source_revision_id);


--
-- Name: hypermedia_document_revisions_document_created_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX hypermedia_document_revisions_document_created_idx ON public.hypermedia_document_revisions USING btree (document_id, created_at DESC);


--
-- Name: hypermedia_document_revisions_unindexed_links_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX hypermedia_document_revisions_unindexed_links_idx ON public.hypermedia_document_revisions USING btree (links_index_attempted_at NULLS FIRST, created_at, id) WHERE (links_indexed_at IS NULL);


--
-- Name: knowledge_asset_links_target_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX knowledge_asset_links_target_idx ON public.knowledge_asset_links USING btree (target_asset_id);


--
-- Name: knowledge_export_intents_expiry_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX knowledge_export_intents_expiry_idx ON public.knowledge_export_intents USING btree (expires_at);


--
-- Name: knowledge_page_changes_chronological_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX knowledge_page_changes_chronological_idx ON public.knowledge_page_changes USING btree (changed_at DESC, change_sequence DESC);


--
-- Name: knowledge_page_changes_page_sequence_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX knowledge_page_changes_page_sequence_idx ON public.knowledge_page_changes USING btree (page_id, change_sequence DESC);


--
-- Name: knowledge_page_changes_recent_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX knowledge_page_changes_recent_idx ON public.knowledge_page_changes USING btree (change_sequence DESC);


--
-- Name: knowledge_page_versions_page_created_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX knowledge_page_versions_page_created_idx ON public.knowledge_page_versions USING btree (page_id, created_at DESC);


--
-- Name: knowledge_pages_search_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX knowledge_pages_search_idx ON public.knowledge_pages USING gin (search_vector);


--
-- Name: knowledge_revision_contracts_document_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX knowledge_revision_contracts_document_idx ON public.knowledge_revision_contracts USING btree (document_id, revision_id);


--
-- Name: knowledge_search_chunks_vector_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX knowledge_search_chunks_vector_idx ON public.knowledge_search_chunks USING gin (search_vector);


--
-- Name: knowledge_search_vector_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX knowledge_search_vector_idx ON public.knowledge_search USING gin (search_vector);


--
-- Name: oauthAccessToken_authorizationCodeId_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "oauthAccessToken_authorizationCodeId_idx" ON public."oauthAccessToken" USING btree ("authorizationCodeId");


--
-- Name: oauthAccessToken_clientId_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "oauthAccessToken_clientId_idx" ON public."oauthAccessToken" USING btree ("clientId");


--
-- Name: oauthAccessToken_refreshId_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "oauthAccessToken_refreshId_idx" ON public."oauthAccessToken" USING btree ("refreshId");


--
-- Name: oauthAccessToken_sessionId_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "oauthAccessToken_sessionId_idx" ON public."oauthAccessToken" USING btree ("sessionId");


--
-- Name: oauthAccessToken_userId_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "oauthAccessToken_userId_idx" ON public."oauthAccessToken" USING btree ("userId");


--
-- Name: oauthClientResource_clientId_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "oauthClientResource_clientId_idx" ON public."oauthClientResource" USING btree ("clientId");


--
-- Name: oauthClientResource_resourceId_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "oauthClientResource_resourceId_idx" ON public."oauthClientResource" USING btree ("resourceId");


--
-- Name: oauthClient_userId_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "oauthClient_userId_idx" ON public."oauthClient" USING btree ("userId");


--
-- Name: oauthConsent_clientId_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "oauthConsent_clientId_idx" ON public."oauthConsent" USING btree ("clientId");


--
-- Name: oauthConsent_userId_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "oauthConsent_userId_idx" ON public."oauthConsent" USING btree ("userId");


--
-- Name: oauthRefreshToken_authorizationCodeId_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "oauthRefreshToken_authorizationCodeId_idx" ON public."oauthRefreshToken" USING btree ("authorizationCodeId");


--
-- Name: oauthRefreshToken_clientId_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "oauthRefreshToken_clientId_idx" ON public."oauthRefreshToken" USING btree ("clientId");


--
-- Name: oauthRefreshToken_sessionId_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "oauthRefreshToken_sessionId_idx" ON public."oauthRefreshToken" USING btree ("sessionId");


--
-- Name: oauthRefreshToken_userId_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "oauthRefreshToken_userId_idx" ON public."oauthRefreshToken" USING btree ("userId");


--
-- Name: page_deletion_intents_expiry_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX page_deletion_intents_expiry_idx ON public.page_deletion_intents USING btree (expires_at);


--
-- Name: passkey_credentialID_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "passkey_credentialID_idx" ON public.passkey USING btree ("credentialID");


--
-- Name: passkey_credentialID_unique; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX "passkey_credentialID_unique" ON public.passkey USING btree ("credentialID");


--
-- Name: passkey_management_intents_expiry_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX passkey_management_intents_expiry_idx ON public.passkey_management_intents USING btree (expires_at);


--
-- Name: public_asset_artifacts_resource_history_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX public_asset_artifacts_resource_history_idx ON public.public_asset_artifacts USING btree (public_id, created_at DESC, artifact_id);


--
-- Name: public_asset_artifacts_source_history_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX public_asset_artifacts_source_history_idx ON public.public_asset_artifacts USING btree (source_document_id, created_at DESC);


--
-- Name: public_namespace_conflicts_uuid_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX public_namespace_conflicts_uuid_idx ON public.public_namespace_conflicts USING btree (namespace_uuid, conflict_kind);


--
-- Name: public_page_artifacts_resource_history_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX public_page_artifacts_resource_history_idx ON public.public_page_artifacts USING btree (public_id, created_at DESC, artifact_id);


--
-- Name: public_page_artifacts_source_history_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX public_page_artifacts_source_history_idx ON public.public_page_artifacts USING btree (source_document_id, source_revision_id, created_at DESC);


--
-- Name: public_resources_original_document_unique; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX public_resources_original_document_unique ON public.public_resources USING btree (original_document_id) WHERE (original_document_id IS NOT NULL);


--
-- Name: public_route_aliases_canonical_uuid_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX public_route_aliases_canonical_uuid_idx ON public.public_route_aliases USING btree (public.canonical_legacy_alias_uuid(alias_path)) WHERE (public.canonical_legacy_alias_uuid(alias_path) IS NOT NULL);


--
-- Name: public_route_aliases_public_resource_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX public_route_aliases_public_resource_idx ON public.public_route_aliases USING btree (public_id, route_kind);


--
-- Name: publication_intents_expiry_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX publication_intents_expiry_idx ON public.publication_intents USING btree (expires_at) WHERE ((confirmed_at IS NULL) AND (cancelled_at IS NULL));


--
-- Name: session_userId_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "session_userId_idx" ON public.session USING btree ("userId");


--
-- Name: source_record_search_chunks_vector_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX source_record_search_chunks_vector_idx ON public.source_record_search_chunks USING gin (search_vector);


--
-- Name: source_records_connection_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX source_records_connection_idx ON public.source_records USING btree (connection_id, source_updated_at DESC);


--
-- Name: source_records_connection_instance_identity_unique; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX source_records_connection_instance_identity_unique ON public.source_records USING btree (integration, connection_instance_id, model, source_record_id) WHERE (connection_instance_id IS NOT NULL);


--
-- Name: source_records_legacy_connection_identity_unique; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX source_records_legacy_connection_identity_unique ON public.source_records USING btree (integration, connection_id, model, source_record_id) WHERE (connection_instance_id IS NULL);


--
-- Name: source_records_search_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX source_records_search_idx ON public.source_records USING gin (search_vector);


--
-- Name: verification_identifier_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX verification_identifier_idx ON public.verification USING btree (identifier);


--
-- Name: asset_publications asset_publications_028_validate_active_mapping; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER asset_publications_028_validate_active_mapping BEFORE INSERT OR UPDATE ON public.asset_publications FOR EACH ROW EXECUTE FUNCTION public.validate_active_publication_pin();


--
-- Name: asset_publications asset_publications_029_bump_public_visibility; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER asset_publications_029_bump_public_visibility AFTER INSERT OR DELETE OR UPDATE ON public.asset_publications FOR EACH ROW EXECUTE FUNCTION public.bump_pin_public_visibility();


--
-- Name: assets assets_028_protect_active_publication_delete; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER assets_028_protect_active_publication_delete BEFORE DELETE ON public.assets FOR EACH ROW EXECUTE FUNCTION public.protect_active_asset_publication();


--
-- Name: assets assets_028_protect_active_publication_update; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER assets_028_protect_active_publication_update BEFORE UPDATE OF deleted_at ON public.assets FOR EACH ROW EXECUTE FUNCTION public.protect_active_asset_publication();


--
-- Name: assets assets_keep_document_identity_stable; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER assets_keep_document_identity_stable BEFORE UPDATE OF id ON public.assets FOR EACH ROW EXECUTE FUNCTION public.keep_asset_document_identity_stable();


--
-- Name: assets assets_register_document_identity; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER assets_register_document_identity BEFORE INSERT ON public.assets FOR EACH ROW EXECUTE FUNCTION public.register_asset_document_identity();


--
-- Name: assets assets_remove_document_identities_after_truncate; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER assets_remove_document_identities_after_truncate AFTER TRUNCATE ON public.assets FOR EACH STATEMENT EXECUTE FUNCTION public.remove_truncated_asset_document_identities();


--
-- Name: assets assets_remove_document_identity; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER assets_remove_document_identity AFTER DELETE ON public.assets FOR EACH ROW EXECUTE FUNCTION public.remove_deleted_asset_document_identity();


--
-- Name: assets assets_zz029_bump_publication_target; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER assets_zz029_bump_publication_target AFTER INSERT OR DELETE OR UPDATE OF filename, content_type, size_bytes, content_hash, s3_object_key, width, height, duration_seconds, deleted_at ON public.assets FOR EACH ROW EXECUTE FUNCTION public.bump_asset_publication_target_generation();


--
-- Name: automation_registry automation_registry_prevent_cross_role_reuse; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER automation_registry_prevent_cross_role_reuse BEFORE INSERT OR UPDATE OF instructions_document_id, state_document_id ON public.automation_registry FOR EACH ROW EXECUTE FUNCTION public.prevent_automation_document_role_reuse();


--
-- Name: automation_registry automation_registry_validate_documents; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER automation_registry_validate_documents BEFORE INSERT OR UPDATE OF instructions_document_id, state_document_id ON public.automation_registry FOR EACH ROW EXECUTE FUNCTION public.validate_automation_registry_documents();


--
-- Name: confirmation_challenges confirmation_challenges_030_reject_pending_object_claim; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER confirmation_challenges_030_reject_pending_object_claim BEFORE INSERT ON public.confirmation_challenges FOR EACH ROW EXECUTE FUNCTION public.reject_pending_publication_claim_challenge();


--
-- Name: hypermedia_bootstrap_allocations hypermedia_bootstrap_040_keep_allocations; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER hypermedia_bootstrap_040_keep_allocations BEFORE DELETE OR UPDATE ON public.hypermedia_bootstrap_allocations FOR EACH ROW EXECUTE FUNCTION public.guard_hypermedia_bootstrap_allocations();


--
-- Name: hypermedia_document_revisions hypermedia_document_revisions_validate_representation; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER hypermedia_document_revisions_validate_representation BEFORE INSERT OR UPDATE OF document_id ON public.hypermedia_document_revisions FOR EACH ROW EXECUTE FUNCTION public.validate_markdown_document_revision();


--
-- Name: hypermedia_documents hypermedia_documents_028_guard_public_uuid; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER hypermedia_documents_028_guard_public_uuid BEFORE INSERT OR UPDATE OF id ON public.hypermedia_documents FOR EACH ROW EXECUTE FUNCTION public.guard_private_uuid_columns('id');


--
-- Name: hypermedia_documents hypermedia_documents_keep_identity_stable; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER hypermedia_documents_keep_identity_stable BEFORE UPDATE OF id, authority, representation ON public.hypermedia_documents FOR EACH ROW EXECUTE FUNCTION public.keep_hypermedia_document_identity_stable();


--
-- Name: hypermedia_document_revisions hypermedia_revisions_028_guard_public_uuid; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER hypermedia_revisions_028_guard_public_uuid BEFORE INSERT OR UPDATE OF id ON public.hypermedia_document_revisions FOR EACH ROW EXECUTE FUNCTION public.guard_private_uuid_columns('id');


--
-- Name: knowledge_page_versions knowledge_page_versions_capture_current_change; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER knowledge_page_versions_capture_current_change AFTER INSERT ON public.knowledge_page_versions FOR EACH ROW EXECUTE FUNCTION public.capture_inserted_current_page_version();


--
-- Name: knowledge_page_versions knowledge_page_versions_capture_deletion; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER knowledge_page_versions_capture_deletion BEFORE DELETE ON public.knowledge_page_versions FOR EACH ROW EXECUTE FUNCTION public.capture_deleted_current_page_version();


--
-- Name: knowledge_page_versions knowledge_page_versions_remove_document_revision; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER knowledge_page_versions_remove_document_revision AFTER DELETE ON public.knowledge_page_versions FOR EACH ROW EXECUTE FUNCTION public.remove_deleted_knowledge_revision_metadata();


--
-- Name: knowledge_pages knowledge_pages_028_protect_active_publication_delete; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER knowledge_pages_028_protect_active_publication_delete BEFORE DELETE ON public.knowledge_pages FOR EACH ROW EXECUTE FUNCTION public.protect_active_page_publication();


--
-- Name: knowledge_pages knowledge_pages_028_protect_active_publication_update; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER knowledge_pages_028_protect_active_publication_update BEFORE UPDATE OF archived_at ON public.knowledge_pages FOR EACH ROW EXECUTE FUNCTION public.protect_active_page_publication();


--
-- Name: knowledge_pages knowledge_pages_037_capture_archive; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER knowledge_pages_037_capture_archive AFTER UPDATE OF archived_at ON public.knowledge_pages FOR EACH ROW WHEN (((old.archived_at IS NULL) AND (new.archived_at IS NOT NULL))) EXECUTE FUNCTION public.capture_archived_knowledge_document();


--
-- Name: knowledge_pages knowledge_pages_capture_current_change; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER knowledge_pages_capture_current_change AFTER UPDATE OF current_version_id ON public.knowledge_pages FOR EACH ROW WHEN ((old.current_version_id IS DISTINCT FROM new.current_version_id)) EXECUTE FUNCTION public.capture_updated_current_page_version();


--
-- Name: knowledge_pages knowledge_pages_lock_settings_before_guide_delete; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER knowledge_pages_lock_settings_before_guide_delete BEFORE DELETE ON public.knowledge_pages FOR EACH STATEMENT EXECUTE FUNCTION public.lock_knowledge_settings_for_page_lifecycle();


--
-- Name: knowledge_pages knowledge_pages_lock_settings_before_guide_update; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER knowledge_pages_lock_settings_before_guide_update BEFORE UPDATE OF archived_at ON public.knowledge_pages FOR EACH STATEMENT EXECUTE FUNCTION public.lock_knowledge_settings_for_page_lifecycle();


--
-- Name: knowledge_pages knowledge_pages_protect_configured_global_guide_delete; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER knowledge_pages_protect_configured_global_guide_delete BEFORE DELETE ON public.knowledge_pages FOR EACH ROW EXECUTE FUNCTION public.protect_configured_global_knowledge_guide();


--
-- Name: knowledge_pages knowledge_pages_protect_configured_global_guide_update; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER knowledge_pages_protect_configured_global_guide_update BEFORE UPDATE OF archived_at ON public.knowledge_pages FOR EACH ROW EXECUTE FUNCTION public.protect_configured_global_knowledge_guide();


--
-- Name: knowledge_pages knowledge_pages_protect_registered_automation_delete; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER knowledge_pages_protect_registered_automation_delete BEFORE DELETE ON public.knowledge_pages FOR EACH ROW EXECUTE FUNCTION public.protect_registered_automation_documents();


--
-- Name: knowledge_pages knowledge_pages_protect_registered_automation_update; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER knowledge_pages_protect_registered_automation_update BEFORE UPDATE OF archived_at ON public.knowledge_pages FOR EACH ROW EXECUTE FUNCTION public.protect_registered_automation_documents();


--
-- Name: knowledge_pages knowledge_pages_register_document; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER knowledge_pages_register_document AFTER INSERT ON public.knowledge_pages FOR EACH ROW EXECUTE FUNCTION public.register_knowledge_document_metadata();


--
-- Name: knowledge_pages knowledge_pages_register_document_identity_validation; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER knowledge_pages_register_document_identity_validation AFTER INSERT OR UPDATE OF id ON public.knowledge_pages FOR EACH ROW EXECUTE FUNCTION public.validate_knowledge_page_document_identity();


--
-- Name: knowledge_pages knowledge_pages_remove_document; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER knowledge_pages_remove_document AFTER DELETE ON public.knowledge_pages FOR EACH ROW EXECUTE FUNCTION public.remove_deleted_knowledge_document_metadata();


--
-- Name: knowledge_pages knowledge_pages_replace_document_identity; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER knowledge_pages_replace_document_identity AFTER UPDATE OF id ON public.knowledge_pages FOR EACH ROW WHEN ((old.id IS DISTINCT FROM new.id)) EXECUTE FUNCTION public.replace_knowledge_document_identity_metadata();


--
-- Name: knowledge_pages knowledge_pages_zz029_bump_publication_target; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER knowledge_pages_zz029_bump_publication_target AFTER INSERT OR DELETE OR UPDATE OF current_version_id, archived_at ON public.knowledge_pages FOR EACH ROW EXECUTE FUNCTION public.bump_page_publication_target_generation();


--
-- Name: knowledge_settings knowledge_settings_validate_global_guide; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER knowledge_settings_validate_global_guide BEFORE INSERT OR UPDATE OF global_guide_document_id ON public.knowledge_settings FOR EACH ROW EXECUTE FUNCTION public.validate_global_knowledge_guide();


--
-- Name: page_publications page_publications_028_validate_active_mapping; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER page_publications_028_validate_active_mapping BEFORE INSERT OR UPDATE ON public.page_publications FOR EACH ROW EXECUTE FUNCTION public.validate_active_publication_pin();


--
-- Name: page_publications page_publications_029_bump_public_visibility; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER page_publications_029_bump_public_visibility AFTER INSERT OR DELETE OR UPDATE ON public.page_publications FOR EACH ROW EXECUTE FUNCTION public.bump_pin_public_visibility();


--
-- Name: passkey passkey_protect_credential; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER passkey_protect_credential BEFORE DELETE OR UPDATE ON public.passkey FOR EACH ROW EXECUTE FUNCTION public.protect_passkey_credential();


--
-- Name: public_artifact_id_reservations public_artifact_reservations_028_guard_namespace; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER public_artifact_reservations_028_guard_namespace BEFORE INSERT OR DELETE OR UPDATE ON public.public_artifact_id_reservations FOR EACH ROW EXECUTE FUNCTION public.guard_artifact_reservation_namespace();


--
-- Name: public_asset_artifacts public_asset_artifacts_029_keep_history; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER public_asset_artifacts_029_keep_history BEFORE INSERT OR DELETE OR UPDATE ON public.public_asset_artifacts FOR EACH ROW EXECUTE FUNCTION public.guard_public_artifact_history();


--
-- Name: public_page_artifacts public_page_artifacts_029_keep_history; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER public_page_artifacts_029_keep_history BEFORE INSERT OR DELETE OR UPDATE ON public.public_page_artifacts FOR EACH ROW EXECUTE FUNCTION public.guard_public_artifact_history();


--
-- Name: public_representation_token_reservations public_representation_tokens_029_keep_immutable; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER public_representation_tokens_029_keep_immutable BEFORE DELETE OR UPDATE ON public.public_representation_token_reservations FOR EACH ROW EXECUTE FUNCTION public.guard_public_representation_token_reservation();


--
-- Name: public_resources public_resources_028_guard_identity; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER public_resources_028_guard_identity BEFORE INSERT OR DELETE OR UPDATE ON public.public_resources FOR EACH ROW EXECUTE FUNCTION public.guard_public_resource_identity();


--
-- Name: public_resources public_resources_029_initialize_visibility_generation; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER public_resources_029_initialize_visibility_generation AFTER INSERT ON public.public_resources FOR EACH ROW EXECUTE FUNCTION public.initialize_public_visibility_generation();


--
-- Name: public_resources public_resources_validate_mapping; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER public_resources_validate_mapping BEFORE INSERT OR UPDATE OF document_id, resource_kind ON public.public_resources FOR EACH ROW EXECUTE FUNCTION public.validate_public_resource_mapping();


--
-- Name: public_route_aliases public_route_aliases_028_guard_namespace; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER public_route_aliases_028_guard_namespace BEFORE INSERT OR DELETE OR UPDATE ON public.public_route_aliases FOR EACH ROW EXECUTE FUNCTION public.guard_legacy_alias_namespace();


--
-- Name: publication_object_claims publication_claims_030_keep_history; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER publication_claims_030_keep_history BEFORE DELETE OR UPDATE ON public.publication_object_claims FOR EACH ROW EXECUTE FUNCTION public.guard_publication_object_claim_history();


--
-- Name: publication_intent_id_reservations publication_intent_ids_029_keep_immutable; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER publication_intent_ids_029_keep_immutable BEFORE DELETE OR UPDATE ON public.publication_intent_id_reservations FOR EACH ROW EXECUTE FUNCTION public.guard_publication_intent_id_reservation();


--
-- Name: publication_intents publication_intents_029_reserve_uuid; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER publication_intents_029_reserve_uuid BEFORE INSERT ON public.publication_intents FOR EACH ROW EXECUTE FUNCTION public.reserve_publication_intent_id_from_row();


--
-- Name: publication_intents publication_intents_zz029_keep_history; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER publication_intents_zz029_keep_history BEFORE DELETE OR UPDATE ON public.publication_intents FOR EACH ROW EXECUTE FUNCTION public.guard_publication_intent_history();


--
-- Name: publication_artifact_staging publication_staging_029_keep_history; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER publication_staging_029_keep_history BEFORE DELETE OR UPDATE ON public.publication_artifact_staging FOR EACH ROW EXECUTE FUNCTION public.guard_publication_staging_history();


--
-- Name: publication_artifact_staging publication_staging_030_require_claim; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER publication_staging_030_require_claim BEFORE INSERT ON public.publication_artifact_staging FOR EACH ROW EXECUTE FUNCTION public.require_finalized_publication_object_claim();


--
-- Name: retained_page_artifacts retained_page_artifacts_028_reserve_identity; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER retained_page_artifacts_028_reserve_identity BEFORE INSERT OR UPDATE OF artifact_id, body_object_key ON public.retained_page_artifacts FOR EACH ROW EXECUTE FUNCTION public.reserve_retained_page_artifact_identity();


--
-- Name: source_records source_records_validate_document_identity; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER source_records_validate_document_identity BEFORE INSERT OR UPDATE OF document_id ON public.source_records FOR EACH ROW EXECUTE FUNCTION public.validate_source_record_document_identity();


--
-- Name: user user_protect_owner_identity; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER user_protect_owner_identity BEFORE DELETE OR UPDATE ON public."user" FOR EACH ROW EXECUTE FUNCTION public.protect_owner_identity();


--
-- Name: account account_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.account
    ADD CONSTRAINT "account_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."user"(id) ON DELETE CASCADE;


--
-- Name: asset_publications asset_publications_public_id_artifact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.asset_publications
    ADD CONSTRAINT asset_publications_public_id_artifact_id_fkey FOREIGN KEY (public_id, artifact_id) REFERENCES public.public_asset_artifacts(public_id, artifact_id) ON DELETE RESTRICT;


--
-- Name: asset_publications asset_publications_public_id_resource_kind_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.asset_publications
    ADD CONSTRAINT asset_publications_public_id_resource_kind_fkey FOREIGN KEY (public_id, resource_kind) REFERENCES public.public_resources(public_id, resource_kind) ON DELETE RESTRICT;


--
-- Name: assets assets_document_identity_fk; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.assets
    ADD CONSTRAINT assets_document_identity_fk FOREIGN KEY (id) REFERENCES public.hypermedia_documents(id) ON DELETE RESTRICT;


--
-- Name: automation_registry automation_registry_instructions_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.automation_registry
    ADD CONSTRAINT automation_registry_instructions_document_id_fkey FOREIGN KEY (instructions_document_id) REFERENCES public.hypermedia_documents(id) ON DELETE RESTRICT;


--
-- Name: automation_registry automation_registry_state_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.automation_registry
    ADD CONSTRAINT automation_registry_state_document_id_fkey FOREIGN KEY (state_document_id) REFERENCES public.hypermedia_documents(id) ON DELETE RESTRICT;


--
-- Name: document_links document_links_source_revision_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.document_links
    ADD CONSTRAINT document_links_source_revision_id_fkey FOREIGN KEY (source_revision_id) REFERENCES public.hypermedia_document_revisions(id) ON DELETE CASCADE;


--
-- Name: document_links document_links_target_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.document_links
    ADD CONSTRAINT document_links_target_document_id_fkey FOREIGN KEY (target_document_id) REFERENCES public.hypermedia_documents(id) ON DELETE CASCADE;


--
-- Name: hypermedia_document_revisions hypermedia_document_revisions_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.hypermedia_document_revisions
    ADD CONSTRAINT hypermedia_document_revisions_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.hypermedia_documents(id) ON DELETE CASCADE;


--
-- Name: knowledge_asset_links knowledge_asset_links_source_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.knowledge_asset_links
    ADD CONSTRAINT knowledge_asset_links_source_version_id_fkey FOREIGN KEY (source_version_id) REFERENCES public.knowledge_page_versions(id) ON DELETE CASCADE;


--
-- Name: knowledge_asset_links knowledge_asset_links_target_asset_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.knowledge_asset_links
    ADD CONSTRAINT knowledge_asset_links_target_asset_id_fkey FOREIGN KEY (target_asset_id) REFERENCES public.assets(id) ON DELETE RESTRICT;


--
-- Name: knowledge_page_versions knowledge_page_versions_page_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.knowledge_page_versions
    ADD CONSTRAINT knowledge_page_versions_page_id_fkey FOREIGN KEY (page_id) REFERENCES public.knowledge_pages(id) ON DELETE RESTRICT;


--
-- Name: knowledge_pages knowledge_pages_current_version_fk; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.knowledge_pages
    ADD CONSTRAINT knowledge_pages_current_version_fk FOREIGN KEY (current_version_id, id) REFERENCES public.knowledge_page_versions(id, page_id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: knowledge_revision_contracts knowledge_revision_contracts_revision_id_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.knowledge_revision_contracts
    ADD CONSTRAINT knowledge_revision_contracts_revision_id_document_id_fkey FOREIGN KEY (revision_id, document_id) REFERENCES public.hypermedia_document_revisions(id, document_id) ON DELETE CASCADE;


--
-- Name: knowledge_search_chunks knowledge_search_chunks_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.knowledge_search_chunks
    ADD CONSTRAINT knowledge_search_chunks_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.hypermedia_documents(id) ON DELETE CASCADE;


--
-- Name: knowledge_search_chunks knowledge_search_chunks_revision_id_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.knowledge_search_chunks
    ADD CONSTRAINT knowledge_search_chunks_revision_id_document_id_fkey FOREIGN KEY (revision_id, document_id) REFERENCES public.hypermedia_document_revisions(id, document_id) ON DELETE CASCADE;


--
-- Name: knowledge_search knowledge_search_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.knowledge_search
    ADD CONSTRAINT knowledge_search_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.hypermedia_documents(id) ON DELETE CASCADE;


--
-- Name: knowledge_search knowledge_search_revision_id_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.knowledge_search
    ADD CONSTRAINT knowledge_search_revision_id_document_id_fkey FOREIGN KEY (revision_id, document_id) REFERENCES public.hypermedia_document_revisions(id, document_id) ON DELETE CASCADE;


--
-- Name: knowledge_settings knowledge_settings_global_guide_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.knowledge_settings
    ADD CONSTRAINT knowledge_settings_global_guide_document_id_fkey FOREIGN KEY (global_guide_document_id) REFERENCES public.hypermedia_documents(id) ON DELETE RESTRICT;


--
-- Name: oauthAccessToken oauthAccessToken_clientId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public."oauthAccessToken"
    ADD CONSTRAINT "oauthAccessToken_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES public."oauthClient"("clientId") ON DELETE CASCADE;


--
-- Name: oauthAccessToken oauthAccessToken_refreshId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public."oauthAccessToken"
    ADD CONSTRAINT "oauthAccessToken_refreshId_fkey" FOREIGN KEY ("refreshId") REFERENCES public."oauthRefreshToken"(id) ON DELETE CASCADE;


--
-- Name: oauthAccessToken oauthAccessToken_sessionId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public."oauthAccessToken"
    ADD CONSTRAINT "oauthAccessToken_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES public.session(id) ON DELETE SET NULL;


--
-- Name: oauthAccessToken oauthAccessToken_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public."oauthAccessToken"
    ADD CONSTRAINT "oauthAccessToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."user"(id) ON DELETE CASCADE;


--
-- Name: oauthClientResource oauthClientResource_clientId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public."oauthClientResource"
    ADD CONSTRAINT "oauthClientResource_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES public."oauthClient"("clientId") ON DELETE CASCADE;


--
-- Name: oauthClientResource oauthClientResource_resourceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public."oauthClientResource"
    ADD CONSTRAINT "oauthClientResource_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES public."oauthResource"(identifier) ON DELETE CASCADE;


--
-- Name: oauthClient oauthClient_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public."oauthClient"
    ADD CONSTRAINT "oauthClient_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."user"(id) ON DELETE CASCADE;


--
-- Name: oauthConsent oauthConsent_clientId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public."oauthConsent"
    ADD CONSTRAINT "oauthConsent_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES public."oauthClient"("clientId") ON DELETE CASCADE;


--
-- Name: oauthConsent oauthConsent_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public."oauthConsent"
    ADD CONSTRAINT "oauthConsent_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."user"(id) ON DELETE CASCADE;


--
-- Name: oauthRefreshToken oauthRefreshToken_clientId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public."oauthRefreshToken"
    ADD CONSTRAINT "oauthRefreshToken_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES public."oauthClient"("clientId") ON DELETE CASCADE;


--
-- Name: oauthRefreshToken oauthRefreshToken_sessionId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public."oauthRefreshToken"
    ADD CONSTRAINT "oauthRefreshToken_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES public.session(id) ON DELETE SET NULL;


--
-- Name: oauthRefreshToken oauthRefreshToken_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public."oauthRefreshToken"
    ADD CONSTRAINT "oauthRefreshToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."user"(id) ON DELETE CASCADE;


--
-- Name: page_deletion_intents page_deletion_intents_page_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.page_deletion_intents
    ADD CONSTRAINT page_deletion_intents_page_id_fkey FOREIGN KEY (page_id) REFERENCES public.knowledge_pages(id) ON DELETE CASCADE;


--
-- Name: page_publications page_publications_public_id_artifact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.page_publications
    ADD CONSTRAINT page_publications_public_id_artifact_id_fkey FOREIGN KEY (public_id, artifact_id) REFERENCES public.public_page_artifacts(public_id, artifact_id) ON DELETE RESTRICT;


--
-- Name: page_publications page_publications_public_id_resource_kind_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.page_publications
    ADD CONSTRAINT page_publications_public_id_resource_kind_fkey FOREIGN KEY (public_id, resource_kind) REFERENCES public.public_resources(public_id, resource_kind) ON DELETE RESTRICT;


--
-- Name: passkey_management_intents passkey_management_intents_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.passkey_management_intents
    ADD CONSTRAINT passkey_management_intents_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.session(id) ON DELETE CASCADE;


--
-- Name: passkey_management_intents passkey_management_intents_target_passkey_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.passkey_management_intents
    ADD CONSTRAINT passkey_management_intents_target_passkey_id_fkey FOREIGN KEY (target_passkey_id) REFERENCES public.passkey(id) ON DELETE CASCADE;


--
-- Name: passkey passkey_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.passkey
    ADD CONSTRAINT "passkey_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."user"(id) ON DELETE CASCADE;


--
-- Name: public_asset_artifacts public_asset_artifacts_artifact_id_body_object_key_reserva_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.public_asset_artifacts
    ADD CONSTRAINT public_asset_artifacts_artifact_id_body_object_key_reserva_fkey FOREIGN KEY (artifact_id, body_object_key, reservation_allocation_kind, reservation_allocation_id) REFERENCES public.public_artifact_id_reservations(artifact_id, body_object_key, allocation_kind, allocation_id) ON DELETE RESTRICT;


--
-- Name: public_asset_artifacts public_asset_artifacts_public_id_resource_kind_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.public_asset_artifacts
    ADD CONSTRAINT public_asset_artifacts_public_id_resource_kind_fkey FOREIGN KEY (public_id, resource_kind) REFERENCES public.public_resources(public_id, resource_kind) ON DELETE RESTRICT;


--
-- Name: public_asset_artifacts public_asset_artifacts_public_id_source_document_id_resour_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.public_asset_artifacts
    ADD CONSTRAINT public_asset_artifacts_public_id_source_document_id_resour_fkey FOREIGN KEY (public_id, source_document_id, resource_kind) REFERENCES public.public_resources(public_id, original_document_id, resource_kind) ON DELETE RESTRICT;


--
-- Name: public_asset_artifacts public_asset_artifacts_representation_reservation_fk; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.public_asset_artifacts
    ADD CONSTRAINT public_asset_artifacts_representation_reservation_fk FOREIGN KEY (representation_token, artifact_id, resource_kind) REFERENCES public.public_representation_token_reservations(representation_token, artifact_id, resource_kind) ON DELETE RESTRICT;


--
-- Name: public_asset_artifacts public_asset_artifacts_source_intent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.public_asset_artifacts
    ADD CONSTRAINT public_asset_artifacts_source_intent_id_fkey FOREIGN KEY (source_intent_id) REFERENCES public.publication_intents(id) ON DELETE RESTRICT;


--
-- Name: public_asset_artifacts public_asset_artifacts_source_intent_id_resource_kind_publ_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.public_asset_artifacts
    ADD CONSTRAINT public_asset_artifacts_source_intent_id_resource_kind_publ_fkey FOREIGN KEY (source_intent_id, resource_kind, public_id, artifact_id, body_object_key) REFERENCES public.publication_artifact_staging(intent_id, target_kind, candidate_public_id, artifact_id, body_object_key) ON DELETE RESTRICT;


--
-- Name: public_asset_artifacts public_asset_artifacts_source_intent_id_resource_kind_sour_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.public_asset_artifacts
    ADD CONSTRAINT public_asset_artifacts_source_intent_id_resource_kind_sour_fkey FOREIGN KEY (source_intent_id, resource_kind, source_document_id, public_id, artifact_id, body_object_key) REFERENCES public.publication_intents(id, target_kind, target_document_id, candidate_public_id, candidate_artifact_id, candidate_object_key) ON DELETE RESTRICT;


--
-- Name: public_page_artifacts public_page_artifacts_artifact_id_body_object_key_reservat_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.public_page_artifacts
    ADD CONSTRAINT public_page_artifacts_artifact_id_body_object_key_reservat_fkey FOREIGN KEY (artifact_id, body_object_key, reservation_allocation_kind, reservation_allocation_id) REFERENCES public.public_artifact_id_reservations(artifact_id, body_object_key, allocation_kind, allocation_id) ON DELETE RESTRICT;


--
-- Name: public_page_artifacts public_page_artifacts_public_id_resource_kind_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.public_page_artifacts
    ADD CONSTRAINT public_page_artifacts_public_id_resource_kind_fkey FOREIGN KEY (public_id, resource_kind) REFERENCES public.public_resources(public_id, resource_kind) ON DELETE RESTRICT;


--
-- Name: public_page_artifacts public_page_artifacts_public_id_source_document_id_resourc_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.public_page_artifacts
    ADD CONSTRAINT public_page_artifacts_public_id_source_document_id_resourc_fkey FOREIGN KEY (public_id, source_document_id, resource_kind) REFERENCES public.public_resources(public_id, original_document_id, resource_kind) ON DELETE RESTRICT;


--
-- Name: public_page_artifacts public_page_artifacts_representation_reservation_fk; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.public_page_artifacts
    ADD CONSTRAINT public_page_artifacts_representation_reservation_fk FOREIGN KEY (representation_token, artifact_id, resource_kind) REFERENCES public.public_representation_token_reservations(representation_token, artifact_id, resource_kind) ON DELETE RESTRICT;


--
-- Name: public_page_artifacts public_page_artifacts_source_intent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.public_page_artifacts
    ADD CONSTRAINT public_page_artifacts_source_intent_id_fkey FOREIGN KEY (source_intent_id) REFERENCES public.publication_intents(id) ON DELETE RESTRICT;


--
-- Name: public_page_artifacts public_page_artifacts_source_intent_id_resource_kind_publi_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.public_page_artifacts
    ADD CONSTRAINT public_page_artifacts_source_intent_id_resource_kind_publi_fkey FOREIGN KEY (source_intent_id, resource_kind, public_id, artifact_id, body_object_key) REFERENCES public.publication_artifact_staging(intent_id, target_kind, candidate_public_id, artifact_id, body_object_key) ON DELETE RESTRICT;


--
-- Name: public_page_artifacts public_page_artifacts_source_intent_id_resource_kind_sourc_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.public_page_artifacts
    ADD CONSTRAINT public_page_artifacts_source_intent_id_resource_kind_sourc_fkey FOREIGN KEY (source_intent_id, resource_kind, source_document_id, source_revision_id, public_id, artifact_id, body_object_key) REFERENCES public.publication_intents(id, target_kind, target_document_id, expected_revision_id, candidate_public_id, candidate_artifact_id, candidate_object_key) ON DELETE RESTRICT;


--
-- Name: public_resources public_resources_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.public_resources
    ADD CONSTRAINT public_resources_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.hypermedia_documents(id) ON DELETE SET NULL;


--
-- Name: public_route_aliases public_route_aliases_public_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.public_route_aliases
    ADD CONSTRAINT public_route_aliases_public_id_fkey FOREIGN KEY (public_id) REFERENCES public.public_resources(public_id) ON DELETE RESTRICT;


--
-- Name: public_visibility_generations public_visibility_generations_public_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.public_visibility_generations
    ADD CONSTRAINT public_visibility_generations_public_id_fkey FOREIGN KEY (public_id) REFERENCES public.public_resources(public_id) ON DELETE RESTRICT;


--
-- Name: publication_artifact_staging publication_artifact_artifact_id_body_object_key__fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.publication_artifact_staging
    ADD CONSTRAINT publication_artifact_artifact_id_body_object_key__fkey FOREIGN KEY (artifact_id, body_object_key, allocation_kind, allocation_id) REFERENCES public.public_artifact_id_reservations(artifact_id, body_object_key, allocation_kind, allocation_id) ON DELETE RESTRICT;


--
-- Name: publication_artifact_staging publication_artifact_intent_id_target_kind_candid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.publication_artifact_staging
    ADD CONSTRAINT publication_artifact_intent_id_target_kind_candid_fkey FOREIGN KEY (intent_id, target_kind, candidate_public_id, artifact_id, body_object_key) REFERENCES public.publication_intents(id, target_kind, candidate_public_id, candidate_artifact_id, candidate_object_key) ON DELETE RESTRICT;


--
-- Name: publication_intents publication_intents_candidate_artifact_id_candida_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.publication_intents
    ADD CONSTRAINT publication_intents_candidate_artifact_id_candida_fkey FOREIGN KEY (candidate_artifact_id, candidate_object_key, artifact_allocation_kind, artifact_allocation_id) REFERENCES public.public_artifact_id_reservations(artifact_id, body_object_key, allocation_kind, allocation_id) ON DELETE RESTRICT;


--
-- Name: publication_object_claims publication_object_c_artifact_id_body_object_key__fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.publication_object_claims
    ADD CONSTRAINT publication_object_c_artifact_id_body_object_key__fkey FOREIGN KEY (artifact_id, body_object_key, allocation_kind, allocation_id) REFERENCES public.public_artifact_id_reservations(artifact_id, body_object_key, allocation_kind, allocation_id);


--
-- Name: publication_settings publication_settings_entrypoint_public_id_entrypo_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.publication_settings
    ADD CONSTRAINT publication_settings_entrypoint_public_id_entrypo_fkey FOREIGN KEY (entrypoint_public_id, entrypoint_resource_kind) REFERENCES public.public_resources(public_id, resource_kind) ON DELETE RESTRICT;


--
-- Name: publication_artifact_staging publication_staging_representation_reservation_fk; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.publication_artifact_staging
    ADD CONSTRAINT publication_staging_representation_reservation_fk FOREIGN KEY (representation_token, artifact_id, target_kind) REFERENCES public.public_representation_token_reservations(representation_token, artifact_id, resource_kind) ON DELETE RESTRICT;


--
-- Name: retained_page_artifacts retained_page_artifacts_page_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.retained_page_artifacts
    ADD CONSTRAINT retained_page_artifacts_page_id_fkey FOREIGN KEY (page_id) REFERENCES public.knowledge_pages(id) ON DELETE CASCADE;


--
-- Name: retained_page_artifacts retained_page_artifacts_version_id_page_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.retained_page_artifacts
    ADD CONSTRAINT retained_page_artifacts_version_id_page_id_fkey FOREIGN KEY (version_id, page_id) REFERENCES public.knowledge_page_versions(id, page_id) ON DELETE CASCADE;


--
-- Name: session session_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.session
    ADD CONSTRAINT "session_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."user"(id) ON DELETE CASCADE;


--
-- Name: source_record_search_chunks source_record_search_chunks_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.source_record_search_chunks
    ADD CONSTRAINT source_record_search_chunks_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.source_records(document_id) ON DELETE CASCADE;


--
-- Name: source_records source_records_current_revision_id_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.source_records
    ADD CONSTRAINT source_records_current_revision_id_document_id_fkey FOREIGN KEY (current_revision_id, document_id) REFERENCES public.hypermedia_document_revisions(id, document_id) ON DELETE RESTRICT;


--
-- Name: source_records source_records_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.source_records
    ADD CONSTRAINT source_records_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.hypermedia_documents(id) ON DELETE CASCADE;


-- Required singleton state for a newly installed application. The publication
-- timestamp is the bootstrap latch, so both it and the entrypoint remain unset
-- until the bootstrap transaction creates and validates all required documents.
INSERT INTO public.knowledge_settings(singleton) VALUES (true);
INSERT INTO public.publication_settings(singleton, entrypoint_public_id, updated_at)
VALUES (true, NULL, NULL);


--
-- Name: SCHEMA public; Type: ACL; Schema: -; Owner: pg_database_owner
--

REVOKE USAGE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO context_use_auth;
GRANT USAGE ON SCHEMA public TO context_use_dashboard;
GRANT USAGE ON SCHEMA public TO context_use_mcp;
GRANT USAGE ON SCHEMA public TO context_use_public;
GRANT USAGE ON SCHEMA public TO context_use_confirmation;
GRANT USAGE ON SCHEMA public TO context_use_storage;
GRANT USAGE ON SCHEMA public TO context_use_backup;
GRANT USAGE ON SCHEMA public TO context_use_projection_owner;
GRANT USAGE ON SCHEMA public TO context_use_boundary_owner;
GRANT USAGE ON SCHEMA public TO context_use_corpus;
GRANT USAGE ON SCHEMA public TO context_use_publication_lock_owner;
GRANT USAGE ON SCHEMA public TO context_use_storage_owner;
GRANT USAGE ON SCHEMA public TO context_use_document_history_owner;


--
-- Name: TYPE public_route_state; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TYPE public.public_route_state TO context_use_public;
GRANT ALL ON TYPE public.public_route_state TO context_use_backup;


--
-- Name: FUNCTION assert_private_uuid_available(p_uuid uuid); Type: ACL; Schema: public; Owner: context_use_boundary_owner
--

REVOKE ALL ON FUNCTION public.assert_private_uuid_available(p_uuid uuid) FROM PUBLIC;


--
-- Name: FUNCTION assert_public_metadata_safe(p_target_kind public.publication_target, p_title text, p_summary text, p_filename text); Type: ACL; Schema: public; Owner: context_use_boundary_owner
--

REVOKE ALL ON FUNCTION public.assert_public_metadata_safe(p_target_kind public.publication_target, p_title text, p_summary text, p_filename text) FROM PUBLIC;


--
-- Name: FUNCTION assert_public_uuid_available(p_uuid uuid, p_original_document_id uuid, p_resource_kind public.publication_target); Type: ACL; Schema: public; Owner: context_use_boundary_owner
--

REVOKE ALL ON FUNCTION public.assert_public_uuid_available(p_uuid uuid, p_original_document_id uuid, p_resource_kind public.publication_target) FROM PUBLIC;


--
-- Name: FUNCTION assert_publication_intent_current(p_intent_id uuid, p_require_staging boolean); Type: ACL; Schema: public; Owner: context_use_boundary_owner
--

REVOKE ALL ON FUNCTION public.assert_publication_intent_current(p_intent_id uuid, p_require_staging boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION public.assert_publication_intent_current(p_intent_id uuid, p_require_staging boolean) TO context_use_storage_owner;


--
-- Name: FUNCTION assert_publication_staging_exact(p_intent_id uuid); Type: ACL; Schema: public; Owner: context_use_boundary_owner
--

REVOKE ALL ON FUNCTION public.assert_publication_staging_exact(p_intent_id uuid) FROM PUBLIC;


--
-- Name: FUNCTION begin_hypermedia_bootstrap(); Type: ACL; Schema: public; Owner: context_use_boundary_owner
--

REVOKE ALL ON FUNCTION public.begin_hypermedia_bootstrap() FROM PUBLIC;
GRANT ALL ON FUNCTION public.begin_hypermedia_bootstrap() TO context_use_corpus;


--
-- Name: FUNCTION begin_publication_intent(p_intent_id uuid, p_action public.publication_action, p_target_kind public.publication_target, p_target_document_id uuid, p_expected_revision_id uuid, p_owner_user_id text, p_session_id text); Type: ACL; Schema: public; Owner: context_use_boundary_owner
--

REVOKE ALL ON FUNCTION public.begin_publication_intent(p_intent_id uuid, p_action public.publication_action, p_target_kind public.publication_target, p_target_document_id uuid, p_expected_revision_id uuid, p_owner_user_id text, p_session_id text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.begin_publication_intent(p_intent_id uuid, p_action public.publication_action, p_target_kind public.publication_target, p_target_document_id uuid, p_expected_revision_id uuid, p_owner_user_id text, p_session_id text) TO context_use_dashboard;


--
-- Name: FUNCTION bump_asset_publication_target_generation(); Type: ACL; Schema: public; Owner: context_use_boundary_owner
--

REVOKE ALL ON FUNCTION public.bump_asset_publication_target_generation() FROM PUBLIC;


--
-- Name: FUNCTION bump_page_publication_target_generation(); Type: ACL; Schema: public; Owner: context_use_boundary_owner
--

REVOKE ALL ON FUNCTION public.bump_page_publication_target_generation() FROM PUBLIC;


--
-- Name: FUNCTION bump_pin_public_visibility(); Type: ACL; Schema: public; Owner: context_use_boundary_owner
--

REVOKE ALL ON FUNCTION public.bump_pin_public_visibility() FROM PUBLIC;


--
-- Name: FUNCTION bump_public_visibility_generation(p_public_id uuid); Type: ACL; Schema: public; Owner: context_use_boundary_owner
--

REVOKE ALL ON FUNCTION public.bump_public_visibility_generation(p_public_id uuid) FROM PUBLIC;


--
-- Name: FUNCTION bump_publication_target_generation(p_target_kind public.publication_target, p_target_document_id uuid); Type: ACL; Schema: public; Owner: context_use_boundary_owner
--

REVOKE ALL ON FUNCTION public.bump_publication_target_generation(p_target_kind public.publication_target, p_target_document_id uuid) FROM PUBLIC;


--
-- Name: FUNCTION cancel_publication_intent(p_intent_id uuid, p_owner_user_id text, p_session_id text); Type: ACL; Schema: public; Owner: context_use_boundary_owner
--

REVOKE ALL ON FUNCTION public.cancel_publication_intent(p_intent_id uuid, p_owner_user_id text, p_session_id text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.cancel_publication_intent(p_intent_id uuid, p_owner_user_id text, p_session_id text) TO context_use_dashboard;


--
-- Name: FUNCTION canonical_legacy_alias_kind(p_alias_path text); Type: ACL; Schema: public; Owner: context_use_boundary_owner
--

REVOKE ALL ON FUNCTION public.canonical_legacy_alias_kind(p_alias_path text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.canonical_legacy_alias_kind(p_alias_path text) TO context_use_projection_owner;
GRANT ALL ON FUNCTION public.canonical_legacy_alias_kind(p_alias_path text) TO context_use_storage_owner;
GRANT ALL ON FUNCTION public.canonical_legacy_alias_kind(p_alias_path text) TO context_use_public;
GRANT ALL ON FUNCTION public.canonical_legacy_alias_kind(p_alias_path text) TO context_use_backup;


--
-- Name: FUNCTION canonical_legacy_alias_uuid(p_alias_path text); Type: ACL; Schema: public; Owner: context_use_boundary_owner
--

REVOKE ALL ON FUNCTION public.canonical_legacy_alias_uuid(p_alias_path text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.canonical_legacy_alias_uuid(p_alias_path text) TO context_use_projection_owner;
GRANT ALL ON FUNCTION public.canonical_legacy_alias_uuid(p_alias_path text) TO context_use_storage_owner;
GRANT ALL ON FUNCTION public.canonical_legacy_alias_uuid(p_alias_path text) TO context_use_public;
GRANT ALL ON FUNCTION public.canonical_legacy_alias_uuid(p_alias_path text) TO context_use_backup;


--
-- Name: FUNCTION canonical_public_uuid_set(p_values uuid[]); Type: ACL; Schema: public; Owner: context_use_boundary_owner
--

REVOKE ALL ON FUNCTION public.canonical_public_uuid_set(p_values uuid[]) FROM PUBLIC;
GRANT ALL ON FUNCTION public.canonical_public_uuid_set(p_values uuid[]) TO context_use_storage_owner;


--
-- Name: FUNCTION capture_archived_knowledge_document(); Type: ACL; Schema: public; Owner: context_use_document_history_owner
--

REVOKE ALL ON FUNCTION public.capture_archived_knowledge_document() FROM PUBLIC;


--
-- Name: FUNCTION capture_deleted_current_page_version(); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.capture_deleted_current_page_version() FROM PUBLIC;


--
-- Name: FUNCTION capture_inserted_current_page_version(); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.capture_inserted_current_page_version() FROM PUBLIC;


--
-- Name: FUNCTION capture_updated_current_page_version(); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.capture_updated_current_page_version() FROM PUBLIC;


--
-- Name: FUNCTION claim_knowledge_export_download(p_intent_id uuid, p_owner_user_id text, p_session_id text); Type: ACL; Schema: public; Owner: context_use_boundary_owner
--

REVOKE ALL ON FUNCTION public.claim_knowledge_export_download(p_intent_id uuid, p_owner_user_id text, p_session_id text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.claim_knowledge_export_download(p_intent_id uuid, p_owner_user_id text, p_session_id text) TO context_use_confirmation;


--
-- Name: FUNCTION claim_publication_artifact(p_intent_id uuid, p_claim_token uuid); Type: ACL; Schema: public; Owner: context_use_storage_owner
--

REVOKE ALL ON FUNCTION public.claim_publication_artifact(p_intent_id uuid, p_claim_token uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.claim_publication_artifact(p_intent_id uuid, p_claim_token uuid) TO context_use_storage;


--
-- Name: FUNCTION complete_hypermedia_bootstrap(); Type: ACL; Schema: public; Owner: context_use_boundary_owner
--

REVOKE ALL ON FUNCTION public.complete_hypermedia_bootstrap() FROM PUBLIC;
GRANT ALL ON FUNCTION public.complete_hypermedia_bootstrap() TO context_use_corpus;


--
-- Name: FUNCTION confirm_knowledge_export_intent(p_intent_id uuid, p_owner_user_id text, p_session_id text, p_credential_id text, p_expected_counter integer, p_new_counter integer); Type: ACL; Schema: public; Owner: context_use_boundary_owner
--

REVOKE ALL ON FUNCTION public.confirm_knowledge_export_intent(p_intent_id uuid, p_owner_user_id text, p_session_id text, p_credential_id text, p_expected_counter integer, p_new_counter integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.confirm_knowledge_export_intent(p_intent_id uuid, p_owner_user_id text, p_session_id text, p_credential_id text, p_expected_counter integer, p_new_counter integer) TO context_use_confirmation;


--
-- Name: FUNCTION confirm_page_deletion_intent(p_intent_id uuid, p_owner_user_id text, p_session_id text, p_credential_id text, p_expected_counter integer, p_new_counter integer); Type: ACL; Schema: public; Owner: context_use_boundary_owner
--

REVOKE ALL ON FUNCTION public.confirm_page_deletion_intent(p_intent_id uuid, p_owner_user_id text, p_session_id text, p_credential_id text, p_expected_counter integer, p_new_counter integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.confirm_page_deletion_intent(p_intent_id uuid, p_owner_user_id text, p_session_id text, p_credential_id text, p_expected_counter integer, p_new_counter integer) TO context_use_confirmation;


--
-- Name: FUNCTION confirm_publication_intent(p_intent_id uuid, p_owner_user_id text, p_session_id text, p_credential_id text, p_expected_counter integer, p_new_counter integer); Type: ACL; Schema: public; Owner: context_use_boundary_owner
--

REVOKE ALL ON FUNCTION public.confirm_publication_intent(p_intent_id uuid, p_owner_user_id text, p_session_id text, p_credential_id text, p_expected_counter integer, p_new_counter integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.confirm_publication_intent(p_intent_id uuid, p_owner_user_id text, p_session_id text, p_credential_id text, p_expected_counter integer, p_new_counter integer) TO context_use_confirmation;


--
-- Name: FUNCTION consume_confirmation_challenge(p_intent_kind public.confirmation_intent_kind, p_intent_id uuid, p_challenge text, p_owner_user_id text, p_credential_id text, p_expected_counter integer, p_new_counter integer); Type: ACL; Schema: public; Owner: context_use_boundary_owner
--

REVOKE ALL ON FUNCTION public.consume_confirmation_challenge(p_intent_kind public.confirmation_intent_kind, p_intent_id uuid, p_challenge text, p_owner_user_id text, p_credential_id text, p_expected_counter integer, p_new_counter integer) FROM PUBLIC;


--
-- Name: FUNCTION defer_document_link_index(p_source_revision_id uuid); Type: ACL; Schema: public; Owner: context_use_boundary_owner
--

REVOKE ALL ON FUNCTION public.defer_document_link_index(p_source_revision_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.defer_document_link_index(p_source_revision_id uuid) TO context_use_storage;


--
-- Name: FUNCTION document_search_vector(p_title text, p_summary text, p_body_markdown text); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.document_search_vector(p_title text, p_summary text, p_body_markdown text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.document_search_vector(p_title text, p_summary text, p_body_markdown text) TO context_use_projection_owner;
GRANT ALL ON FUNCTION public.document_search_vector(p_title text, p_summary text, p_body_markdown text) TO context_use_boundary_owner;


--
-- Name: FUNCTION finalize_publication_artifact_claim(p_claim_token uuid, p_intent_id uuid, p_target_kind public.publication_target, p_body_size_bytes bigint, p_body_content_hash text, p_public_title text, p_public_summary text, p_public_last_edited_at timestamp with time zone, p_public_filename text, p_public_content_type text, p_public_width integer, p_public_height integer, p_public_duration_seconds text, p_projected_target_public_ids uuid[], p_observed_public_uuid_tokens uuid[], p_projection_receipt_hash text); Type: ACL; Schema: public; Owner: context_use_storage_owner
--

REVOKE ALL ON FUNCTION public.finalize_publication_artifact_claim(p_claim_token uuid, p_intent_id uuid, p_target_kind public.publication_target, p_body_size_bytes bigint, p_body_content_hash text, p_public_title text, p_public_summary text, p_public_last_edited_at timestamp with time zone, p_public_filename text, p_public_content_type text, p_public_width integer, p_public_height integer, p_public_duration_seconds text, p_projected_target_public_ids uuid[], p_observed_public_uuid_tokens uuid[], p_projection_receipt_hash text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.finalize_publication_artifact_claim(p_claim_token uuid, p_intent_id uuid, p_target_kind public.publication_target, p_body_size_bytes bigint, p_body_content_hash text, p_public_title text, p_public_summary text, p_public_last_edited_at timestamp with time zone, p_public_filename text, p_public_content_type text, p_public_width integer, p_public_height integer, p_public_duration_seconds text, p_projected_target_public_ids uuid[], p_observed_public_uuid_tokens uuid[], p_projection_receipt_hash text) TO context_use_storage;


--
-- Name: FUNCTION get_dashboard_publication_status(p_target_kind public.publication_target, p_target_document_id uuid); Type: ACL; Schema: public; Owner: context_use_boundary_owner
--

REVOKE ALL ON FUNCTION public.get_dashboard_publication_status(p_target_kind public.publication_target, p_target_document_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.get_dashboard_publication_status(p_target_kind public.publication_target, p_target_document_id uuid) TO context_use_dashboard;


--
-- Name: FUNCTION get_publication_entrypoint(); Type: ACL; Schema: public; Owner: context_use_boundary_owner
--

REVOKE ALL ON FUNCTION public.get_publication_entrypoint() FROM PUBLIC;
GRANT ALL ON FUNCTION public.get_publication_entrypoint() TO context_use_dashboard;


--
-- Name: FUNCTION get_publication_write_target(p_intent_id uuid); Type: ACL; Schema: public; Owner: context_use_storage_owner
--

REVOKE ALL ON FUNCTION public.get_publication_write_target(p_intent_id uuid) FROM PUBLIC;


--
-- Name: FUNCTION guard_artifact_reservation_namespace(); Type: ACL; Schema: public; Owner: context_use_boundary_owner
--

REVOKE ALL ON FUNCTION public.guard_artifact_reservation_namespace() FROM PUBLIC;


--
-- Name: FUNCTION guard_hypermedia_bootstrap_allocations(); Type: ACL; Schema: public; Owner: context_use_boundary_owner
--

REVOKE ALL ON FUNCTION public.guard_hypermedia_bootstrap_allocations() FROM PUBLIC;


--
-- Name: FUNCTION guard_legacy_alias_namespace(); Type: ACL; Schema: public; Owner: context_use_boundary_owner
--

REVOKE ALL ON FUNCTION public.guard_legacy_alias_namespace() FROM PUBLIC;


--
-- Name: FUNCTION guard_private_uuid_columns(); Type: ACL; Schema: public; Owner: context_use_boundary_owner
--

REVOKE ALL ON FUNCTION public.guard_private_uuid_columns() FROM PUBLIC;


--
-- Name: FUNCTION guard_public_artifact_history(); Type: ACL; Schema: public; Owner: context_use_boundary_owner
--

REVOKE ALL ON FUNCTION public.guard_public_artifact_history() FROM PUBLIC;


--
-- Name: FUNCTION guard_public_representation_token_reservation(); Type: ACL; Schema: public; Owner: context_use_boundary_owner
--

REVOKE ALL ON FUNCTION public.guard_public_representation_token_reservation() FROM PUBLIC;


--
-- Name: FUNCTION guard_public_resource_identity(); Type: ACL; Schema: public; Owner: context_use_boundary_owner
--

REVOKE ALL ON FUNCTION public.guard_public_resource_identity() FROM PUBLIC;


--
-- Name: FUNCTION guard_publication_intent_history(); Type: ACL; Schema: public; Owner: context_use_boundary_owner
--

REVOKE ALL ON FUNCTION public.guard_publication_intent_history() FROM PUBLIC;


--
-- Name: FUNCTION guard_publication_intent_id_reservation(); Type: ACL; Schema: public; Owner: context_use_boundary_owner
--

REVOKE ALL ON FUNCTION public.guard_publication_intent_id_reservation() FROM PUBLIC;


--
-- Name: FUNCTION guard_publication_object_claim_history(); Type: ACL; Schema: public; Owner: context_use_boundary_owner
--

REVOKE ALL ON FUNCTION public.guard_publication_object_claim_history() FROM PUBLIC;


--
-- Name: FUNCTION guard_publication_staging_history(); Type: ACL; Schema: public; Owner: context_use_boundary_owner
--

REVOKE ALL ON FUNCTION public.guard_publication_staging_history() FROM PUBLIC;


--
-- Name: FUNCTION initialize_public_visibility_generation(); Type: ACL; Schema: public; Owner: context_use_boundary_owner
--

REVOKE ALL ON FUNCTION public.initialize_public_visibility_generation() FROM PUBLIC;


--
-- Name: FUNCTION issue_confirmation_challenge(p_intent_kind public.confirmation_intent_kind, p_intent_id uuid, p_challenge text); Type: ACL; Schema: public; Owner: context_use_boundary_owner
--

REVOKE ALL ON FUNCTION public.issue_confirmation_challenge(p_intent_kind public.confirmation_intent_kind, p_intent_id uuid, p_challenge text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.issue_confirmation_challenge(p_intent_kind public.confirmation_intent_kind, p_intent_id uuid, p_challenge text) TO context_use_confirmation;


--
-- Name: FUNCTION keep_asset_document_identity_stable(); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.keep_asset_document_identity_stable() FROM PUBLIC;


--
-- Name: FUNCTION keep_hypermedia_document_identity_stable(); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.keep_hypermedia_document_identity_stable() FROM PUBLIC;


--
-- Name: FUNCTION list_publication_entrypoint_candidates(); Type: ACL; Schema: public; Owner: context_use_boundary_owner
--

REVOKE ALL ON FUNCTION public.list_publication_entrypoint_candidates() FROM PUBLIC;
GRANT ALL ON FUNCTION public.list_publication_entrypoint_candidates() TO context_use_dashboard;


--
-- Name: FUNCTION lock_automation_registry_for_operational_retarget(); Type: ACL; Schema: public; Owner: context_use_boundary_owner
--

REVOKE ALL ON FUNCTION public.lock_automation_registry_for_operational_retarget() FROM PUBLIC;
GRANT ALL ON FUNCTION public.lock_automation_registry_for_operational_retarget() TO context_use_corpus;


--
-- Name: FUNCTION lock_knowledge_settings_for_page_lifecycle(); Type: ACL; Schema: public; Owner: context_use_boundary_owner
--

REVOKE ALL ON FUNCTION public.lock_knowledge_settings_for_page_lifecycle() FROM PUBLIC;


--
-- Name: FUNCTION lock_operational_document(p_document_id uuid); Type: ACL; Schema: public; Owner: context_use_boundary_owner
--

REVOKE ALL ON FUNCTION public.lock_operational_document(p_document_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.lock_operational_document(p_document_id uuid) TO context_use_dashboard;
GRANT ALL ON FUNCTION public.lock_operational_document(p_document_id uuid) TO context_use_mcp;


--
-- Name: FUNCTION lock_public_routing_apply_tables(); Type: ACL; Schema: public; Owner: context_use_publication_lock_owner
--

REVOKE ALL ON FUNCTION public.lock_public_routing_apply_tables() FROM PUBLIC;
GRANT ALL ON FUNCTION public.lock_public_routing_apply_tables() TO context_use_boundary_owner;


--
-- Name: FUNCTION lock_public_routing_audit_tables(); Type: ACL; Schema: public; Owner: context_use_publication_lock_owner
--

REVOKE ALL ON FUNCTION public.lock_public_routing_audit_tables() FROM PUBLIC;
GRANT ALL ON FUNCTION public.lock_public_routing_audit_tables() TO context_use_boundary_owner;


--
-- Name: FUNCTION lock_public_uuid_namespace(p_uuid uuid); Type: ACL; Schema: public; Owner: context_use_boundary_owner
--

REVOKE ALL ON FUNCTION public.lock_public_uuid_namespace(p_uuid uuid) FROM PUBLIC;


--
-- Name: FUNCTION lock_publication_context(p_target_kind public.publication_target, p_target_document_id uuid, p_expected_revision_id uuid); Type: ACL; Schema: public; Owner: context_use_boundary_owner
--

REVOKE ALL ON FUNCTION public.lock_publication_context(p_target_kind public.publication_target, p_target_document_id uuid, p_expected_revision_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.lock_publication_context(p_target_kind public.publication_target, p_target_document_id uuid, p_expected_revision_id uuid) TO context_use_storage_owner;


--
-- Name: FUNCTION prevent_automation_document_role_reuse(); Type: ACL; Schema: public; Owner: context_use_boundary_owner
--

REVOKE ALL ON FUNCTION public.prevent_automation_document_role_reuse() FROM PUBLIC;


--
-- Name: FUNCTION prevent_operational_publication_intent(); Type: ACL; Schema: public; Owner: context_use_boundary_owner
--

REVOKE ALL ON FUNCTION public.prevent_operational_publication_intent() FROM PUBLIC;


--
-- Name: FUNCTION protect_active_asset_publication(); Type: ACL; Schema: public; Owner: context_use_boundary_owner
--

REVOKE ALL ON FUNCTION public.protect_active_asset_publication() FROM PUBLIC;


--
-- Name: FUNCTION protect_active_page_publication(); Type: ACL; Schema: public; Owner: context_use_boundary_owner
--

REVOKE ALL ON FUNCTION public.protect_active_page_publication() FROM PUBLIC;


--
-- Name: FUNCTION protect_configured_global_knowledge_guide(); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.protect_configured_global_knowledge_guide() FROM PUBLIC;


--
-- Name: FUNCTION protect_registered_automation_documents(); Type: ACL; Schema: public; Owner: context_use_boundary_owner
--

REVOKE ALL ON FUNCTION public.protect_registered_automation_documents() FROM PUBLIC;


--
-- Name: FUNCTION prune_page_versions(p_page_id uuid); Type: ACL; Schema: public; Owner: context_use_boundary_owner
--

REVOKE ALL ON FUNCTION public.prune_page_versions(p_page_id uuid) FROM PUBLIC;


--
-- Name: FUNCTION public_duration_is_safe(p_value numeric); Type: ACL; Schema: public; Owner: context_use_boundary_owner
--

REVOKE ALL ON FUNCTION public.public_duration_is_safe(p_value numeric) FROM PUBLIC;


--
-- Name: FUNCTION public_metadata_is_safe(p_value text); Type: ACL; Schema: public; Owner: context_use_boundary_owner
--

REVOKE ALL ON FUNCTION public.public_metadata_is_safe(p_value text) FROM PUBLIC;


--
-- Name: FUNCTION public_route_kind(p_route text); Type: ACL; Schema: public; Owner: context_use_projection_owner
--

REVOKE ALL ON FUNCTION public.public_route_kind(p_route text) FROM PUBLIC;


--
-- Name: FUNCTION public_uuid_has_artifact_identity(p_uuid uuid); Type: ACL; Schema: public; Owner: context_use_boundary_owner
--

REVOKE ALL ON FUNCTION public.public_uuid_has_artifact_identity(p_uuid uuid) FROM PUBLIC;


--
-- Name: FUNCTION public_uuid_has_legacy_alias_token(p_uuid uuid); Type: ACL; Schema: public; Owner: context_use_boundary_owner
--

REVOKE ALL ON FUNCTION public.public_uuid_has_legacy_alias_token(p_uuid uuid) FROM PUBLIC;


--
-- Name: FUNCTION public_uuid_has_private_identity(p_uuid uuid); Type: ACL; Schema: public; Owner: context_use_boundary_owner
--

REVOKE ALL ON FUNCTION public.public_uuid_has_private_identity(p_uuid uuid) FROM PUBLIC;


--
-- Name: FUNCTION public_uuid_has_reserved_public_identity(p_uuid uuid); Type: ACL; Schema: public; Owner: context_use_boundary_owner
--

REVOKE ALL ON FUNCTION public.public_uuid_has_reserved_public_identity(p_uuid uuid) FROM PUBLIC;


--
-- Name: FUNCTION publication_projected_target_ids(p_target_document_id uuid, p_expected_revision_id uuid, p_candidate_public_id uuid); Type: ACL; Schema: public; Owner: context_use_boundary_owner
--

REVOKE ALL ON FUNCTION public.publication_projected_target_ids(p_target_document_id uuid, p_expected_revision_id uuid, p_candidate_public_id uuid) FROM PUBLIC;


--
-- Name: FUNCTION publication_projection_has_namespace_conflict(p_target_document_id uuid, p_expected_revision_id uuid, p_candidate_public_id uuid); Type: ACL; Schema: public; Owner: context_use_boundary_owner
--

REVOKE ALL ON FUNCTION public.publication_projection_has_namespace_conflict(p_target_document_id uuid, p_expected_revision_id uuid, p_candidate_public_id uuid) FROM PUBLIC;


--
-- Name: FUNCTION publication_projection_plan(p_target_document_id uuid, p_expected_revision_id uuid, p_candidate_public_id uuid); Type: ACL; Schema: public; Owner: context_use_boundary_owner
--

REVOKE ALL ON FUNCTION public.publication_projection_plan(p_target_document_id uuid, p_expected_revision_id uuid, p_candidate_public_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.publication_projection_plan(p_target_document_id uuid, p_expected_revision_id uuid, p_candidate_public_id uuid) TO context_use_storage_owner;


--
-- Name: FUNCTION publication_projection_receipt_hash(p_target_document_id uuid, p_expected_revision_id uuid, p_candidate_public_id uuid, p_source_fingerprint text); Type: ACL; Schema: public; Owner: context_use_boundary_owner
--

REVOKE ALL ON FUNCTION public.publication_projection_receipt_hash(p_target_document_id uuid, p_expected_revision_id uuid, p_candidate_public_id uuid, p_source_fingerprint text) FROM PUBLIC;


--
-- Name: FUNCTION publication_representation_token(p_frozen_tuple jsonb); Type: ACL; Schema: public; Owner: context_use_boundary_owner
--

REVOKE ALL ON FUNCTION public.publication_representation_token(p_frozen_tuple jsonb) FROM PUBLIC;


--
-- Name: FUNCTION publication_source_fingerprint(p_target_kind public.publication_target, p_target_document_id uuid, p_expected_revision_id uuid); Type: ACL; Schema: public; Owner: context_use_storage_owner
--

REVOKE ALL ON FUNCTION public.publication_source_fingerprint(p_target_kind public.publication_target, p_target_document_id uuid, p_expected_revision_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.publication_source_fingerprint(p_target_kind public.publication_target, p_target_document_id uuid, p_expected_revision_id uuid) TO context_use_boundary_owner;


--
-- Name: FUNCTION publication_target_is_operational(p_document_id uuid); Type: ACL; Schema: public; Owner: context_use_boundary_owner
--

REVOKE ALL ON FUNCTION public.publication_target_is_operational(p_document_id uuid) FROM PUBLIC;


--
-- Name: FUNCTION publication_visibility_state_hash(p_target_kind public.publication_target, p_target_document_id uuid, p_public_id uuid); Type: ACL; Schema: public; Owner: context_use_boundary_owner
--

REVOKE ALL ON FUNCTION public.publication_visibility_state_hash(p_target_kind public.publication_target, p_target_document_id uuid, p_public_id uuid) FROM PUBLIC;


--
-- Name: FUNCTION record_generic_knowledge_revision(p_expected_document_id uuid, p_revision_id uuid, p_body_markdown text, p_target_document_ids uuid[], p_provenance public.knowledge_revision_contract_provenance); Type: ACL; Schema: public; Owner: context_use_boundary_owner
--

REVOKE ALL ON FUNCTION public.record_generic_knowledge_revision(p_expected_document_id uuid, p_revision_id uuid, p_body_markdown text, p_target_document_ids uuid[], p_provenance public.knowledge_revision_contract_provenance) FROM PUBLIC;


--
-- Name: FUNCTION register_asset_document_identity(); Type: ACL; Schema: public; Owner: context_use_boundary_owner
--

REVOKE ALL ON FUNCTION public.register_asset_document_identity() FROM PUBLIC;


--
-- Name: FUNCTION register_generic_knowledge_revision(p_revision_id uuid, p_body_markdown text, p_target_document_ids uuid[]); Type: ACL; Schema: public; Owner: context_use_boundary_owner
--

REVOKE ALL ON FUNCTION public.register_generic_knowledge_revision(p_revision_id uuid, p_body_markdown text, p_target_document_ids uuid[]) FROM PUBLIC;
GRANT ALL ON FUNCTION public.register_generic_knowledge_revision(p_revision_id uuid, p_body_markdown text, p_target_document_ids uuid[]) TO context_use_dashboard;
GRANT ALL ON FUNCTION public.register_generic_knowledge_revision(p_revision_id uuid, p_body_markdown text, p_target_document_ids uuid[]) TO context_use_mcp;


--
-- Name: FUNCTION register_knowledge_document_metadata(); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.register_knowledge_document_metadata() FROM PUBLIC;


--
-- Name: FUNCTION reject_pending_publication_claim_challenge(); Type: ACL; Schema: public; Owner: context_use_boundary_owner
--

REVOKE ALL ON FUNCTION public.reject_pending_publication_claim_challenge() FROM PUBLIC;


--
-- Name: FUNCTION remove_deleted_asset_document_identity(); Type: ACL; Schema: public; Owner: context_use_boundary_owner
--

REVOKE ALL ON FUNCTION public.remove_deleted_asset_document_identity() FROM PUBLIC;


--
-- Name: FUNCTION remove_deleted_knowledge_document_metadata(); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.remove_deleted_knowledge_document_metadata() FROM PUBLIC;


--
-- Name: FUNCTION remove_deleted_knowledge_revision_metadata(); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.remove_deleted_knowledge_revision_metadata() FROM PUBLIC;


--
-- Name: FUNCTION remove_owner_passkey(p_owner_user_id text, p_passkey_id text); Type: ACL; Schema: public; Owner: context_use_boundary_owner
--

REVOKE ALL ON FUNCTION public.remove_owner_passkey(p_owner_user_id text, p_passkey_id text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.remove_owner_passkey(p_owner_user_id text, p_passkey_id text) TO context_use_auth;


--
-- Name: FUNCTION remove_truncated_asset_document_identities(); Type: ACL; Schema: public; Owner: context_use_boundary_owner
--

REVOKE ALL ON FUNCTION public.remove_truncated_asset_document_identities() FROM PUBLIC;


--
-- Name: FUNCTION replace_document_links(p_source_revision_id uuid, p_target_document_ids uuid[]); Type: ACL; Schema: public; Owner: context_use_boundary_owner
--

REVOKE ALL ON FUNCTION public.replace_document_links(p_source_revision_id uuid, p_target_document_ids uuid[]) FROM PUBLIC;
GRANT ALL ON FUNCTION public.replace_document_links(p_source_revision_id uuid, p_target_document_ids uuid[]) TO context_use_dashboard;
GRANT ALL ON FUNCTION public.replace_document_links(p_source_revision_id uuid, p_target_document_ids uuid[]) TO context_use_mcp;
GRANT ALL ON FUNCTION public.replace_document_links(p_source_revision_id uuid, p_target_document_ids uuid[]) TO context_use_storage;


--
-- Name: FUNCTION replace_knowledge_document_identity_metadata(); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.replace_knowledge_document_identity_metadata() FROM PUBLIC;


--
-- Name: FUNCTION replace_knowledge_revision_projections(p_source_revision_id uuid, p_target_document_ids uuid[]); Type: ACL; Schema: public; Owner: context_use_boundary_owner
--

REVOKE ALL ON FUNCTION public.replace_knowledge_revision_projections(p_source_revision_id uuid, p_target_document_ids uuid[]) FROM PUBLIC;
GRANT ALL ON FUNCTION public.replace_knowledge_revision_projections(p_source_revision_id uuid, p_target_document_ids uuid[]) TO context_use_corpus;


--
-- Name: FUNCTION replace_source_record_search_chunks(p_document_id uuid, p_chunks text[]); Type: ACL; Schema: public; Owner: context_use_boundary_owner
--

REVOKE ALL ON FUNCTION public.replace_source_record_search_chunks(p_document_id uuid, p_chunks text[]) FROM PUBLIC;
GRANT ALL ON FUNCTION public.replace_source_record_search_chunks(p_document_id uuid, p_chunks text[]) TO context_use_mcp;


--
-- Name: FUNCTION require_finalized_publication_object_claim(); Type: ACL; Schema: public; Owner: context_use_boundary_owner
--

REVOKE ALL ON FUNCTION public.require_finalized_publication_object_claim() FROM PUBLIC;


--
-- Name: FUNCTION reserve_public_artifact_identity(p_artifact_id uuid, p_body_object_key text, p_allocation_kind public.public_artifact_allocation_kind, p_allocation_id uuid); Type: ACL; Schema: public; Owner: context_use_boundary_owner
--

REVOKE ALL ON FUNCTION public.reserve_public_artifact_identity(p_artifact_id uuid, p_body_object_key text, p_allocation_kind public.public_artifact_allocation_kind, p_allocation_id uuid) FROM PUBLIC;


--
-- Name: FUNCTION reserve_public_representation_token(p_representation_token text, p_artifact_id uuid, p_resource_kind public.publication_target); Type: ACL; Schema: public; Owner: context_use_boundary_owner
--

REVOKE ALL ON FUNCTION public.reserve_public_representation_token(p_representation_token text, p_artifact_id uuid, p_resource_kind public.publication_target) FROM PUBLIC;


--
-- Name: FUNCTION reserve_publication_intent_id(p_intent_id uuid); Type: ACL; Schema: public; Owner: context_use_boundary_owner
--

REVOKE ALL ON FUNCTION public.reserve_publication_intent_id(p_intent_id uuid) FROM PUBLIC;


--
-- Name: FUNCTION reserve_publication_intent_id_from_row(); Type: ACL; Schema: public; Owner: context_use_boundary_owner
--

REVOKE ALL ON FUNCTION public.reserve_publication_intent_id_from_row() FROM PUBLIC;


--
-- Name: FUNCTION reserve_retained_page_artifact_identity(); Type: ACL; Schema: public; Owner: context_use_boundary_owner
--

REVOKE ALL ON FUNCTION public.reserve_retained_page_artifact_identity() FROM PUBLIC;


--
-- Name: FUNCTION resolve_public_route(p_route text); Type: ACL; Schema: public; Owner: context_use_projection_owner
--

REVOKE ALL ON FUNCTION public.resolve_public_route(p_route text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.resolve_public_route(p_route text) TO context_use_public;


--
-- Name: FUNCTION resolve_storage_route(p_representation_token text); Type: ACL; Schema: public; Owner: context_use_storage_owner
--

REVOKE ALL ON FUNCTION public.resolve_storage_route(p_representation_token text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.resolve_storage_route(p_representation_token text) TO context_use_storage;


--
-- Name: FUNCTION search_private_document_catalog(p_query text, p_after_rank real, p_after_updated_at_epoch_micros bigint, p_after_document_id uuid, p_include_retired boolean, p_limit integer, p_authority public.hypermedia_document_authority, p_representation public.hypermedia_document_representation, p_document_kind public.private_document_kind, p_lifecycle public.private_document_lifecycle, p_integration text, p_operational_role public.private_document_operational_role); Type: ACL; Schema: public; Owner: context_use_projection_owner
--

REVOKE ALL ON FUNCTION public.search_private_document_catalog(p_query text, p_after_rank real, p_after_updated_at_epoch_micros bigint, p_after_document_id uuid, p_include_retired boolean, p_limit integer, p_authority public.hypermedia_document_authority, p_representation public.hypermedia_document_representation, p_document_kind public.private_document_kind, p_lifecycle public.private_document_lifecycle, p_integration text, p_operational_role public.private_document_operational_role) FROM PUBLIC;
GRANT ALL ON FUNCTION public.search_private_document_catalog(p_query text, p_after_rank real, p_after_updated_at_epoch_micros bigint, p_after_document_id uuid, p_include_retired boolean, p_limit integer, p_authority public.hypermedia_document_authority, p_representation public.hypermedia_document_representation, p_document_kind public.private_document_kind, p_lifecycle public.private_document_lifecycle, p_integration text, p_operational_role public.private_document_operational_role) TO context_use_dashboard;
GRANT ALL ON FUNCTION public.search_private_document_catalog(p_query text, p_after_rank real, p_after_updated_at_epoch_micros bigint, p_after_document_id uuid, p_include_retired boolean, p_limit integer, p_authority public.hypermedia_document_authority, p_representation public.hypermedia_document_representation, p_document_kind public.private_document_kind, p_lifecycle public.private_document_lifecycle, p_integration text, p_operational_role public.private_document_operational_role) TO context_use_mcp;


--
-- Name: FUNCTION set_publication_entrypoint(p_public_id uuid); Type: ACL; Schema: public; Owner: context_use_boundary_owner
--

REVOKE ALL ON FUNCTION public.set_publication_entrypoint(p_public_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.set_publication_entrypoint(p_public_id uuid) TO context_use_dashboard;


--
-- Name: FUNCTION stage_publication_artifact(p_intent_id uuid, p_target_kind public.publication_target, p_body_size_bytes bigint, p_body_content_hash text, p_public_title text, p_public_summary text, p_public_last_edited_at timestamp with time zone, p_public_filename text, p_public_content_type text, p_public_width integer, p_public_height integer, p_public_duration_seconds text, p_projected_target_public_ids uuid[], p_observed_public_uuid_tokens uuid[], p_projection_receipt_hash text); Type: ACL; Schema: public; Owner: context_use_boundary_owner
--

REVOKE ALL ON FUNCTION public.stage_publication_artifact(p_intent_id uuid, p_target_kind public.publication_target, p_body_size_bytes bigint, p_body_content_hash text, p_public_title text, p_public_summary text, p_public_last_edited_at timestamp with time zone, p_public_filename text, p_public_content_type text, p_public_width integer, p_public_height integer, p_public_duration_seconds text, p_projected_target_public_ids uuid[], p_observed_public_uuid_tokens uuid[], p_projection_receipt_hash text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.stage_publication_artifact(p_intent_id uuid, p_target_kind public.publication_target, p_body_size_bytes bigint, p_body_content_hash text, p_public_title text, p_public_summary text, p_public_last_edited_at timestamp with time zone, p_public_filename text, p_public_content_type text, p_public_width integer, p_public_height integer, p_public_duration_seconds text, p_projected_target_public_ids uuid[], p_observed_public_uuid_tokens uuid[], p_projection_receipt_hash text) TO context_use_storage_owner;


--
-- Name: FUNCTION validate_active_publication_pin(); Type: ACL; Schema: public; Owner: context_use_boundary_owner
--

REVOKE ALL ON FUNCTION public.validate_active_publication_pin() FROM PUBLIC;


--
-- Name: FUNCTION validate_automation_registry_documents(); Type: ACL; Schema: public; Owner: context_use_boundary_owner
--

REVOKE ALL ON FUNCTION public.validate_automation_registry_documents() FROM PUBLIC;


--
-- Name: FUNCTION validate_global_knowledge_guide(); Type: ACL; Schema: public; Owner: context_use_boundary_owner
--

REVOKE ALL ON FUNCTION public.validate_global_knowledge_guide() FROM PUBLIC;


--
-- Name: FUNCTION validate_knowledge_page_document_identity(); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.validate_knowledge_page_document_identity() FROM PUBLIC;


--
-- Name: FUNCTION validate_markdown_document_revision(); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.validate_markdown_document_revision() FROM PUBLIC;


--
-- Name: FUNCTION validate_public_resource_mapping(); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.validate_public_resource_mapping() FROM PUBLIC;


--
-- Name: FUNCTION validate_source_record_document_identity(); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.validate_source_record_document_identity() FROM PUBLIC;


--
-- Name: TABLE account; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.account TO context_use_auth;
GRANT SELECT ON TABLE public.account TO context_use_backup;


--
-- Name: TABLE asset_publications; Type: ACL; Schema: public; Owner: postgres
--

GRANT DELETE ON TABLE public.asset_publications TO context_use_boundary_owner;
GRANT SELECT ON TABLE public.asset_publications TO context_use_backup;


--
-- Name: COLUMN asset_publications.public_id; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(public_id),INSERT(public_id),UPDATE(public_id) ON TABLE public.asset_publications TO context_use_boundary_owner;
GRANT SELECT(public_id) ON TABLE public.asset_publications TO context_use_projection_owner;
GRANT SELECT(public_id) ON TABLE public.asset_publications TO context_use_storage_owner;


--
-- Name: COLUMN asset_publications.artifact_id; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(artifact_id),INSERT(artifact_id) ON TABLE public.asset_publications TO context_use_boundary_owner;
GRANT SELECT(artifact_id) ON TABLE public.asset_publications TO context_use_projection_owner;
GRANT SELECT(artifact_id) ON TABLE public.asset_publications TO context_use_storage_owner;


--
-- Name: TABLE assets; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT ON TABLE public.assets TO context_use_dashboard;
GRANT SELECT ON TABLE public.assets TO context_use_mcp;
GRANT SELECT ON TABLE public.assets TO context_use_backup;
GRANT UPDATE ON TABLE public.assets TO context_use_boundary_owner;


--
-- Name: COLUMN assets.id; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(id) ON TABLE public.assets TO context_use_projection_owner;
GRANT SELECT(id) ON TABLE public.assets TO context_use_boundary_owner;
GRANT INSERT(id) ON TABLE public.assets TO context_use_dashboard;
GRANT INSERT(id) ON TABLE public.assets TO context_use_mcp;
GRANT SELECT(id) ON TABLE public.assets TO context_use_storage;
GRANT SELECT(id) ON TABLE public.assets TO context_use_storage_owner;


--
-- Name: COLUMN assets.filename; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(filename) ON TABLE public.assets TO context_use_projection_owner;
GRANT INSERT(filename) ON TABLE public.assets TO context_use_dashboard;
GRANT INSERT(filename) ON TABLE public.assets TO context_use_mcp;
GRANT SELECT(filename) ON TABLE public.assets TO context_use_storage;
GRANT SELECT(filename) ON TABLE public.assets TO context_use_boundary_owner;
GRANT SELECT(filename) ON TABLE public.assets TO context_use_storage_owner;


--
-- Name: COLUMN assets.content_type; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(content_type) ON TABLE public.assets TO context_use_projection_owner;
GRANT INSERT(content_type) ON TABLE public.assets TO context_use_dashboard;
GRANT INSERT(content_type) ON TABLE public.assets TO context_use_mcp;
GRANT SELECT(content_type) ON TABLE public.assets TO context_use_storage;
GRANT SELECT(content_type) ON TABLE public.assets TO context_use_boundary_owner;
GRANT SELECT(content_type) ON TABLE public.assets TO context_use_storage_owner;


--
-- Name: COLUMN assets.size_bytes; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(size_bytes) ON TABLE public.assets TO context_use_projection_owner;
GRANT INSERT(size_bytes) ON TABLE public.assets TO context_use_dashboard;
GRANT INSERT(size_bytes) ON TABLE public.assets TO context_use_mcp;
GRANT SELECT(size_bytes) ON TABLE public.assets TO context_use_storage;
GRANT SELECT(size_bytes) ON TABLE public.assets TO context_use_boundary_owner;
GRANT SELECT(size_bytes) ON TABLE public.assets TO context_use_storage_owner;


--
-- Name: COLUMN assets.content_hash; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(content_hash) ON TABLE public.assets TO context_use_projection_owner;
GRANT INSERT(content_hash) ON TABLE public.assets TO context_use_dashboard;
GRANT INSERT(content_hash) ON TABLE public.assets TO context_use_mcp;
GRANT SELECT(content_hash) ON TABLE public.assets TO context_use_storage;
GRANT SELECT(content_hash) ON TABLE public.assets TO context_use_boundary_owner;
GRANT SELECT(content_hash) ON TABLE public.assets TO context_use_storage_owner;


--
-- Name: COLUMN assets.s3_object_key; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(s3_object_key) ON TABLE public.assets TO context_use_projection_owner;
GRANT INSERT(s3_object_key) ON TABLE public.assets TO context_use_dashboard;
GRANT INSERT(s3_object_key) ON TABLE public.assets TO context_use_mcp;
GRANT SELECT(s3_object_key) ON TABLE public.assets TO context_use_storage;
GRANT SELECT(s3_object_key) ON TABLE public.assets TO context_use_storage_owner;


--
-- Name: COLUMN assets.width; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(width) ON TABLE public.assets TO context_use_projection_owner;
GRANT INSERT(width) ON TABLE public.assets TO context_use_dashboard;
GRANT INSERT(width) ON TABLE public.assets TO context_use_mcp;
GRANT SELECT(width) ON TABLE public.assets TO context_use_boundary_owner;
GRANT SELECT(width) ON TABLE public.assets TO context_use_storage_owner;


--
-- Name: COLUMN assets.height; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(height) ON TABLE public.assets TO context_use_projection_owner;
GRANT INSERT(height) ON TABLE public.assets TO context_use_dashboard;
GRANT INSERT(height) ON TABLE public.assets TO context_use_mcp;
GRANT SELECT(height) ON TABLE public.assets TO context_use_boundary_owner;
GRANT SELECT(height) ON TABLE public.assets TO context_use_storage_owner;


--
-- Name: COLUMN assets.duration_seconds; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(duration_seconds) ON TABLE public.assets TO context_use_projection_owner;
GRANT INSERT(duration_seconds) ON TABLE public.assets TO context_use_dashboard;
GRANT INSERT(duration_seconds) ON TABLE public.assets TO context_use_mcp;
GRANT SELECT(duration_seconds) ON TABLE public.assets TO context_use_boundary_owner;
GRANT SELECT(duration_seconds) ON TABLE public.assets TO context_use_storage_owner;


--
-- Name: COLUMN assets.created_at; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(created_at) ON TABLE public.assets TO context_use_boundary_owner;
GRANT SELECT(created_at) ON TABLE public.assets TO context_use_storage_owner;


--
-- Name: COLUMN assets.deleted_at; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(deleted_at) ON TABLE public.assets TO context_use_projection_owner;
GRANT SELECT(deleted_at) ON TABLE public.assets TO context_use_boundary_owner;
GRANT UPDATE(deleted_at) ON TABLE public.assets TO context_use_dashboard;
GRANT SELECT(deleted_at) ON TABLE public.assets TO context_use_storage;
GRANT UPDATE(deleted_at) ON TABLE public.assets TO context_use_mcp;
GRANT SELECT(deleted_at) ON TABLE public.assets TO context_use_storage_owner;


--
-- Name: TABLE automation_registry; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.automation_registry TO context_use_boundary_owner;
GRANT SELECT,INSERT ON TABLE public.automation_registry TO context_use_dashboard;
GRANT SELECT ON TABLE public.automation_registry TO context_use_backup;


--
-- Name: COLUMN automation_registry.name; Type: ACL; Schema: public; Owner: postgres
--

GRANT UPDATE(name) ON TABLE public.automation_registry TO context_use_dashboard;


--
-- Name: COLUMN automation_registry.instructions_document_id; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(instructions_document_id) ON TABLE public.automation_registry TO context_use_projection_owner;


--
-- Name: COLUMN automation_registry.state_document_id; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(state_document_id) ON TABLE public.automation_registry TO context_use_projection_owner;


--
-- Name: COLUMN automation_registry.updated_at; Type: ACL; Schema: public; Owner: postgres
--

GRANT UPDATE(updated_at) ON TABLE public.automation_registry TO context_use_dashboard;


--
-- Name: COLUMN automation_registry.disabled_at; Type: ACL; Schema: public; Owner: postgres
--

GRANT UPDATE(disabled_at) ON TABLE public.automation_registry TO context_use_dashboard;


--
-- Name: TABLE public_namespace_conflicts; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT ON TABLE public.public_namespace_conflicts TO context_use_backup;


--
-- Name: COLUMN public_namespace_conflicts.conflict_key; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(conflict_key) ON TABLE public.public_namespace_conflicts TO context_use_boundary_owner;
GRANT SELECT(conflict_key) ON TABLE public.public_namespace_conflicts TO context_use_projection_owner;


--
-- Name: COLUMN public_namespace_conflicts.namespace_uuid; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(namespace_uuid) ON TABLE public.public_namespace_conflicts TO context_use_boundary_owner;
GRANT SELECT(namespace_uuid) ON TABLE public.public_namespace_conflicts TO context_use_projection_owner;


--
-- Name: COLUMN public_namespace_conflicts.conflict_kind; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(conflict_kind) ON TABLE public.public_namespace_conflicts TO context_use_boundary_owner;
GRANT SELECT(conflict_kind) ON TABLE public.public_namespace_conflicts TO context_use_projection_owner;


--
-- Name: COLUMN public_namespace_conflicts.public_id; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(public_id) ON TABLE public.public_namespace_conflicts TO context_use_boundary_owner;
GRANT SELECT(public_id) ON TABLE public.public_namespace_conflicts TO context_use_projection_owner;


--
-- Name: COLUMN public_namespace_conflicts.alias_path; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(alias_path) ON TABLE public.public_namespace_conflicts TO context_use_boundary_owner;
GRANT SELECT(alias_path) ON TABLE public.public_namespace_conflicts TO context_use_projection_owner;


--
-- Name: COLUMN public_namespace_conflicts.conflicting_identity_kind; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(conflicting_identity_kind) ON TABLE public.public_namespace_conflicts TO context_use_boundary_owner;
GRANT SELECT(conflicting_identity_kind) ON TABLE public.public_namespace_conflicts TO context_use_projection_owner;


--
-- Name: COLUMN public_namespace_conflicts.conflict_lifecycle; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(conflict_lifecycle) ON TABLE public.public_namespace_conflicts TO context_use_boundary_owner;
GRANT SELECT(conflict_lifecycle) ON TABLE public.public_namespace_conflicts TO context_use_projection_owner;


--
-- Name: COLUMN public_namespace_conflicts.detected_at; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(detected_at) ON TABLE public.public_namespace_conflicts TO context_use_boundary_owner;
GRANT SELECT(detected_at) ON TABLE public.public_namespace_conflicts TO context_use_projection_owner;


--
-- Name: COLUMN public_namespace_conflicts.resolved_at; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(resolved_at),UPDATE(resolved_at) ON TABLE public.public_namespace_conflicts TO context_use_boundary_owner;
GRANT SELECT(resolved_at) ON TABLE public.public_namespace_conflicts TO context_use_projection_owner;


--
-- Name: TABLE blocking_public_namespace_conflicts; Type: ACL; Schema: public; Owner: context_use_projection_owner
--

GRANT SELECT ON TABLE public.blocking_public_namespace_conflicts TO context_use_backup;
GRANT SELECT ON TABLE public.blocking_public_namespace_conflicts TO context_use_boundary_owner;
GRANT SELECT ON TABLE public.blocking_public_namespace_conflicts TO context_use_storage_owner;


--
-- Name: TABLE confirmation_challenges; Type: ACL; Schema: public; Owner: postgres
--

GRANT DELETE ON TABLE public.confirmation_challenges TO context_use_boundary_owner;
GRANT SELECT ON TABLE public.confirmation_challenges TO context_use_backup;


--
-- Name: COLUMN confirmation_challenges.intent_kind; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(intent_kind),INSERT(intent_kind) ON TABLE public.confirmation_challenges TO context_use_boundary_owner;
GRANT SELECT(intent_kind) ON TABLE public.confirmation_challenges TO context_use_confirmation;
GRANT SELECT(intent_kind) ON TABLE public.confirmation_challenges TO context_use_storage_owner;


--
-- Name: COLUMN confirmation_challenges.intent_id; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(intent_id),INSERT(intent_id),UPDATE(intent_id) ON TABLE public.confirmation_challenges TO context_use_boundary_owner;
GRANT SELECT(intent_id) ON TABLE public.confirmation_challenges TO context_use_confirmation;
GRANT SELECT(intent_id) ON TABLE public.confirmation_challenges TO context_use_storage_owner;


--
-- Name: COLUMN confirmation_challenges.challenge; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(challenge),INSERT(challenge) ON TABLE public.confirmation_challenges TO context_use_boundary_owner;
GRANT SELECT(challenge) ON TABLE public.confirmation_challenges TO context_use_confirmation;


--
-- Name: TABLE document_links; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.document_links TO context_use_boundary_owner;
GRANT SELECT ON TABLE public.document_links TO context_use_dashboard;
GRANT SELECT ON TABLE public.document_links TO context_use_mcp;
GRANT SELECT ON TABLE public.document_links TO context_use_backup;


--
-- Name: TABLE hypermedia_bootstrap_allocations; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT,INSERT,UPDATE ON TABLE public.hypermedia_bootstrap_allocations TO context_use_boundary_owner;
GRANT SELECT ON TABLE public.hypermedia_bootstrap_allocations TO context_use_backup;


--
-- Name: COLUMN hypermedia_bootstrap_allocations.document_kind; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(document_kind) ON TABLE public.hypermedia_bootstrap_allocations TO context_use_corpus;


--
-- Name: COLUMN hypermedia_bootstrap_allocations.document_id; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(document_id) ON TABLE public.hypermedia_bootstrap_allocations TO context_use_corpus;


--
-- Name: COLUMN hypermedia_bootstrap_allocations.revision_id; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(revision_id) ON TABLE public.hypermedia_bootstrap_allocations TO context_use_corpus;


--
-- Name: TABLE hypermedia_document_revisions; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT,INSERT ON TABLE public.hypermedia_document_revisions TO context_use_dashboard;
GRANT SELECT,INSERT ON TABLE public.hypermedia_document_revisions TO context_use_mcp;
GRANT SELECT ON TABLE public.hypermedia_document_revisions TO context_use_storage;
GRANT SELECT ON TABLE public.hypermedia_document_revisions TO context_use_backup;
GRANT UPDATE ON TABLE public.hypermedia_document_revisions TO context_use_boundary_owner;


--
-- Name: COLUMN hypermedia_document_revisions.id; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(id) ON TABLE public.hypermedia_document_revisions TO context_use_boundary_owner;
GRANT SELECT(id) ON TABLE public.hypermedia_document_revisions TO context_use_projection_owner;
GRANT SELECT(id) ON TABLE public.hypermedia_document_revisions TO context_use_storage_owner;


--
-- Name: COLUMN hypermedia_document_revisions.document_id; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(document_id) ON TABLE public.hypermedia_document_revisions TO context_use_boundary_owner;
GRANT SELECT(document_id) ON TABLE public.hypermedia_document_revisions TO context_use_projection_owner;
GRANT SELECT(document_id) ON TABLE public.hypermedia_document_revisions TO context_use_storage_owner;


--
-- Name: COLUMN hypermedia_document_revisions.revision_number; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(revision_number) ON TABLE public.hypermedia_document_revisions TO context_use_boundary_owner;
GRANT SELECT(revision_number) ON TABLE public.hypermedia_document_revisions TO context_use_projection_owner;
GRANT SELECT(revision_number) ON TABLE public.hypermedia_document_revisions TO context_use_storage_owner;


--
-- Name: COLUMN hypermedia_document_revisions.body_object_key; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(body_object_key) ON TABLE public.hypermedia_document_revisions TO context_use_boundary_owner;
GRANT SELECT(body_object_key) ON TABLE public.hypermedia_document_revisions TO context_use_storage_owner;


--
-- Name: COLUMN hypermedia_document_revisions.body_size_bytes; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(body_size_bytes) ON TABLE public.hypermedia_document_revisions TO context_use_boundary_owner;
GRANT SELECT(body_size_bytes) ON TABLE public.hypermedia_document_revisions TO context_use_projection_owner;
GRANT SELECT(body_size_bytes) ON TABLE public.hypermedia_document_revisions TO context_use_storage_owner;


--
-- Name: COLUMN hypermedia_document_revisions.body_content_hash; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(body_content_hash) ON TABLE public.hypermedia_document_revisions TO context_use_boundary_owner;
GRANT SELECT(body_content_hash) ON TABLE public.hypermedia_document_revisions TO context_use_projection_owner;
GRANT SELECT(body_content_hash) ON TABLE public.hypermedia_document_revisions TO context_use_storage_owner;


--
-- Name: COLUMN hypermedia_document_revisions.created_at; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(created_at) ON TABLE public.hypermedia_document_revisions TO context_use_boundary_owner;
GRANT SELECT(created_at) ON TABLE public.hypermedia_document_revisions TO context_use_storage_owner;


--
-- Name: COLUMN hypermedia_document_revisions.links_indexed_at; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(links_indexed_at),UPDATE(links_indexed_at) ON TABLE public.hypermedia_document_revisions TO context_use_boundary_owner;
GRANT SELECT(links_indexed_at) ON TABLE public.hypermedia_document_revisions TO context_use_projection_owner;
GRANT SELECT(links_indexed_at) ON TABLE public.hypermedia_document_revisions TO context_use_storage_owner;


--
-- Name: COLUMN hypermedia_document_revisions.links_index_attempted_at; Type: ACL; Schema: public; Owner: postgres
--

GRANT UPDATE(links_index_attempted_at) ON TABLE public.hypermedia_document_revisions TO context_use_boundary_owner;


--
-- Name: TABLE hypermedia_documents; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT,INSERT ON TABLE public.hypermedia_documents TO context_use_dashboard;
GRANT SELECT,INSERT ON TABLE public.hypermedia_documents TO context_use_mcp;
GRANT SELECT ON TABLE public.hypermedia_documents TO context_use_storage;
GRANT SELECT ON TABLE public.hypermedia_documents TO context_use_backup;
GRANT DELETE ON TABLE public.hypermedia_documents TO context_use_boundary_owner;


--
-- Name: COLUMN hypermedia_documents.id; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(id),INSERT(id) ON TABLE public.hypermedia_documents TO context_use_boundary_owner;
GRANT SELECT(id) ON TABLE public.hypermedia_documents TO context_use_projection_owner;
GRANT SELECT(id) ON TABLE public.hypermedia_documents TO context_use_storage_owner;


--
-- Name: COLUMN hypermedia_documents.authority; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(authority),INSERT(authority) ON TABLE public.hypermedia_documents TO context_use_boundary_owner;
GRANT SELECT(authority) ON TABLE public.hypermedia_documents TO context_use_projection_owner;
GRANT SELECT(authority) ON TABLE public.hypermedia_documents TO context_use_storage_owner;


--
-- Name: COLUMN hypermedia_documents.created_at; Type: ACL; Schema: public; Owner: postgres
--

GRANT INSERT(created_at) ON TABLE public.hypermedia_documents TO context_use_boundary_owner;
GRANT SELECT(created_at) ON TABLE public.hypermedia_documents TO context_use_projection_owner;


--
-- Name: COLUMN hypermedia_documents.updated_at; Type: ACL; Schema: public; Owner: postgres
--

GRANT UPDATE(updated_at) ON TABLE public.hypermedia_documents TO context_use_dashboard;
GRANT UPDATE(updated_at) ON TABLE public.hypermedia_documents TO context_use_mcp;
GRANT INSERT(updated_at) ON TABLE public.hypermedia_documents TO context_use_boundary_owner;
GRANT SELECT(updated_at) ON TABLE public.hypermedia_documents TO context_use_projection_owner;


--
-- Name: COLUMN hypermedia_documents.representation; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(representation),INSERT(representation) ON TABLE public.hypermedia_documents TO context_use_boundary_owner;
GRANT SELECT(representation) ON TABLE public.hypermedia_documents TO context_use_projection_owner;
GRANT SELECT(representation) ON TABLE public.hypermedia_documents TO context_use_storage_owner;


--
-- Name: TABLE jwks; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.jwks TO context_use_auth;
GRANT SELECT ON TABLE public.jwks TO context_use_backup;


--
-- Name: TABLE knowledge_asset_links; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT,INSERT ON TABLE public.knowledge_asset_links TO context_use_dashboard;
GRANT SELECT,INSERT ON TABLE public.knowledge_asset_links TO context_use_mcp;
GRANT SELECT ON TABLE public.knowledge_asset_links TO context_use_backup;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.knowledge_asset_links TO context_use_boundary_owner;


--
-- Name: TABLE knowledge_export_intents; Type: ACL; Schema: public; Owner: postgres
--

GRANT DELETE ON TABLE public.knowledge_export_intents TO context_use_boundary_owner;
GRANT SELECT,DELETE ON TABLE public.knowledge_export_intents TO context_use_dashboard;
GRANT SELECT ON TABLE public.knowledge_export_intents TO context_use_backup;


--
-- Name: COLUMN knowledge_export_intents.id; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(id) ON TABLE public.knowledge_export_intents TO context_use_boundary_owner;
GRANT SELECT(id) ON TABLE public.knowledge_export_intents TO context_use_confirmation;
GRANT INSERT(id) ON TABLE public.knowledge_export_intents TO context_use_dashboard;


--
-- Name: COLUMN knowledge_export_intents.owner_user_id; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(owner_user_id) ON TABLE public.knowledge_export_intents TO context_use_boundary_owner;
GRANT SELECT(owner_user_id) ON TABLE public.knowledge_export_intents TO context_use_confirmation;
GRANT INSERT(owner_user_id) ON TABLE public.knowledge_export_intents TO context_use_dashboard;


--
-- Name: COLUMN knowledge_export_intents.session_id; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(session_id) ON TABLE public.knowledge_export_intents TO context_use_boundary_owner;
GRANT SELECT(session_id) ON TABLE public.knowledge_export_intents TO context_use_confirmation;
GRANT INSERT(session_id) ON TABLE public.knowledge_export_intents TO context_use_dashboard;


--
-- Name: COLUMN knowledge_export_intents.expires_at; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(expires_at),UPDATE(expires_at) ON TABLE public.knowledge_export_intents TO context_use_boundary_owner;
GRANT SELECT(expires_at) ON TABLE public.knowledge_export_intents TO context_use_confirmation;
GRANT INSERT(expires_at) ON TABLE public.knowledge_export_intents TO context_use_dashboard;


--
-- Name: COLUMN knowledge_export_intents.confirmed_at; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(confirmed_at),UPDATE(confirmed_at) ON TABLE public.knowledge_export_intents TO context_use_boundary_owner;
GRANT SELECT(confirmed_at) ON TABLE public.knowledge_export_intents TO context_use_confirmation;


--
-- Name: COLUMN knowledge_export_intents.download_started_at; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(download_started_at),UPDATE(download_started_at) ON TABLE public.knowledge_export_intents TO context_use_boundary_owner;
GRANT SELECT(download_started_at) ON TABLE public.knowledge_export_intents TO context_use_confirmation;


--
-- Name: TABLE knowledge_page_changes; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT ON TABLE public.knowledge_page_changes TO context_use_dashboard;
GRANT SELECT ON TABLE public.knowledge_page_changes TO context_use_mcp;
GRANT SELECT ON TABLE public.knowledge_page_changes TO context_use_backup;


--
-- Name: COLUMN knowledge_page_changes.page_id; Type: ACL; Schema: public; Owner: postgres
--

GRANT INSERT(page_id) ON TABLE public.knowledge_page_changes TO context_use_document_history_owner;


--
-- Name: COLUMN knowledge_page_changes.version_id; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(version_id),INSERT(version_id) ON TABLE public.knowledge_page_changes TO context_use_document_history_owner;


--
-- Name: COLUMN knowledge_page_changes.version_number; Type: ACL; Schema: public; Owner: postgres
--

GRANT INSERT(version_number) ON TABLE public.knowledge_page_changes TO context_use_document_history_owner;


--
-- Name: COLUMN knowledge_page_changes.change_kind; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(change_kind),INSERT(change_kind) ON TABLE public.knowledge_page_changes TO context_use_document_history_owner;


--
-- Name: COLUMN knowledge_page_changes.title; Type: ACL; Schema: public; Owner: postgres
--

GRANT INSERT(title) ON TABLE public.knowledge_page_changes TO context_use_document_history_owner;


--
-- Name: COLUMN knowledge_page_changes.commit_message; Type: ACL; Schema: public; Owner: postgres
--

GRANT INSERT(commit_message) ON TABLE public.knowledge_page_changes TO context_use_document_history_owner;


--
-- Name: COLUMN knowledge_page_changes.actor_kind; Type: ACL; Schema: public; Owner: postgres
--

GRANT INSERT(actor_kind) ON TABLE public.knowledge_page_changes TO context_use_document_history_owner;


--
-- Name: COLUMN knowledge_page_changes.actor_subject; Type: ACL; Schema: public; Owner: postgres
--

GRANT INSERT(actor_subject) ON TABLE public.knowledge_page_changes TO context_use_document_history_owner;


--
-- Name: COLUMN knowledge_page_changes.changed_at; Type: ACL; Schema: public; Owner: postgres
--

GRANT INSERT(changed_at) ON TABLE public.knowledge_page_changes TO context_use_document_history_owner;


--
-- Name: SEQUENCE knowledge_page_changes_change_sequence_seq; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT ON SEQUENCE public.knowledge_page_changes_change_sequence_seq TO context_use_backup;
GRANT SELECT,USAGE ON SEQUENCE public.knowledge_page_changes_change_sequence_seq TO context_use_document_history_owner;


--
-- Name: TABLE knowledge_page_versions; Type: ACL; Schema: public; Owner: postgres
--

GRANT INSERT,DELETE,UPDATE ON TABLE public.knowledge_page_versions TO context_use_boundary_owner;
GRANT SELECT ON TABLE public.knowledge_page_versions TO context_use_dashboard;
GRANT SELECT ON TABLE public.knowledge_page_versions TO context_use_mcp;
GRANT SELECT ON TABLE public.knowledge_page_versions TO context_use_backup;


--
-- Name: COLUMN knowledge_page_versions.id; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(id) ON TABLE public.knowledge_page_versions TO context_use_projection_owner;
GRANT SELECT(id) ON TABLE public.knowledge_page_versions TO context_use_boundary_owner;
GRANT INSERT(id) ON TABLE public.knowledge_page_versions TO context_use_dashboard;
GRANT INSERT(id) ON TABLE public.knowledge_page_versions TO context_use_mcp;
GRANT SELECT(id) ON TABLE public.knowledge_page_versions TO context_use_storage;
GRANT SELECT(id) ON TABLE public.knowledge_page_versions TO context_use_storage_owner;
GRANT SELECT(id) ON TABLE public.knowledge_page_versions TO context_use_document_history_owner;


--
-- Name: COLUMN knowledge_page_versions.page_id; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(page_id) ON TABLE public.knowledge_page_versions TO context_use_projection_owner;
GRANT SELECT(page_id) ON TABLE public.knowledge_page_versions TO context_use_boundary_owner;
GRANT INSERT(page_id) ON TABLE public.knowledge_page_versions TO context_use_dashboard;
GRANT INSERT(page_id) ON TABLE public.knowledge_page_versions TO context_use_mcp;
GRANT SELECT(page_id) ON TABLE public.knowledge_page_versions TO context_use_storage;
GRANT SELECT(page_id) ON TABLE public.knowledge_page_versions TO context_use_storage_owner;
GRANT SELECT(page_id) ON TABLE public.knowledge_page_versions TO context_use_document_history_owner;


--
-- Name: COLUMN knowledge_page_versions.version_number; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(version_number) ON TABLE public.knowledge_page_versions TO context_use_boundary_owner;
GRANT INSERT(version_number) ON TABLE public.knowledge_page_versions TO context_use_dashboard;
GRANT INSERT(version_number) ON TABLE public.knowledge_page_versions TO context_use_mcp;
GRANT SELECT(version_number) ON TABLE public.knowledge_page_versions TO context_use_storage;
GRANT SELECT(version_number) ON TABLE public.knowledge_page_versions TO context_use_projection_owner;
GRANT SELECT(version_number) ON TABLE public.knowledge_page_versions TO context_use_storage_owner;
GRANT SELECT(version_number) ON TABLE public.knowledge_page_versions TO context_use_document_history_owner;


--
-- Name: COLUMN knowledge_page_versions.title; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(title) ON TABLE public.knowledge_page_versions TO context_use_projection_owner;
GRANT INSERT(title) ON TABLE public.knowledge_page_versions TO context_use_dashboard;
GRANT INSERT(title) ON TABLE public.knowledge_page_versions TO context_use_mcp;
GRANT SELECT(title) ON TABLE public.knowledge_page_versions TO context_use_storage;
GRANT SELECT(title) ON TABLE public.knowledge_page_versions TO context_use_boundary_owner;
GRANT SELECT(title) ON TABLE public.knowledge_page_versions TO context_use_storage_owner;
GRANT SELECT(title) ON TABLE public.knowledge_page_versions TO context_use_document_history_owner;


--
-- Name: COLUMN knowledge_page_versions.summary; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(summary) ON TABLE public.knowledge_page_versions TO context_use_projection_owner;
GRANT INSERT(summary) ON TABLE public.knowledge_page_versions TO context_use_dashboard;
GRANT INSERT(summary) ON TABLE public.knowledge_page_versions TO context_use_mcp;
GRANT SELECT(summary) ON TABLE public.knowledge_page_versions TO context_use_storage;
GRANT SELECT(summary) ON TABLE public.knowledge_page_versions TO context_use_boundary_owner;
GRANT SELECT(summary) ON TABLE public.knowledge_page_versions TO context_use_storage_owner;


--
-- Name: COLUMN knowledge_page_versions.commit_message; Type: ACL; Schema: public; Owner: postgres
--

GRANT INSERT(commit_message) ON TABLE public.knowledge_page_versions TO context_use_dashboard;
GRANT INSERT(commit_message) ON TABLE public.knowledge_page_versions TO context_use_mcp;
GRANT SELECT(commit_message) ON TABLE public.knowledge_page_versions TO context_use_document_history_owner;


--
-- Name: COLUMN knowledge_page_versions.actor_kind; Type: ACL; Schema: public; Owner: postgres
--

GRANT INSERT(actor_kind) ON TABLE public.knowledge_page_versions TO context_use_dashboard;
GRANT INSERT(actor_kind) ON TABLE public.knowledge_page_versions TO context_use_mcp;
GRANT SELECT(actor_kind) ON TABLE public.knowledge_page_versions TO context_use_boundary_owner;
GRANT SELECT(actor_kind) ON TABLE public.knowledge_page_versions TO context_use_document_history_owner;


--
-- Name: COLUMN knowledge_page_versions.actor_subject; Type: ACL; Schema: public; Owner: postgres
--

GRANT INSERT(actor_subject) ON TABLE public.knowledge_page_versions TO context_use_dashboard;
GRANT INSERT(actor_subject) ON TABLE public.knowledge_page_versions TO context_use_mcp;
GRANT SELECT(actor_subject) ON TABLE public.knowledge_page_versions TO context_use_boundary_owner;
GRANT SELECT(actor_subject) ON TABLE public.knowledge_page_versions TO context_use_document_history_owner;


--
-- Name: COLUMN knowledge_page_versions.created_at; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(created_at) ON TABLE public.knowledge_page_versions TO context_use_projection_owner;
GRANT SELECT(created_at) ON TABLE public.knowledge_page_versions TO context_use_storage;
GRANT SELECT(created_at) ON TABLE public.knowledge_page_versions TO context_use_boundary_owner;
GRANT SELECT(created_at) ON TABLE public.knowledge_page_versions TO context_use_storage_owner;


--
-- Name: TABLE knowledge_pages; Type: ACL; Schema: public; Owner: postgres
--

GRANT INSERT,DELETE,UPDATE ON TABLE public.knowledge_pages TO context_use_boundary_owner;
GRANT SELECT ON TABLE public.knowledge_pages TO context_use_dashboard;
GRANT SELECT ON TABLE public.knowledge_pages TO context_use_mcp;
GRANT SELECT ON TABLE public.knowledge_pages TO context_use_backup;


--
-- Name: COLUMN knowledge_pages.id; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(id) ON TABLE public.knowledge_pages TO context_use_projection_owner;
GRANT SELECT(id),UPDATE(id) ON TABLE public.knowledge_pages TO context_use_boundary_owner;
GRANT INSERT(id) ON TABLE public.knowledge_pages TO context_use_dashboard;
GRANT INSERT(id) ON TABLE public.knowledge_pages TO context_use_mcp;
GRANT SELECT(id) ON TABLE public.knowledge_pages TO context_use_storage;
GRANT SELECT(id) ON TABLE public.knowledge_pages TO context_use_storage_owner;


--
-- Name: COLUMN knowledge_pages.current_version_id; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(current_version_id) ON TABLE public.knowledge_pages TO context_use_boundary_owner;
GRANT INSERT(current_version_id),UPDATE(current_version_id) ON TABLE public.knowledge_pages TO context_use_dashboard;
GRANT INSERT(current_version_id),UPDATE(current_version_id) ON TABLE public.knowledge_pages TO context_use_mcp;
GRANT SELECT(current_version_id) ON TABLE public.knowledge_pages TO context_use_storage;
GRANT SELECT(current_version_id) ON TABLE public.knowledge_pages TO context_use_projection_owner;
GRANT SELECT(current_version_id) ON TABLE public.knowledge_pages TO context_use_storage_owner;


--
-- Name: COLUMN knowledge_pages.created_at; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(created_at) ON TABLE public.knowledge_pages TO context_use_storage;
GRANT SELECT(created_at) ON TABLE public.knowledge_pages TO context_use_boundary_owner;


--
-- Name: COLUMN knowledge_pages.updated_at; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(updated_at),UPDATE(updated_at) ON TABLE public.knowledge_pages TO context_use_boundary_owner;
GRANT UPDATE(updated_at) ON TABLE public.knowledge_pages TO context_use_dashboard;
GRANT UPDATE(updated_at) ON TABLE public.knowledge_pages TO context_use_mcp;
GRANT SELECT(updated_at) ON TABLE public.knowledge_pages TO context_use_storage;


--
-- Name: COLUMN knowledge_pages.archived_at; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(archived_at) ON TABLE public.knowledge_pages TO context_use_projection_owner;
GRANT SELECT(archived_at) ON TABLE public.knowledge_pages TO context_use_boundary_owner;
GRANT UPDATE(archived_at) ON TABLE public.knowledge_pages TO context_use_dashboard;
GRANT UPDATE(archived_at) ON TABLE public.knowledge_pages TO context_use_mcp;
GRANT SELECT(archived_at) ON TABLE public.knowledge_pages TO context_use_storage;
GRANT SELECT(archived_at) ON TABLE public.knowledge_pages TO context_use_storage_owner;


--
-- Name: COLUMN knowledge_pages.search_vector; Type: ACL; Schema: public; Owner: postgres
--

GRANT INSERT(search_vector),UPDATE(search_vector) ON TABLE public.knowledge_pages TO context_use_dashboard;
GRANT INSERT(search_vector),UPDATE(search_vector) ON TABLE public.knowledge_pages TO context_use_mcp;


--
-- Name: TABLE knowledge_revision_contracts; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT ON TABLE public.knowledge_revision_contracts TO context_use_projection_owner;
GRANT SELECT,INSERT ON TABLE public.knowledge_revision_contracts TO context_use_boundary_owner;
GRANT SELECT ON TABLE public.knowledge_revision_contracts TO context_use_dashboard;
GRANT SELECT ON TABLE public.knowledge_revision_contracts TO context_use_mcp;
GRANT SELECT ON TABLE public.knowledge_revision_contracts TO context_use_backup;


--
-- Name: COLUMN knowledge_revision_contracts.revision_id; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(revision_id) ON TABLE public.knowledge_revision_contracts TO context_use_storage_owner;
GRANT SELECT(revision_id) ON TABLE public.knowledge_revision_contracts TO context_use_boundary_owner;


--
-- Name: COLUMN knowledge_revision_contracts.document_id; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(document_id) ON TABLE public.knowledge_revision_contracts TO context_use_storage_owner;
GRANT SELECT(document_id) ON TABLE public.knowledge_revision_contracts TO context_use_boundary_owner;


--
-- Name: COLUMN knowledge_revision_contracts.link_contract; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(link_contract) ON TABLE public.knowledge_revision_contracts TO context_use_storage_owner;
GRANT SELECT(link_contract) ON TABLE public.knowledge_revision_contracts TO context_use_boundary_owner;


--
-- Name: COLUMN knowledge_revision_contracts.provenance; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(provenance) ON TABLE public.knowledge_revision_contracts TO context_use_storage_owner;


--
-- Name: COLUMN knowledge_revision_contracts.body_content_hash; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(body_content_hash) ON TABLE public.knowledge_revision_contracts TO context_use_storage_owner;


--
-- Name: COLUMN knowledge_revision_contracts.target_document_ids; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(target_document_ids) ON TABLE public.knowledge_revision_contracts TO context_use_storage_owner;


--
-- Name: TABLE knowledge_search; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT ON TABLE public.knowledge_search TO context_use_projection_owner;
GRANT SELECT,INSERT,UPDATE ON TABLE public.knowledge_search TO context_use_boundary_owner;
GRANT SELECT ON TABLE public.knowledge_search TO context_use_dashboard;
GRANT SELECT ON TABLE public.knowledge_search TO context_use_mcp;
GRANT SELECT ON TABLE public.knowledge_search TO context_use_backup;


--
-- Name: COLUMN knowledge_search.document_id; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(document_id) ON TABLE public.knowledge_search TO context_use_boundary_owner;


--
-- Name: COLUMN knowledge_search.revision_id; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(revision_id) ON TABLE public.knowledge_search TO context_use_boundary_owner;


--
-- Name: TABLE knowledge_search_chunks; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT ON TABLE public.knowledge_search_chunks TO context_use_projection_owner;
GRANT SELECT,INSERT,DELETE ON TABLE public.knowledge_search_chunks TO context_use_boundary_owner;
GRANT SELECT ON TABLE public.knowledge_search_chunks TO context_use_backup;


--
-- Name: TABLE knowledge_settings; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT ON TABLE public.knowledge_settings TO context_use_dashboard;
GRANT SELECT ON TABLE public.knowledge_settings TO context_use_mcp;
GRANT SELECT ON TABLE public.knowledge_settings TO context_use_backup;
GRANT SELECT,UPDATE ON TABLE public.knowledge_settings TO context_use_boundary_owner;


--
-- Name: COLUMN knowledge_settings.singleton; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(singleton) ON TABLE public.knowledge_settings TO context_use_projection_owner;


--
-- Name: COLUMN knowledge_settings.global_guide_document_id; Type: ACL; Schema: public; Owner: postgres
--

GRANT UPDATE(global_guide_document_id) ON TABLE public.knowledge_settings TO context_use_dashboard;
GRANT UPDATE(global_guide_document_id) ON TABLE public.knowledge_settings TO context_use_boundary_owner;
GRANT SELECT(global_guide_document_id) ON TABLE public.knowledge_settings TO context_use_projection_owner;


--
-- Name: COLUMN knowledge_settings.updated_at; Type: ACL; Schema: public; Owner: postgres
--

GRANT UPDATE(updated_at) ON TABLE public.knowledge_settings TO context_use_dashboard;
GRANT UPDATE(updated_at) ON TABLE public.knowledge_settings TO context_use_boundary_owner;


--
-- Name: TABLE public_artifact_id_reservations; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT ON TABLE public.public_artifact_id_reservations TO context_use_backup;


--
-- Name: COLUMN public_artifact_id_reservations.artifact_id; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(artifact_id),INSERT(artifact_id) ON TABLE public.public_artifact_id_reservations TO context_use_boundary_owner;
GRANT SELECT(artifact_id) ON TABLE public.public_artifact_id_reservations TO context_use_projection_owner;


--
-- Name: COLUMN public_artifact_id_reservations.body_object_key; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(body_object_key),INSERT(body_object_key) ON TABLE public.public_artifact_id_reservations TO context_use_boundary_owner;


--
-- Name: COLUMN public_artifact_id_reservations.allocation_kind; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(allocation_kind),INSERT(allocation_kind) ON TABLE public.public_artifact_id_reservations TO context_use_boundary_owner;


--
-- Name: COLUMN public_artifact_id_reservations.allocation_id; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(allocation_id),INSERT(allocation_id) ON TABLE public.public_artifact_id_reservations TO context_use_boundary_owner;


--
-- Name: COLUMN public_artifact_id_reservations.created_at; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(created_at),INSERT(created_at) ON TABLE public.public_artifact_id_reservations TO context_use_boundary_owner;


--
-- Name: TABLE public_resources; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT,INSERT ON TABLE public.public_resources TO context_use_boundary_owner;
GRANT SELECT ON TABLE public.public_resources TO context_use_dashboard;
GRANT SELECT ON TABLE public.public_resources TO context_use_mcp;
GRANT SELECT ON TABLE public.public_resources TO context_use_backup;
GRANT SELECT ON TABLE public.public_resources TO context_use_projection_owner;
GRANT UPDATE ON TABLE public.public_resources TO context_use_publication_lock_owner;


--
-- Name: COLUMN public_resources.public_id; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(public_id) ON TABLE public.public_resources TO context_use_projection_owner;
GRANT SELECT(public_id) ON TABLE public.public_resources TO context_use_boundary_owner;
GRANT SELECT(public_id) ON TABLE public.public_resources TO context_use_storage_owner;


--
-- Name: COLUMN public_resources.document_id; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(document_id) ON TABLE public.public_resources TO context_use_projection_owner;
GRANT SELECT(document_id),UPDATE(document_id) ON TABLE public.public_resources TO context_use_boundary_owner;
GRANT SELECT(document_id) ON TABLE public.public_resources TO context_use_storage_owner;


--
-- Name: COLUMN public_resources.resource_kind; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(resource_kind) ON TABLE public.public_resources TO context_use_projection_owner;
GRANT SELECT(resource_kind) ON TABLE public.public_resources TO context_use_boundary_owner;
GRANT SELECT(resource_kind) ON TABLE public.public_resources TO context_use_storage_owner;


--
-- Name: COLUMN public_resources.original_document_id; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(original_document_id) ON TABLE public.public_resources TO context_use_projection_owner;
GRANT SELECT(original_document_id) ON TABLE public.public_resources TO context_use_backup;
GRANT SELECT(original_document_id) ON TABLE public.public_resources TO context_use_boundary_owner;
GRANT SELECT(original_document_id) ON TABLE public.public_resources TO context_use_storage_owner;


--
-- Name: TABLE public_route_aliases; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT,INSERT ON TABLE public.public_route_aliases TO context_use_boundary_owner;
GRANT SELECT ON TABLE public.public_route_aliases TO context_use_dashboard;
GRANT SELECT ON TABLE public.public_route_aliases TO context_use_mcp;
GRANT SELECT ON TABLE public.public_route_aliases TO context_use_backup;
GRANT SELECT ON TABLE public.public_route_aliases TO context_use_projection_owner;
GRANT UPDATE ON TABLE public.public_route_aliases TO context_use_publication_lock_owner;


--
-- Name: COLUMN public_route_aliases.alias_path; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(alias_path) ON TABLE public.public_route_aliases TO context_use_projection_owner;


--
-- Name: COLUMN public_route_aliases.route_kind; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(route_kind) ON TABLE public.public_route_aliases TO context_use_projection_owner;


--
-- Name: COLUMN public_route_aliases.public_id; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(public_id) ON TABLE public.public_route_aliases TO context_use_projection_owner;


--
-- Name: TABLE live_public_namespace_conflicts; Type: ACL; Schema: public; Owner: context_use_projection_owner
--

GRANT SELECT ON TABLE public.live_public_namespace_conflicts TO context_use_boundary_owner;
GRANT SELECT ON TABLE public.live_public_namespace_conflicts TO context_use_backup;


--
-- Name: TABLE "oauthAccessToken"; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public."oauthAccessToken" TO context_use_auth;
GRANT SELECT ON TABLE public."oauthAccessToken" TO context_use_backup;


--
-- Name: TABLE "oauthClient"; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public."oauthClient" TO context_use_auth;
GRANT SELECT ON TABLE public."oauthClient" TO context_use_backup;


--
-- Name: TABLE "oauthClientAssertion"; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public."oauthClientAssertion" TO context_use_auth;
GRANT SELECT ON TABLE public."oauthClientAssertion" TO context_use_backup;


--
-- Name: TABLE "oauthClientResource"; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public."oauthClientResource" TO context_use_auth;
GRANT SELECT ON TABLE public."oauthClientResource" TO context_use_backup;


--
-- Name: TABLE "oauthConsent"; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public."oauthConsent" TO context_use_auth;
GRANT SELECT ON TABLE public."oauthConsent" TO context_use_backup;


--
-- Name: TABLE "oauthRefreshToken"; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public."oauthRefreshToken" TO context_use_auth;
GRANT SELECT ON TABLE public."oauthRefreshToken" TO context_use_backup;


--
-- Name: TABLE "oauthResource"; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public."oauthResource" TO context_use_auth;
GRANT SELECT ON TABLE public."oauthResource" TO context_use_backup;


--
-- Name: TABLE page_deletion_intents; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT ON TABLE public.page_deletion_intents TO context_use_dashboard;
GRANT DELETE ON TABLE public.page_deletion_intents TO context_use_boundary_owner;
GRANT SELECT ON TABLE public.page_deletion_intents TO context_use_backup;


--
-- Name: COLUMN page_deletion_intents.id; Type: ACL; Schema: public; Owner: postgres
--

GRANT INSERT(id) ON TABLE public.page_deletion_intents TO context_use_dashboard;
GRANT SELECT(id),UPDATE(id) ON TABLE public.page_deletion_intents TO context_use_boundary_owner;
GRANT SELECT(id) ON TABLE public.page_deletion_intents TO context_use_confirmation;


--
-- Name: COLUMN page_deletion_intents.page_id; Type: ACL; Schema: public; Owner: postgres
--

GRANT INSERT(page_id) ON TABLE public.page_deletion_intents TO context_use_dashboard;
GRANT SELECT(page_id) ON TABLE public.page_deletion_intents TO context_use_boundary_owner;
GRANT SELECT(page_id) ON TABLE public.page_deletion_intents TO context_use_confirmation;


--
-- Name: COLUMN page_deletion_intents.expected_version_id; Type: ACL; Schema: public; Owner: postgres
--

GRANT INSERT(expected_version_id) ON TABLE public.page_deletion_intents TO context_use_dashboard;
GRANT SELECT(expected_version_id) ON TABLE public.page_deletion_intents TO context_use_boundary_owner;
GRANT SELECT(expected_version_id) ON TABLE public.page_deletion_intents TO context_use_confirmation;


--
-- Name: COLUMN page_deletion_intents.owner_user_id; Type: ACL; Schema: public; Owner: postgres
--

GRANT INSERT(owner_user_id) ON TABLE public.page_deletion_intents TO context_use_dashboard;
GRANT SELECT(owner_user_id) ON TABLE public.page_deletion_intents TO context_use_boundary_owner;
GRANT SELECT(owner_user_id) ON TABLE public.page_deletion_intents TO context_use_confirmation;


--
-- Name: COLUMN page_deletion_intents.session_id; Type: ACL; Schema: public; Owner: postgres
--

GRANT INSERT(session_id) ON TABLE public.page_deletion_intents TO context_use_dashboard;
GRANT SELECT(session_id) ON TABLE public.page_deletion_intents TO context_use_boundary_owner;
GRANT SELECT(session_id) ON TABLE public.page_deletion_intents TO context_use_confirmation;


--
-- Name: COLUMN page_deletion_intents.expires_at; Type: ACL; Schema: public; Owner: postgres
--

GRANT INSERT(expires_at) ON TABLE public.page_deletion_intents TO context_use_dashboard;
GRANT SELECT(expires_at) ON TABLE public.page_deletion_intents TO context_use_boundary_owner;
GRANT SELECT(expires_at) ON TABLE public.page_deletion_intents TO context_use_confirmation;


--
-- Name: TABLE page_publications; Type: ACL; Schema: public; Owner: postgres
--

GRANT DELETE ON TABLE public.page_publications TO context_use_boundary_owner;
GRANT SELECT ON TABLE public.page_publications TO context_use_backup;


--
-- Name: COLUMN page_publications.public_id; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(public_id),INSERT(public_id),UPDATE(public_id) ON TABLE public.page_publications TO context_use_boundary_owner;
GRANT SELECT(public_id) ON TABLE public.page_publications TO context_use_projection_owner;
GRANT SELECT(public_id) ON TABLE public.page_publications TO context_use_storage_owner;


--
-- Name: COLUMN page_publications.artifact_id; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(artifact_id),INSERT(artifact_id) ON TABLE public.page_publications TO context_use_boundary_owner;
GRANT SELECT(artifact_id) ON TABLE public.page_publications TO context_use_projection_owner;
GRANT SELECT(artifact_id) ON TABLE public.page_publications TO context_use_storage_owner;


--
-- Name: TABLE passkey; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT,INSERT ON TABLE public.passkey TO context_use_auth;
GRANT SELECT ON TABLE public.passkey TO context_use_backup;
GRANT DELETE ON TABLE public.passkey TO context_use_boundary_owner;


--
-- Name: COLUMN passkey.id; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(id) ON TABLE public.passkey TO context_use_confirmation;
GRANT SELECT(id) ON TABLE public.passkey TO context_use_boundary_owner;


--
-- Name: COLUMN passkey.name; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(name) ON TABLE public.passkey TO context_use_confirmation;


--
-- Name: COLUMN passkey."publicKey"; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT("publicKey") ON TABLE public.passkey TO context_use_confirmation;


--
-- Name: COLUMN passkey."userId"; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT("userId") ON TABLE public.passkey TO context_use_boundary_owner;
GRANT SELECT("userId") ON TABLE public.passkey TO context_use_confirmation;


--
-- Name: COLUMN passkey."credentialID"; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT("credentialID") ON TABLE public.passkey TO context_use_boundary_owner;
GRANT SELECT("credentialID") ON TABLE public.passkey TO context_use_confirmation;


--
-- Name: COLUMN passkey.counter; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(counter),UPDATE(counter) ON TABLE public.passkey TO context_use_boundary_owner;
GRANT SELECT(counter) ON TABLE public.passkey TO context_use_confirmation;
GRANT UPDATE(counter) ON TABLE public.passkey TO context_use_auth;


--
-- Name: COLUMN passkey.transports; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(transports) ON TABLE public.passkey TO context_use_confirmation;


--
-- Name: COLUMN passkey."createdAt"; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT("createdAt") ON TABLE public.passkey TO context_use_confirmation;


--
-- Name: TABLE passkey_management_intents; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.passkey_management_intents TO context_use_auth;
GRANT SELECT ON TABLE public.passkey_management_intents TO context_use_backup;


--
-- Name: TABLE source_records; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT,INSERT ON TABLE public.source_records TO context_use_mcp;
GRANT SELECT ON TABLE public.source_records TO context_use_dashboard;
GRANT SELECT ON TABLE public.source_records TO context_use_backup;
GRANT UPDATE ON TABLE public.source_records TO context_use_boundary_owner;


--
-- Name: COLUMN source_records.document_id; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(document_id) ON TABLE public.source_records TO context_use_storage;
GRANT SELECT(document_id) ON TABLE public.source_records TO context_use_boundary_owner;
GRANT SELECT(document_id) ON TABLE public.source_records TO context_use_projection_owner;


--
-- Name: COLUMN source_records.current_revision_id; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(current_revision_id) ON TABLE public.source_records TO context_use_storage;
GRANT UPDATE(current_revision_id) ON TABLE public.source_records TO context_use_mcp;
GRANT SELECT(current_revision_id) ON TABLE public.source_records TO context_use_projection_owner;


--
-- Name: COLUMN source_records.integration; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(integration) ON TABLE public.source_records TO context_use_projection_owner;


--
-- Name: COLUMN source_records.connection_id; Type: ACL; Schema: public; Owner: postgres
--

GRANT UPDATE(connection_id) ON TABLE public.source_records TO context_use_mcp;
GRANT SELECT(connection_id) ON TABLE public.source_records TO context_use_projection_owner;


--
-- Name: COLUMN source_records.model; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(model) ON TABLE public.source_records TO context_use_projection_owner;


--
-- Name: COLUMN source_records.source_record_id; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(source_record_id) ON TABLE public.source_records TO context_use_projection_owner;


--
-- Name: COLUMN source_records.source_created_at; Type: ACL; Schema: public; Owner: postgres
--

GRANT UPDATE(source_created_at) ON TABLE public.source_records TO context_use_mcp;


--
-- Name: COLUMN source_records.source_updated_at; Type: ACL; Schema: public; Owner: postgres
--

GRANT UPDATE(source_updated_at) ON TABLE public.source_records TO context_use_mcp;


--
-- Name: COLUMN source_records.search_vector; Type: ACL; Schema: public; Owner: postgres
--

GRANT UPDATE(search_vector) ON TABLE public.source_records TO context_use_mcp;
GRANT SELECT(search_vector) ON TABLE public.source_records TO context_use_projection_owner;


--
-- Name: COLUMN source_records.deleted_at; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(deleted_at) ON TABLE public.source_records TO context_use_storage;
GRANT UPDATE(deleted_at) ON TABLE public.source_records TO context_use_mcp;
GRANT SELECT(deleted_at) ON TABLE public.source_records TO context_use_projection_owner;


--
-- Name: COLUMN source_records.connection_instance_id; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(connection_instance_id) ON TABLE public.source_records TO context_use_projection_owner;


--
-- Name: TABLE private_document_catalog; Type: ACL; Schema: public; Owner: context_use_projection_owner
--

GRANT SELECT ON TABLE public.private_document_catalog TO context_use_dashboard;
GRANT SELECT ON TABLE public.private_document_catalog TO context_use_mcp;
GRANT SELECT ON TABLE public.private_document_catalog TO context_use_backup;


--
-- Name: TABLE public_asset_artifacts; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT ON TABLE public.public_asset_artifacts TO context_use_backup;


--
-- Name: COLUMN public_asset_artifacts.artifact_id; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(artifact_id),INSERT(artifact_id) ON TABLE public.public_asset_artifacts TO context_use_boundary_owner;
GRANT SELECT(artifact_id) ON TABLE public.public_asset_artifacts TO context_use_projection_owner;
GRANT SELECT(artifact_id) ON TABLE public.public_asset_artifacts TO context_use_storage_owner;


--
-- Name: COLUMN public_asset_artifacts.public_id; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(public_id),INSERT(public_id) ON TABLE public.public_asset_artifacts TO context_use_boundary_owner;
GRANT SELECT(public_id) ON TABLE public.public_asset_artifacts TO context_use_projection_owner;
GRANT SELECT(public_id) ON TABLE public.public_asset_artifacts TO context_use_storage_owner;


--
-- Name: COLUMN public_asset_artifacts.source_document_id; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(source_document_id),INSERT(source_document_id) ON TABLE public.public_asset_artifacts TO context_use_boundary_owner;


--
-- Name: COLUMN public_asset_artifacts.body_object_key; Type: ACL; Schema: public; Owner: postgres
--

GRANT INSERT(body_object_key) ON TABLE public.public_asset_artifacts TO context_use_boundary_owner;
GRANT SELECT(body_object_key) ON TABLE public.public_asset_artifacts TO context_use_storage_owner;


--
-- Name: COLUMN public_asset_artifacts.body_size_bytes; Type: ACL; Schema: public; Owner: postgres
--

GRANT INSERT(body_size_bytes) ON TABLE public.public_asset_artifacts TO context_use_boundary_owner;
GRANT SELECT(body_size_bytes) ON TABLE public.public_asset_artifacts TO context_use_storage_owner;


--
-- Name: COLUMN public_asset_artifacts.body_content_hash; Type: ACL; Schema: public; Owner: postgres
--

GRANT INSERT(body_content_hash) ON TABLE public.public_asset_artifacts TO context_use_boundary_owner;
GRANT SELECT(body_content_hash) ON TABLE public.public_asset_artifacts TO context_use_storage_owner;


--
-- Name: COLUMN public_asset_artifacts.public_filename; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(public_filename),INSERT(public_filename) ON TABLE public.public_asset_artifacts TO context_use_boundary_owner;
GRANT SELECT(public_filename) ON TABLE public.public_asset_artifacts TO context_use_projection_owner;


--
-- Name: COLUMN public_asset_artifacts.public_content_type; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(public_content_type),INSERT(public_content_type) ON TABLE public.public_asset_artifacts TO context_use_boundary_owner;
GRANT SELECT(public_content_type) ON TABLE public.public_asset_artifacts TO context_use_projection_owner;


--
-- Name: COLUMN public_asset_artifacts.public_width; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(public_width),INSERT(public_width) ON TABLE public.public_asset_artifacts TO context_use_boundary_owner;
GRANT SELECT(public_width) ON TABLE public.public_asset_artifacts TO context_use_projection_owner;


--
-- Name: COLUMN public_asset_artifacts.public_height; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(public_height),INSERT(public_height) ON TABLE public.public_asset_artifacts TO context_use_boundary_owner;
GRANT SELECT(public_height) ON TABLE public.public_asset_artifacts TO context_use_projection_owner;


--
-- Name: COLUMN public_asset_artifacts.public_duration_seconds; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(public_duration_seconds),INSERT(public_duration_seconds) ON TABLE public.public_asset_artifacts TO context_use_boundary_owner;
GRANT SELECT(public_duration_seconds) ON TABLE public.public_asset_artifacts TO context_use_projection_owner;


--
-- Name: COLUMN public_asset_artifacts.origin; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(origin),INSERT(origin) ON TABLE public.public_asset_artifacts TO context_use_boundary_owner;


--
-- Name: COLUMN public_asset_artifacts.source_intent_id; Type: ACL; Schema: public; Owner: postgres
--

GRANT INSERT(source_intent_id) ON TABLE public.public_asset_artifacts TO context_use_boundary_owner;


--
-- Name: COLUMN public_asset_artifacts.retained_source_id; Type: ACL; Schema: public; Owner: postgres
--

GRANT INSERT(retained_source_id) ON TABLE public.public_asset_artifacts TO context_use_boundary_owner;


--
-- Name: COLUMN public_asset_artifacts.retained_source_kind; Type: ACL; Schema: public; Owner: postgres
--

GRANT INSERT(retained_source_kind) ON TABLE public.public_asset_artifacts TO context_use_boundary_owner;


--
-- Name: COLUMN public_asset_artifacts.representation_token; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(representation_token),INSERT(representation_token) ON TABLE public.public_asset_artifacts TO context_use_boundary_owner;
GRANT SELECT(representation_token) ON TABLE public.public_asset_artifacts TO context_use_projection_owner;
GRANT SELECT(representation_token) ON TABLE public.public_asset_artifacts TO context_use_storage_owner;


--
-- Name: COLUMN public_asset_artifacts.reservation_allocation_kind; Type: ACL; Schema: public; Owner: postgres
--

GRANT INSERT(reservation_allocation_kind) ON TABLE public.public_asset_artifacts TO context_use_boundary_owner;


--
-- Name: COLUMN public_asset_artifacts.reservation_allocation_id; Type: ACL; Schema: public; Owner: postgres
--

GRANT INSERT(reservation_allocation_id) ON TABLE public.public_asset_artifacts TO context_use_boundary_owner;


--
-- Name: TABLE public_assets; Type: ACL; Schema: public; Owner: context_use_projection_owner
--

GRANT SELECT ON TABLE public.public_assets TO context_use_boundary_owner;
GRANT SELECT ON TABLE public.public_assets TO context_use_public;
GRANT SELECT ON TABLE public.public_assets TO context_use_backup;


--
-- Name: TABLE public_page_artifacts; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT ON TABLE public.public_page_artifacts TO context_use_backup;


--
-- Name: COLUMN public_page_artifacts.artifact_id; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(artifact_id),INSERT(artifact_id) ON TABLE public.public_page_artifacts TO context_use_boundary_owner;
GRANT SELECT(artifact_id) ON TABLE public.public_page_artifacts TO context_use_projection_owner;
GRANT SELECT(artifact_id) ON TABLE public.public_page_artifacts TO context_use_storage_owner;


--
-- Name: COLUMN public_page_artifacts.public_id; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(public_id),INSERT(public_id) ON TABLE public.public_page_artifacts TO context_use_boundary_owner;
GRANT SELECT(public_id) ON TABLE public.public_page_artifacts TO context_use_projection_owner;
GRANT SELECT(public_id) ON TABLE public.public_page_artifacts TO context_use_storage_owner;


--
-- Name: COLUMN public_page_artifacts.source_document_id; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(source_document_id),INSERT(source_document_id) ON TABLE public.public_page_artifacts TO context_use_boundary_owner;


--
-- Name: COLUMN public_page_artifacts.source_revision_id; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(source_revision_id),INSERT(source_revision_id) ON TABLE public.public_page_artifacts TO context_use_boundary_owner;


--
-- Name: COLUMN public_page_artifacts.source_body_size_bytes; Type: ACL; Schema: public; Owner: postgres
--

GRANT INSERT(source_body_size_bytes) ON TABLE public.public_page_artifacts TO context_use_boundary_owner;


--
-- Name: COLUMN public_page_artifacts.source_body_content_hash; Type: ACL; Schema: public; Owner: postgres
--

GRANT INSERT(source_body_content_hash) ON TABLE public.public_page_artifacts TO context_use_boundary_owner;


--
-- Name: COLUMN public_page_artifacts.body_object_key; Type: ACL; Schema: public; Owner: postgres
--

GRANT INSERT(body_object_key) ON TABLE public.public_page_artifacts TO context_use_boundary_owner;
GRANT SELECT(body_object_key) ON TABLE public.public_page_artifacts TO context_use_storage_owner;


--
-- Name: COLUMN public_page_artifacts.body_size_bytes; Type: ACL; Schema: public; Owner: postgres
--

GRANT INSERT(body_size_bytes) ON TABLE public.public_page_artifacts TO context_use_boundary_owner;
GRANT SELECT(body_size_bytes) ON TABLE public.public_page_artifacts TO context_use_storage_owner;


--
-- Name: COLUMN public_page_artifacts.body_content_hash; Type: ACL; Schema: public; Owner: postgres
--

GRANT INSERT(body_content_hash) ON TABLE public.public_page_artifacts TO context_use_boundary_owner;
GRANT SELECT(body_content_hash) ON TABLE public.public_page_artifacts TO context_use_storage_owner;


--
-- Name: COLUMN public_page_artifacts.public_title; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(public_title),INSERT(public_title) ON TABLE public.public_page_artifacts TO context_use_boundary_owner;
GRANT SELECT(public_title) ON TABLE public.public_page_artifacts TO context_use_projection_owner;


--
-- Name: COLUMN public_page_artifacts.public_summary; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(public_summary),INSERT(public_summary) ON TABLE public.public_page_artifacts TO context_use_boundary_owner;
GRANT SELECT(public_summary) ON TABLE public.public_page_artifacts TO context_use_projection_owner;


--
-- Name: COLUMN public_page_artifacts.public_last_edited_at; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(public_last_edited_at),INSERT(public_last_edited_at) ON TABLE public.public_page_artifacts TO context_use_boundary_owner;
GRANT SELECT(public_last_edited_at) ON TABLE public.public_page_artifacts TO context_use_projection_owner;


--
-- Name: COLUMN public_page_artifacts.projected_target_public_ids; Type: ACL; Schema: public; Owner: postgres
--

GRANT INSERT(projected_target_public_ids) ON TABLE public.public_page_artifacts TO context_use_boundary_owner;


--
-- Name: COLUMN public_page_artifacts.observed_public_uuid_tokens; Type: ACL; Schema: public; Owner: postgres
--

GRANT INSERT(observed_public_uuid_tokens) ON TABLE public.public_page_artifacts TO context_use_boundary_owner;


--
-- Name: COLUMN public_page_artifacts.projection_receipt_hash; Type: ACL; Schema: public; Owner: postgres
--

GRANT INSERT(projection_receipt_hash) ON TABLE public.public_page_artifacts TO context_use_boundary_owner;


--
-- Name: COLUMN public_page_artifacts.origin; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(origin),INSERT(origin) ON TABLE public.public_page_artifacts TO context_use_boundary_owner;


--
-- Name: COLUMN public_page_artifacts.source_intent_id; Type: ACL; Schema: public; Owner: postgres
--

GRANT INSERT(source_intent_id) ON TABLE public.public_page_artifacts TO context_use_boundary_owner;


--
-- Name: COLUMN public_page_artifacts.retained_source_id; Type: ACL; Schema: public; Owner: postgres
--

GRANT INSERT(retained_source_id) ON TABLE public.public_page_artifacts TO context_use_boundary_owner;


--
-- Name: COLUMN public_page_artifacts.retained_source_kind; Type: ACL; Schema: public; Owner: postgres
--

GRANT INSERT(retained_source_kind) ON TABLE public.public_page_artifacts TO context_use_boundary_owner;


--
-- Name: COLUMN public_page_artifacts.retained_source_artifact_id; Type: ACL; Schema: public; Owner: postgres
--

GRANT INSERT(retained_source_artifact_id) ON TABLE public.public_page_artifacts TO context_use_boundary_owner;


--
-- Name: COLUMN public_page_artifacts.retained_projection_generation; Type: ACL; Schema: public; Owner: postgres
--

GRANT INSERT(retained_projection_generation) ON TABLE public.public_page_artifacts TO context_use_boundary_owner;


--
-- Name: COLUMN public_page_artifacts.representation_token; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(representation_token),INSERT(representation_token) ON TABLE public.public_page_artifacts TO context_use_boundary_owner;
GRANT SELECT(representation_token) ON TABLE public.public_page_artifacts TO context_use_projection_owner;
GRANT SELECT(representation_token) ON TABLE public.public_page_artifacts TO context_use_storage_owner;


--
-- Name: COLUMN public_page_artifacts.reservation_allocation_kind; Type: ACL; Schema: public; Owner: postgres
--

GRANT INSERT(reservation_allocation_kind) ON TABLE public.public_page_artifacts TO context_use_boundary_owner;


--
-- Name: COLUMN public_page_artifacts.reservation_allocation_id; Type: ACL; Schema: public; Owner: postgres
--

GRANT INSERT(reservation_allocation_id) ON TABLE public.public_page_artifacts TO context_use_boundary_owner;


--
-- Name: TABLE public_pages; Type: ACL; Schema: public; Owner: context_use_projection_owner
--

GRANT SELECT ON TABLE public.public_pages TO context_use_boundary_owner;
GRANT SELECT ON TABLE public.public_pages TO context_use_public;
GRANT SELECT ON TABLE public.public_pages TO context_use_backup;


--
-- Name: TABLE public_representation_token_reservations; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT,INSERT ON TABLE public.public_representation_token_reservations TO context_use_boundary_owner;
GRANT SELECT ON TABLE public.public_representation_token_reservations TO context_use_backup;


--
-- Name: COLUMN public_representation_token_reservations.representation_token; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(representation_token) ON TABLE public.public_representation_token_reservations TO context_use_storage_owner;


--
-- Name: COLUMN public_representation_token_reservations.artifact_id; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(artifact_id) ON TABLE public.public_representation_token_reservations TO context_use_storage_owner;


--
-- Name: COLUMN public_representation_token_reservations.resource_kind; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(resource_kind) ON TABLE public.public_representation_token_reservations TO context_use_storage_owner;


--
-- Name: TABLE public_visibility_generations; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT,INSERT,UPDATE ON TABLE public.public_visibility_generations TO context_use_boundary_owner;
GRANT SELECT ON TABLE public.public_visibility_generations TO context_use_backup;


--
-- Name: TABLE publication_artifact_staging; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT ON TABLE public.publication_artifact_staging TO context_use_backup;
GRANT SELECT,INSERT ON TABLE public.publication_artifact_staging TO context_use_boundary_owner;


--
-- Name: COLUMN publication_artifact_staging.intent_id; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(intent_id) ON TABLE public.publication_artifact_staging TO context_use_storage_owner;


--
-- Name: TABLE publication_intent_id_reservations; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT,INSERT ON TABLE public.publication_intent_id_reservations TO context_use_boundary_owner;
GRANT SELECT ON TABLE public.publication_intent_id_reservations TO context_use_backup;


--
-- Name: COLUMN publication_intent_id_reservations.intent_id; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(intent_id) ON TABLE public.publication_intent_id_reservations TO context_use_confirmation;


--
-- Name: TABLE publication_intents; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT ON TABLE public.publication_intents TO context_use_backup;
GRANT SELECT,INSERT ON TABLE public.publication_intents TO context_use_boundary_owner;


--
-- Name: COLUMN publication_intents.id; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(id) ON TABLE public.publication_intents TO context_use_confirmation;
GRANT SELECT(id) ON TABLE public.publication_intents TO context_use_storage_owner;


--
-- Name: COLUMN publication_intents.action; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(action) ON TABLE public.publication_intents TO context_use_confirmation;
GRANT SELECT(action) ON TABLE public.publication_intents TO context_use_storage_owner;


--
-- Name: COLUMN publication_intents.target_kind; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(target_kind) ON TABLE public.publication_intents TO context_use_confirmation;
GRANT SELECT(target_kind) ON TABLE public.publication_intents TO context_use_storage_owner;


--
-- Name: COLUMN publication_intents.target_document_id; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(target_document_id) ON TABLE public.publication_intents TO context_use_confirmation;
GRANT SELECT(target_document_id) ON TABLE public.publication_intents TO context_use_storage_owner;


--
-- Name: COLUMN publication_intents.expected_revision_id; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(expected_revision_id) ON TABLE public.publication_intents TO context_use_confirmation;
GRANT SELECT(expected_revision_id) ON TABLE public.publication_intents TO context_use_storage_owner;


--
-- Name: COLUMN publication_intents.candidate_public_id; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(candidate_public_id) ON TABLE public.publication_intents TO context_use_storage_owner;


--
-- Name: COLUMN publication_intents.candidate_artifact_id; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(candidate_artifact_id) ON TABLE public.publication_intents TO context_use_storage_owner;


--
-- Name: COLUMN publication_intents.candidate_object_key; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(candidate_object_key) ON TABLE public.publication_intents TO context_use_storage_owner;


--
-- Name: COLUMN publication_intents.projected_target_public_ids; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(projected_target_public_ids) ON TABLE public.publication_intents TO context_use_storage_owner;


--
-- Name: COLUMN publication_intents.projection_receipt_hash; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(projection_receipt_hash) ON TABLE public.publication_intents TO context_use_storage_owner;


--
-- Name: COLUMN publication_intents.owner_user_id; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(owner_user_id) ON TABLE public.publication_intents TO context_use_confirmation;


--
-- Name: COLUMN publication_intents.session_id; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(session_id) ON TABLE public.publication_intents TO context_use_confirmation;


--
-- Name: COLUMN publication_intents.expires_at; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(expires_at) ON TABLE public.publication_intents TO context_use_confirmation;


--
-- Name: COLUMN publication_intents.confirmed_at; Type: ACL; Schema: public; Owner: postgres
--

GRANT UPDATE(confirmed_at) ON TABLE public.publication_intents TO context_use_boundary_owner;


--
-- Name: COLUMN publication_intents.cancelled_at; Type: ACL; Schema: public; Owner: postgres
--

GRANT UPDATE(cancelled_at) ON TABLE public.publication_intents TO context_use_boundary_owner;


--
-- Name: TABLE publication_object_claims; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT,INSERT ON TABLE public.publication_object_claims TO context_use_storage_owner;
GRANT SELECT ON TABLE public.publication_object_claims TO context_use_backup;


--
-- Name: COLUMN publication_object_claims.allocation_kind; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(allocation_kind) ON TABLE public.publication_object_claims TO context_use_boundary_owner;


--
-- Name: COLUMN publication_object_claims.allocation_id; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(allocation_id),UPDATE(allocation_id) ON TABLE public.publication_object_claims TO context_use_boundary_owner;


--
-- Name: COLUMN publication_object_claims.artifact_id; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(artifact_id) ON TABLE public.publication_object_claims TO context_use_boundary_owner;


--
-- Name: COLUMN publication_object_claims.body_object_key; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(body_object_key) ON TABLE public.publication_object_claims TO context_use_boundary_owner;


--
-- Name: COLUMN publication_object_claims.claim_token; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(claim_token) ON TABLE public.publication_object_claims TO context_use_boundary_owner;


--
-- Name: COLUMN publication_object_claims.claimed_at; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(claimed_at) ON TABLE public.publication_object_claims TO context_use_boundary_owner;


--
-- Name: COLUMN publication_object_claims.finalized_at; Type: ACL; Schema: public; Owner: postgres
--

GRANT UPDATE(finalized_at) ON TABLE public.publication_object_claims TO context_use_storage_owner;
GRANT SELECT(finalized_at) ON TABLE public.publication_object_claims TO context_use_boundary_owner;


--
-- Name: COLUMN publication_object_claims.body_size_bytes; Type: ACL; Schema: public; Owner: postgres
--

GRANT UPDATE(body_size_bytes) ON TABLE public.publication_object_claims TO context_use_storage_owner;
GRANT SELECT(body_size_bytes) ON TABLE public.publication_object_claims TO context_use_boundary_owner;


--
-- Name: COLUMN publication_object_claims.body_content_hash; Type: ACL; Schema: public; Owner: postgres
--

GRANT UPDATE(body_content_hash) ON TABLE public.publication_object_claims TO context_use_storage_owner;
GRANT SELECT(body_content_hash) ON TABLE public.publication_object_claims TO context_use_boundary_owner;


--
-- Name: TABLE publication_settings; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT ON TABLE public.publication_settings TO context_use_backup;
GRANT SELECT,UPDATE ON TABLE public.publication_settings TO context_use_boundary_owner;


--
-- Name: COLUMN publication_settings.singleton; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(singleton) ON TABLE public.publication_settings TO context_use_projection_owner;


--
-- Name: COLUMN publication_settings.entrypoint_public_id; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(entrypoint_public_id) ON TABLE public.publication_settings TO context_use_projection_owner;


--
-- Name: COLUMN publication_settings.updated_at; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(updated_at) ON TABLE public.publication_settings TO context_use_projection_owner;
GRANT SELECT(updated_at) ON TABLE public.publication_settings TO context_use_boundary_owner;


--
-- Name: TABLE publication_target_generations; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT,INSERT,UPDATE ON TABLE public.publication_target_generations TO context_use_boundary_owner;
GRANT SELECT ON TABLE public.publication_target_generations TO context_use_backup;


--
-- Name: TABLE retained_page_artifacts; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT,INSERT,UPDATE ON TABLE public.retained_page_artifacts TO context_use_storage;
GRANT SELECT ON TABLE public.retained_page_artifacts TO context_use_projection_owner;
GRANT SELECT ON TABLE public.retained_page_artifacts TO context_use_backup;
GRANT UPDATE ON TABLE public.retained_page_artifacts TO context_use_boundary_owner;


--
-- Name: COLUMN retained_page_artifacts.page_id; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(page_id) ON TABLE public.retained_page_artifacts TO context_use_boundary_owner;
GRANT SELECT(page_id) ON TABLE public.retained_page_artifacts TO context_use_corpus;
GRANT SELECT(page_id) ON TABLE public.retained_page_artifacts TO context_use_storage_owner;


--
-- Name: COLUMN retained_page_artifacts.version_id; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(version_id) ON TABLE public.retained_page_artifacts TO context_use_boundary_owner;
GRANT SELECT(version_id) ON TABLE public.retained_page_artifacts TO context_use_corpus;
GRANT SELECT(version_id) ON TABLE public.retained_page_artifacts TO context_use_storage_owner;


--
-- Name: COLUMN retained_page_artifacts.projection_generation; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(projection_generation) ON TABLE public.retained_page_artifacts TO context_use_boundary_owner;
GRANT SELECT(projection_generation) ON TABLE public.retained_page_artifacts TO context_use_corpus;
GRANT SELECT(projection_generation) ON TABLE public.retained_page_artifacts TO context_use_storage_owner;


--
-- Name: COLUMN retained_page_artifacts.artifact_id; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(artifact_id) ON TABLE public.retained_page_artifacts TO context_use_boundary_owner;
GRANT SELECT(artifact_id) ON TABLE public.retained_page_artifacts TO context_use_corpus;
GRANT SELECT(artifact_id) ON TABLE public.retained_page_artifacts TO context_use_storage_owner;


--
-- Name: COLUMN retained_page_artifacts.body_object_key; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(body_object_key) ON TABLE public.retained_page_artifacts TO context_use_boundary_owner;
GRANT SELECT(body_object_key) ON TABLE public.retained_page_artifacts TO context_use_corpus;
GRANT SELECT(body_object_key) ON TABLE public.retained_page_artifacts TO context_use_storage_owner;


--
-- Name: COLUMN retained_page_artifacts.body_size_bytes; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(body_size_bytes) ON TABLE public.retained_page_artifacts TO context_use_boundary_owner;
GRANT SELECT(body_size_bytes) ON TABLE public.retained_page_artifacts TO context_use_corpus;
GRANT SELECT(body_size_bytes) ON TABLE public.retained_page_artifacts TO context_use_storage_owner;


--
-- Name: COLUMN retained_page_artifacts.body_content_hash; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(body_content_hash) ON TABLE public.retained_page_artifacts TO context_use_boundary_owner;
GRANT SELECT(body_content_hash) ON TABLE public.retained_page_artifacts TO context_use_corpus;
GRANT SELECT(body_content_hash) ON TABLE public.retained_page_artifacts TO context_use_storage_owner;


--
-- Name: TABLE session; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.session TO context_use_auth;
GRANT SELECT ON TABLE public.session TO context_use_backup;


--
-- Name: TABLE source_record_search_chunks; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT,INSERT,DELETE ON TABLE public.source_record_search_chunks TO context_use_boundary_owner;
GRANT SELECT ON TABLE public.source_record_search_chunks TO context_use_mcp;
GRANT SELECT ON TABLE public.source_record_search_chunks TO context_use_backup;


--
-- Name: COLUMN source_record_search_chunks.document_id; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(document_id) ON TABLE public.source_record_search_chunks TO context_use_projection_owner;


--
-- Name: COLUMN source_record_search_chunks.search_vector; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(search_vector) ON TABLE public.source_record_search_chunks TO context_use_projection_owner;


--
-- Name: TABLE "user"; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT,INSERT ON TABLE public."user" TO context_use_auth;
GRANT SELECT ON TABLE public."user" TO context_use_backup;


--
-- Name: COLUMN "user".name; Type: ACL; Schema: public; Owner: postgres
--

GRANT UPDATE(name) ON TABLE public."user" TO context_use_auth;


--
-- Name: COLUMN "user".image; Type: ACL; Schema: public; Owner: postgres
--

GRANT UPDATE(image) ON TABLE public."user" TO context_use_auth;


--
-- Name: COLUMN "user"."updatedAt"; Type: ACL; Schema: public; Owner: postgres
--

GRANT UPDATE("updatedAt") ON TABLE public."user" TO context_use_auth;


--
-- Name: TABLE verification; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.verification TO context_use_auth;
GRANT SELECT ON TABLE public.verification TO context_use_backup;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: postgres
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT SELECT ON SEQUENCES TO context_use_backup;


-- The dump uses an empty search path while creating schema-qualified objects.
-- Restore the migrator's expected path before it records this transaction.
SELECT pg_catalog.set_config('search_path', 'pg_catalog, public', true);


--
-- PostgreSQL database dump complete
--
