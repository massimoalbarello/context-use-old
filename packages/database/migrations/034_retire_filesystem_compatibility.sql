-- Retire every login-role entry into the legacy filesystem publication
-- projection. Permanent aliases and provenance remain stored, but public bytes
-- are now reachable only through an active pathless representation token.

SELECT pg_advisory_xact_lock(
  hashtextextended('filesystem-hypermedia-corpus-transition',0)
);

CREATE TABLE hypermedia_cutover_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  finalized_at timestamptz,
  CHECK (finalized_at IS NULL OR finalized_at>='2026-01-01'::timestamptz)
);
INSERT INTO hypermedia_cutover_state(singleton,finalized_at)
VALUES (true,NULL);

CREATE FUNCTION guard_hypermedia_cutover_state()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
BEGIN
  IF TG_OP='DELETE' OR OLD.finalized_at IS NOT NULL
     OR NEW.singleton IS DISTINCT FROM OLD.singleton
     OR NEW.finalized_at IS NULL THEN
    RAISE EXCEPTION 'hypermedia cutover completion is permanent'
      USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER hypermedia_cutover_state_034_keep_history
BEFORE UPDATE OR DELETE ON hypermedia_cutover_state
FOR EACH ROW EXECUTE FUNCTION guard_hypermedia_cutover_state();

CREATE FUNCTION finalize_hypermedia_cutover()
RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
SET jit=off
AS $$
DECLARE
  completed_at timestamptz;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('filesystem-hypermedia-corpus-transition',0)
  );
  SELECT finalized_at INTO completed_at
  FROM hypermedia_cutover_state WHERE singleton FOR UPDATE;
  IF completed_at IS NOT NULL THEN RETURN completed_at; END IF;
  PERFORM assert_hypermedia_cutover_ready();
  UPDATE hypermedia_cutover_state
  SET finalized_at=clock_timestamp()
  WHERE singleton
  RETURNING finalized_at INTO completed_at;
  RETURN completed_at;
END;
$$;

REVOKE ALL ON FUNCTION guard_hypermedia_cutover_state() FROM PUBLIC;
REVOKE ALL ON FUNCTION finalize_hypermedia_cutover() FROM PUBLIC;

-- These read projections were the old public/storage routing authorities.
-- The pathless resolver retains their former routes through immutable aliases.
REVOKE SELECT ON published_pages,published_assets,published_directories,
  published_site_settings FROM context_use_public;
REVOKE SELECT ON storage_published_pages,storage_published_assets
  FROM context_use_storage;

-- The authenticated application now creates only exact pathless intents and
-- updates only the independently latched pathless entrypoint.
REVOKE SELECT,INSERT,DELETE ON publication_intents FROM context_use_dashboard;
REVOKE SELECT,UPDATE ON public_knowledge_settings FROM context_use_dashboard;

-- The resumable corpus reconciler still compares the retained legacy pointer
-- after the dashboard loses this authority. Keep only the two read columns it
-- needs; all mutation remains behind boundary-owned functions.
GRANT SELECT (singleton,entrypoint_page_id) ON public_knowledge_settings
  TO context_use_corpus;

GRANT SELECT,UPDATE ON hypermedia_cutover_state TO context_use_boundary_owner;
GRANT USAGE,CREATE ON SCHEMA public TO context_use_boundary_owner;
ALTER FUNCTION guard_hypermedia_cutover_state()
  OWNER TO context_use_boundary_owner;
ALTER FUNCTION finalize_hypermedia_cutover()
  OWNER TO context_use_boundary_owner;
REVOKE CREATE ON SCHEMA public FROM context_use_boundary_owner;

GRANT EXECUTE ON FUNCTION finalize_hypermedia_cutover()
  TO context_use_corpus;
GRANT SELECT ON hypermedia_cutover_state TO context_use_backup;
