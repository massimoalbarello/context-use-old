# Private authentication

Authentication is an in-process private module, not a separate HTTP service.

- Treat Better Auth as a protocol engine behind `/api/auth/*`; do not spread direct handler calls
  into dashboard or MCP routes.
- Keep public OAuth protocol routes, cookie-authenticated dashboard routes, bearer-authenticated MCP
  routes, and the Nango capability endpoint distinct.
- Buffer the bounded public OAuth token body before acquiring the owner authentication lock.
- Validate active owner-session lineage in addition to JWT signature and claims. Revoking an OAuth
  client must invalidate the lineage used by existing self-contained tokens.
- Better Auth owns only tables in PostgreSQL's `auth` schema. Its generated history remains separate
  and runs before the application migration history.

Test exact issuer and audience checks, session liveness, CSRF and origin enforcement, capability
separation, and passkey lock ordering.
