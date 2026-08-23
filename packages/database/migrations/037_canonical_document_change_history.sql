-- Record the canonical lifecycle transition itself after a repository creates
-- the immutable closing revision. Older triggers see that revision before the
-- page projection becomes archived and therefore record only an update.

SELECT pg_advisory_xact_lock(
  hashtextextended('filesystem-hypermedia-corpus-transition',0)
);

CREATE FUNCTION capture_archived_knowledge_document()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('knowledge-page-change-ledger',0)
  );
  INSERT INTO knowledge_page_changes(
    page_id,version_id,version_number,change_kind,path,title,commit_message,
    actor_kind,actor_subject,changed_at
  )
  SELECT version.page_id,version.id,version.version_number,'archived',
    version.path,version.title,version.commit_message,
    version.actor_kind,version.actor_subject,clock_timestamp()
  FROM knowledge_page_versions version
  WHERE version.page_id=NEW.id AND version.id=NEW.current_version_id
  ON CONFLICT (version_id,change_kind) DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE TRIGGER knowledge_pages_037_capture_archive
AFTER UPDATE OF archived_at ON knowledge_pages
FOR EACH ROW
WHEN (OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL)
EXECUTE FUNCTION capture_archived_knowledge_document();

REVOKE ALL ON FUNCTION capture_archived_knowledge_document() FROM PUBLIC;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname='context_use_document_history_owner'
  ) THEN
    CREATE ROLE context_use_document_history_owner
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
      NOREPLICATION NOBYPASSRLS;
  ELSE
    ALTER ROLE context_use_document_history_owner
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
      NOREPLICATION NOBYPASSRLS;
  END IF;
  ALTER ROLE context_use_document_history_owner
    SET search_path=pg_catalog,public;
END;
$$;

GRANT USAGE ON SCHEMA public TO context_use_document_history_owner;
GRANT INSERT (
  page_id,version_id,version_number,change_kind,path,title,commit_message,
  actor_kind,actor_subject,changed_at
) ON knowledge_page_changes TO context_use_document_history_owner;
GRANT SELECT (version_id,change_kind) ON knowledge_page_changes
  TO context_use_document_history_owner;
GRANT SELECT (
  id,page_id,version_number,path,title,commit_message,actor_kind,actor_subject
) ON knowledge_page_versions TO context_use_document_history_owner;
GRANT USAGE,SELECT ON SEQUENCE knowledge_page_changes_change_sequence_seq
  TO context_use_document_history_owner;
ALTER FUNCTION capture_archived_knowledge_document()
  OWNER TO context_use_document_history_owner;
