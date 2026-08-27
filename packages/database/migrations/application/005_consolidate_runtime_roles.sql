CREATE ROLE context_use_private
  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS;

ALTER ROLE context_use_private
  SET search_path TO pg_catalog, auth, public;

GRANT context_use_auth TO context_use_private;
GRANT context_use_dashboard TO context_use_private;
GRANT context_use_mcp TO context_use_private;
GRANT context_use_confirmation TO context_use_private;

ALTER ROLE context_use_auth NOLOGIN;
ALTER ROLE context_use_dashboard NOLOGIN;
ALTER ROLE context_use_mcp NOLOGIN;
ALTER ROLE context_use_confirmation NOLOGIN;
