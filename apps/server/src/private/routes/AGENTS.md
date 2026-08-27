# Private application routes

This route tree mirrors the private application's served URL space. Each path folder owns its
controller and route-local model or view. Parent controllers are composition points only.

- Dashboard routes accept owner browser sessions and retain origin, Fetch Metadata, and CSRF
  enforcement.
- MCP routes accept OAuth bearer authority and never inherit browser-cookie authority.
- Authentication protocol routes remain public only where the protocol requires it.
- Confirmation endpoints preserve their intent binding and WebAuthn checks even though their
  service is now in process.
- Route controllers own headers, cookies, validation, and status mapping. Policy lives in services;
  SQL and external mechanics live in repositories.

Never add a generic private controller containing unrelated paths. Add the path-aligned subfolder,
then inject the smallest service interface that route needs.
