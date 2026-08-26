-- Application-owned invariants around Better Auth's generated tables.
-- Keep this separate from 002_better_auth.sql so regenerating the vendor DDL
-- never obscures or weakens the single-owner and passkey boundaries.

ALTER TABLE auth."user"
  ADD CONSTRAINT user_single_owner_check
  CHECK (id='context-use-owner' AND "emailVerified"=true);

ALTER TABLE auth.passkey
  ADD CONSTRAINT passkey_name_length_check
  CHECK (
    name IS NULL
    OR (length(trim(name)) BETWEEN 1 AND 80)
  );

CREATE UNIQUE INDEX passkey_credential_id_unique
  ON auth.passkey ("credentialID");

CREATE TRIGGER user_protect_owner_identity
BEFORE DELETE OR UPDATE ON auth."user"
FOR EACH ROW EXECUTE FUNCTION public.protect_owner_identity();

CREATE TRIGGER passkey_protect_credential
BEFORE DELETE OR UPDATE ON auth.passkey
FOR EACH ROW EXECUTE FUNCTION public.protect_passkey_credential();

GRANT USAGE ON SCHEMA auth TO
  context_use_auth,
  context_use_backup,
  context_use_boundary_owner,
  context_use_confirmation;

REVOKE ALL ON ALL TABLES IN SCHEMA auth FROM PUBLIC;

GRANT SELECT,INSERT,DELETE,UPDATE ON
  auth.account,
  auth.jwks,
  auth."oauthAccessToken",
  auth."oauthClient",
  auth."oauthClientAssertion",
  auth."oauthClientResource",
  auth."oauthConsent",
  auth."oauthRefreshToken",
  auth."oauthResource",
  auth.session,
  auth.verification
TO context_use_auth;

GRANT SELECT,INSERT ON auth.passkey TO context_use_auth;
GRANT UPDATE (counter) ON auth.passkey TO context_use_auth;

GRANT SELECT,INSERT ON auth."user" TO context_use_auth;
GRANT UPDATE (name,image,"updatedAt") ON auth."user" TO context_use_auth;

GRANT SELECT ON ALL TABLES IN SCHEMA auth TO context_use_backup;

GRANT SELECT (id,"userId","credentialID",counter),UPDATE (counter),DELETE
  ON auth.passkey TO context_use_boundary_owner;

GRANT SELECT (
  id,
  name,
  "publicKey",
  "userId",
  "credentialID",
  counter,
  transports,
  "createdAt"
) ON auth.passkey TO context_use_confirmation;
