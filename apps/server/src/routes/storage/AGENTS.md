# Storage broker routes

This route tree is the only network boundary around private and published object bytes. Keep each
controller under the path it serves and compose them in `controller.ts` with one shared
`activeWrites` set.

- Authenticate the pairwise capability before parsing attacker-controlled metadata or querying a
  repository.
- Return the same opaque 404 response for missing authority, metadata mismatch, invalid keys, and
  unavailable bytes. Do not turn authorization failures into an oracle.
- A write is authorized by exact metadata: canonical key, identity, size, content type, and digest.
  Do not weaken exact comparisons or make immutable writes overwrite existing bytes.
- Dashboard, MCP, and public capabilities are intentionally different. A route that needs only one
  must compare against that capability explicitly.
- Keep streaming and range-response mechanics at this boundary. Publication projection and
  maintenance workflows live in services and must not be duplicated in controllers.

Test stable security properties and byte-integrity behavior through `createStorageBrokerApp` with an
in-memory backend. Unix-socket tests are reserved for behavior that depends on streaming transport.
