-- A finalized hypermedia installation is maintained through stable document
-- identities and infrastructure backups. Retire the filesystem-era boundary
-- that deleted every legacy row and rebuilt a template tree after export.

SELECT pg_advisory_xact_lock(
  hashtextextended('filesystem-hypermedia-corpus-transition',0)
);

DROP FUNCTION clear_knowledge(
  uuid,text,text,uuid,text,integer,text,text,text,text,text,tsvector,text,text
);
DROP FUNCTION clear_knowledge_legacy_implementation(
  uuid,text,text,uuid,text,integer,text,text,text,text,text,tsvector,text,text
);
DROP FUNCTION complete_knowledge_export_download(uuid,text,text);

ALTER TABLE knowledge_export_intents
  DROP COLUMN reset_completed_at,
  DROP COLUMN download_completed_at,
  DROP COLUMN reset_requested;

-- The role is cluster-global and remains as an inert restore-era identity so
-- historical ownership manifests stay replayable. It retains no capability in
-- a fully migrated database.
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public
  FROM context_use_reset_owner;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public
  FROM context_use_reset_owner;
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public
  FROM context_use_reset_owner;
REVOKE USAGE ON SCHEMA public FROM context_use_reset_owner;
