# Context Use contributor guide

Context Use is a Bun and TypeScript monorepo for a self-hosted knowledge base. The same release
contains several independently deployed backend processes, a React dashboard, a deployment CLI,
database tooling, and Nango integrations.

Read the nearest nested `AGENTS.md` before changing a workspace. More specific guidance overrides
this file.

## Repository map

- `apps/server` — private application, anonymous public application, and storage broker processes.
- `apps/web` — authenticated React dashboard.
- `apps/cli` — installation and operational CLI.
- `packages/database` — PostgreSQL schema, repositories, administrative commands, and test support.
- `packages/shared` — temporary shared contracts; this will be decomposed as API contracts become
  explicit.
- `packages/openclaw-context-use` — published OpenClaw memory integration.
- `nango-integrations` — separately built Nango sync contracts.
- `infra` and `deploy` — infrastructure and runtime topology.

## Non-negotiable boundaries

- Preserve the three backend trust domains. The private application owns dashboard, auth, MCP, and
  confirmation in process; the public application owns anonymous publication; only the storage
  broker receives AWS, S3, and KMS authority. Each process receives only its own database role,
  secrets, networks, and storage capability.
- HTTP controllers call services; services call repositories. Do not skip a layer.
- SQL and external-system mechanics belong in repositories. Business policy does not.
- Construct dependencies in an application composition root. Importing a module must not open a
  pool, start a server, read unrelated secrets, or mutate global state.
- Derive types from the schema or client that owns them. Do not maintain a second handwritten copy.
- Share business logic across API surfaces, not authentication or exposure policy. Dashboard and
  MCP controllers may call the same service while retaining distinct guards and response models.
- Keep refactoring changes behavior-preserving unless the PR explicitly names a behavior change.

## Code style

- Code must explain itself through names, types, and structure. Comments explain constraints or
  tradeoffs, never narrate the code.
- Prefer one primary component, controller, service, or repository per file.
- Wrap multiple function parameters in one object when the values form one operation.
- Use index files only as deliberate public surfaces or composition points.
- Do not create generic `utils`, `helpers`, `common`, or `core` dumping grounds. Name the domain or
  mechanism a module owns.
- New files use kebab-case except framework-generated files and existing entrypoint conventions.
- Preserve unrelated work and avoid mechanical churn outside the PR's declared architectural slice.

## Tests

A test protects a named invariant, boundary, or failure mode. There is no coverage target.

- Pure tests cover parsing, canonicalization, state transitions, and security decisions.
- Service tests cover business branching, ordering, retry, and idempotency.
- Controller tests cover authentication, validation, status, and response contracts.
- Repository integration tests cover real SQL, roles, constraints, locking, and concurrency.
- End-to-end tests cover only critical owner, publication, backup/restore, and deployment journeys.

Do not repeat the same behavior at every layer, assert private implementation structure, or inspect
large source strings when the resulting behavior can be executed instead.

## Validation

Run the narrow checks for the workspace while iterating. Before handing off a completed PR, run:

1. `bun run fix:codestyle`
2. `bun run check:all`
3. `bun run build`

Database, storage, deployment, and infrastructure changes also require their focused integration
checks. Consult package scripts before invoking tools directly.

## Keeping guidance current

When a change establishes a new architectural convention, update the owning `AGENTS.md` in the same
PR. Guidance describes the code that contributors are expected to write next; it must not become an
aspirational document that disagrees with the accepted architecture.
