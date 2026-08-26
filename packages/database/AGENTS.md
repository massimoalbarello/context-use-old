# Database architecture

`packages/database` owns PostgreSQL schema history, SQL repositories, database administration, and
database integration support. It does not own HTTP behavior or cross-resource business workflows.

## Repositories

- One repository per concern, behind a contract that service tests can implement.
- Repositories contain SQL and row mapping only. Blob writes, HTTP calls, retries, and business policy
  belong in services or their own external repositories.
- Every query uses explicit columns. Cross-schema relations are always schema-qualified.
- Transactions and lock ordering are part of a repository's contract and deserve integration tests.

Publication is the reference layout for a concern that spans trust domains:

- `src/publication/models.ts` owns shared database projections only.
- Each file in `src/publication/*-repository.ts` owns one caller's SQL capability.
- `src/publication/index.ts` is the deliberate package surface exported as
  `@context-use/database/publication`.

Do not put dashboard, storage, and anonymous-public queries back into one repository class merely
because they operate on related tables.

## Migration streams

Migration orchestration is split under `src/migrations`: catalog loading, ledger verification and
transactional application, and role-password reconciliation are separate mechanisms. The executable
`src/migrate.ts` remains only the composition root for restore coordination and those mechanisms.

The completed refactor has two clearly separated, ordered migration sections in
one transactional ledger:

1. Better Auth migrations create and evolve the `auth` schema.
2. Context Use migrations create and evolve application schema.

The Better Auth section always runs first. Generated Better Auth DDL is committed as its own file
and changed only by adding another generated migration. Better Auth never mutates schema
automatically at application startup. Context Use hardening follows in a separate application-owned
migration.

The clean history starts with `001_create_auth_schema.sql`, then the generated
`002_better_auth.sql`, the application snapshot in `003_application_schema.sql`, and finally the
application-owned auth constraints and grants in `004_harden_owner_auth.sql`.

## Schema-only migration rule

A migration describes schema and durable database behavior. It never migrates application data.

- No forward migration may contain top-level `INSERT`, `UPDATE`, `DELETE`, `COPY`, `MERGE`, `CALL`,
  or an anonymous `DO` block. The initial snapshot's idempotent role declaration is the sole
  grandfathered exception.
- DML inside a stored routine is allowed when it is the routine's runtime behavior.
- Never edit a migration that has shipped.
- Keep one reason per migration. Small means one reviewable concern, not an arbitrary line count.
- The runner wraps each migration and its ledger write in one transaction.

When existing rows must change, use expand/backfill/contract:

1. Add compatible schema.
2. Deploy code that tolerates both states.
3. Run a separate, explicit, idempotent, resumable data job or reviewed operator query.
4. Verify a named invariant.
5. Switch reads and writes.
6. Remove the old schema in a later migration.

Data jobs never execute from the migration runner or application startup.

## Better Auth ownership

Better Auth tables, including plugin tables, live in `auth`. Context Use-owned authentication
workflow tables remain in the application stream even when they reference an `auth` identity.
Context Use hardening layered over generated tables is a separate, clearly named application
migration and is never folded into generated Better Auth DDL.

Tests must prove migration order, absence of Better Auth tables in `public`, adapter schema
selection, least-privilege grants, and data-job idempotency for legacy upgrades.
