-- New knowledge and asset revisions are identified only by their stable UUIDs.
-- Retain historical path values for the following guarded schema-removal
-- migration, but stop requiring applications to manufacture compatibility
-- labels for new hypermedia-native rows.

SELECT pg_advisory_xact_lock(
  hashtextextended('filesystem-hypermedia-corpus-transition',0)
);

ALTER TABLE knowledge_pages
  ALTER COLUMN current_path DROP NOT NULL;

ALTER TABLE knowledge_page_versions
  ALTER COLUMN path DROP NOT NULL;

ALTER TABLE knowledge_page_changes
  ALTER COLUMN path DROP NOT NULL;

ALTER TABLE assets
  ALTER COLUMN current_path DROP NOT NULL;
