# Server architecture

`apps/server` contains seven independently deployed trust domains in one build workspace:
dashboard, auth, private MCP, public web, confirmation, storage, and dashboard edge. Keeping one
workspace does not permit collapsing their credentials, network access, or database roles.

## Layering

Every HTTP feature has three layers. Do not collapse or skip them.

- `routes/` — controllers and HTTP models. Controllers authenticate, accept validated input, call a
  service, and map the result to a declared response. No SQL or business rules.
- `services/` — use cases and business policy. Services coordinate repositories and other services.
  No SQL, Elysia request objects, or process-global construction.
- repositories — every system outside the service, behind a contract a test can substitute. A
  PostgreSQL repository contains SQL only; storage sockets, Nango, and internal HTTP services are
  repositories too.

Dependencies are instantiated once in an app factory or entrypoint and injected. Importing a
controller or service must have no connection or environment side effect.

## Applications and routes

Each deployed process owns an app factory and an entrypoint. The app factory composes controllers;
the entrypoint reads only that process's configuration, constructs its graph, and listens.

Within each process namespace, `routes/` mirrors the served URL:

```text
GET /api/dashboard/pages/:pageId/history
routes/dashboard/api/dashboard/pages/[pageId]/history/controller.ts
routes/dashboard/api/dashboard/pages/[pageId]/history/model.ts
```

Dynamic folders name the value they identify (`[pageId]`, never `[id]`). A schema shared by sibling
routes belongs in their parent `model.ts`. One controller may implement multiple methods on the same
resource; unrelated paths get separate controllers.

Every parsed JSON request has a schema at the controller boundary. Response contracts belong beside
the route or in the shared API contract consumed by the frontend. Streaming uploads, downloads,
range responses, Better Auth, and MCP transport are explicit exceptions with dedicated boundary
code.

For the dashboard process, `src/app.ts` is the composition root and contains no handlers.
`routes/dashboard/controller.ts` only assembles the path controllers; it must not absorb feature
logic. Keep cross-route workflows in narrowly named services.

## Security boundaries

- Preserve origin, Fetch Metadata, CSRF, owner-session, OAuth-resource, and capability checks at the
  surface that currently owns them.
- A shared service never weakens a stricter controller's guard.
- Tenant/private filtering belongs in the SQL predicate, never as an in-memory filter.
- Config is process-specific. A process must fail when it receives a secret or database credential
  it is not allowed to possess.
- Cross-process clients send only the minimum authority required for that call.

## Tests

- Test services through repository contracts without constructing a real app.
- Test controllers with app factories that accept substituted services.
- Use integration tests for database permissions, Better Auth behavior, storage streaming, and
  concurrency that cannot be proved with a fake.
- Shared test infrastructure belongs in `tests/support`; feature-only fixtures stay with the feature.
