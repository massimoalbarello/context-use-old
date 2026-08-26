# Authentication boundary routes

This route tree owns browser authentication, OAuth, passkey management, and authorization for the
dashboard, Nango, and MCP trust domains.

- Treat Better Auth as a protocol engine behind `/api/auth/*`; do not spread direct handler calls
  into application routes.
- Keep public protocol routes, pairwise internal authorization routes, and cookie-authenticated
  dashboard routes separate. Never accept a browser-supplied internal capability.
- Buffer the bounded public OAuth token body before acquiring the owner authentication lock.
- Validate active owner-session lineage in addition to JWT signature and claims. Revoking an OAuth
  client must invalidate the lineage used by existing self-contained tokens.
- Better Auth owns only tables in the PostgreSQL `auth` schema. Its generated migration history is
  separate and runs before the application migration history.
- Route controllers own headers, cookies, request validation, and status mapping. Token policy lives
  in services; SQL lives in repositories.

Test protocol and authorization invariants, especially capability separation, exact issuer/audience
checks, session liveness, CSRF/origin enforcement, and passkey lock ordering.
