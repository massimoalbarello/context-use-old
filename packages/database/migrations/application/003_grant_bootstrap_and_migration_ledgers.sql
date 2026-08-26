-- Runtime bootstrap owns creation of singleton rows. The boundary owner only needs
-- the narrow table privileges required by its SECURITY DEFINER entrypoint.
GRANT INSERT ON TABLE
  public.knowledge_bundle_import_policy,
  public.knowledge_settings,
  public.publication_settings
TO context_use_boundary_owner;

GRANT SELECT (singleton) ON TABLE public.knowledge_bundle_import_policy
TO context_use_boundary_owner;

-- Backups include both migration ledgers so a restored release can prove the
-- exact auth and application schema versions it contains.
GRANT SELECT ON TABLE
  public.auth_schema_migrations,
  public.schema_migrations
TO context_use_backup;
