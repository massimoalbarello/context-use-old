-- Better Auth owns its relations in a dedicated schema. Keep this migration
-- separate so its generated schema can be reviewed and upgraded independently
-- from application-owned database objects.
CREATE SCHEMA auth;

REVOKE ALL ON SCHEMA auth FROM PUBLIC;
