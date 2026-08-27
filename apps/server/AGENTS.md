# Server architecture

`apps/server` contains three independently deployed trust domains in one build workspace:

- `src/private` — dashboard, auth, MCP, and confirmation, composed in process.
- `src/public` — anonymous published pages and assets.
- `src/storage` — the object broker and the only runtime allowed AWS, S3, and KMS credentials.

`src/http` contains only authority-neutral HTTP mechanics, `src/markdown` contains pure rendering
mechanics, and `src/development` composes the local three-process experience. Do not create a
generic shared directory or move private/public/storage policy out of its owning process.

## Layering

Every HTTP feature has three layers. Do not collapse or skip them.

- `routes/` — controllers and HTTP models. Controllers authenticate, accept validated input, call a
  service, and map the result to a declared response. No SQL or business rules.
- `services/` — use cases and business policy. Services coordinate repositories and other services.
  No SQL, Elysia request objects, or process-global construction.
- `repositories/` — every system outside the service, behind a narrow contract a test can
  substitute. A PostgreSQL repository contains SQL only; storage sockets and Nango are external
  repositories too.

Dependencies are instantiated once in an app factory or entrypoint and injected. Importing a
controller or service must have no connection or environment side effect.

## Applications and routes

Each deployed process owns a pure app factory, one composition root, one process-specific config
loader, and one `index.ts`. Only `index.ts` reads `process.env` or listens. The composition root
constructs the graph and returns a closeable runtime.

Within each process namespace, `routes/` mirrors the served URL:

```text
GET /api/dashboard/pages/:pageId/history
private/routes/api/dashboard/pages/[pageId]/history/controller.ts
private/routes/api/dashboard/pages/[pageId]/history/model.ts
```

Dynamic folders name the value they identify (`[pageId]`, never `[id]`). A schema shared by sibling
routes belongs in their parent `model.ts`. One controller may implement multiple methods on the same
resource; unrelated paths get separate controllers.

Every parsed JSON request has a schema at the controller boundary. Response contracts belong beside
the route or in the shared API contract consumed by the frontend. Streaming uploads, downloads,
range responses, Better Auth, and MCP transport are explicit exceptions with dedicated boundary
code.

Route aggregators only assemble path controllers; they must not absorb feature logic. Keep each
controller beside the path it serves, and keep cross-route workflows in narrowly named services.
Models and views stay beside their owning route or process unless a second real consumer appears.

## Security boundaries

- Preserve origin, Fetch Metadata, CSRF, owner-session, OAuth-resource, and capability checks at the
  surface that currently owns them.
- A shared service never weakens a stricter controller's guard.
- Tenant/private filtering belongs in the SQL predicate, never as an in-memory filter.
- Config is process-specific. A process must fail when it receives a secret or database credential
  it is not allowed to possess.
- Dashboard, auth, MCP, and confirmation call injected interfaces in process. Do not recreate
  internal HTTP between them.
- Private and public code see object bytes only through the storage-broker contract. They never
  import S3 implementations or receive AWS credentials.

## Tests

- Test services through repository contracts without constructing a real app.
- Test controllers with app factories that accept substituted services.
- Use integration tests for database permissions, Better Auth behavior, storage streaming, and
  concurrency that cannot be proved with a fake.
- Shared test infrastructure belongs in `tests/support`; feature-only fixtures stay with the feature.
