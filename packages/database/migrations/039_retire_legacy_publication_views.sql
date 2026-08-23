-- Runtime publication and storage resolution now use pathless public IDs and
-- immutable representation tokens. Remove the filesystem-route projections,
-- while retaining published_page_sources as migration provenance.

SELECT pg_advisory_xact_lock(
  hashtextextended('filesystem-hypermedia-corpus-transition',0)
);

DROP VIEW storage_published_assets;
DROP VIEW storage_published_pages;
DROP VIEW published_site_settings;
DROP VIEW published_directories;
DROP VIEW published_assets;
DROP VIEW published_pages;
