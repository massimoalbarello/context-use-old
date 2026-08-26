# Architecture

Context Use ships one product as several trust domains. The split is deliberate: each backend
process receives only the database role, network access, and capabilities needed for its surface.

| Process | Responsibility | Database authority |
| --- | --- | --- |
| Dashboard edge | Browser-facing request boundary and streaming proxy | None |
| Dashboard | Authenticated owner API and built dashboard | Dashboard role |
| Auth | Better Auth, passkeys, OAuth, and owner sessions | Auth role |
| Confirmation | Fresh passkey confirmation for sensitive actions | Confirmation role |
| Private MCP | Agent-facing knowledge and source-record tools | MCP role |
| Public web | Published pages, discovery documents, and public assets | Public role |
| Storage | Private object storage and publication materialization | Storage role |

Development may compose these processes behind one listener, but production never combines their
credentials.

## Backend dependency direction

```text
entrypoint -> app factory -> controller -> service -> repository -> external system
                                      \-> declared response model
```

Controllers own transport policy. Services own use cases. Repositories own communication with
PostgreSQL, object storage, Nango, or another process. Dependencies point in one direction and are
constructed only at the process composition root.

The route tree mirrors the URL tree within the process that serves it. This keeps overlapping proxy
and authority paths understandable without merging their security policies.

## Frontend dependency direction

```text
route -> component -> hook -> query options -> typed API client
```

TanStack Router owns navigation and route state. React Query owns server state. Components own local
interaction state only. API types flow from declared backend models through the typed client rather
than being copied into the dashboard.

## Database evolution

Better Auth owns an `auth` schema and a Better Auth migration stream. Context Use owns a separate
application stream. Better Auth migrations run first on a fresh database and both streams keep their
own immutable ledger.

Schema migrations never transform application rows. Existing data moves through explicit,
observable jobs between additive and contract schema releases. The final clean baseline is cut only
after every application query is modular, schema-qualified, and covered by the relevant permission
and behavior invariants.
