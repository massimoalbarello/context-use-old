# Development

## Run locally

You only need Docker:

```sh
git clone https://github.com/massimoalbarello/context-use.git
cd context-use
docker compose up --build
```

Then open the [local setup page](http://localhost:5173/app#setup=development-owner-setup-token-0000000000000).
The default owner email is `you@example.com`; set `OWNER_EMAIL` to use another one on a fresh
installation.

## Local stack

When working from this repository, the Bun shortcuts manage the stack lifecycle:

```sh
bun run local up       # build, start, and wait until the app is ready
bun run local status   # show the development containers
bun run local logs     # follow their logs
bun run local down     # stop everything but preserve local data
bun run local reset    # erase knowledge/assets, preserve login, and restart
bun run local destroy  # erase knowledge/assets, preserve login, and leave it stopped
bun run local purge    # erase every volume, including owner and passkeys
```

`bun run local up` prints the app and owner-setup URLs when it is ready.

## Integration suites

Database integration suites commit fixtures and clean them up with trigger and foreign-key
enforcement suspended, so they run against a PostgreSQL server of their own and refuse any
database that has not been marked disposable. Start one, run them, and throw it away:

```sh
bun run db:test up     # start, migrate, and mark a disposable PostgreSQL on 127.0.0.1:55432
TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/context_use_test bun test apps packages
bun run db:test down   # discard it
```

The mark is `ALTER DATABASE … SET "context_use.disposable_test_database" = 'true'`, applied by
`bun run db:test mark`, which refuses any database with an owner passkey registered against it.
The local stack above is therefore never eligible: these suites would delete its owner identity
while leaving related authentication state behind.

The local stack stores document and asset objects in its MinIO service through the same S3 client
used in production. `bun run local reset` removes that object-store volume together with the
database knowledge state; there is no filesystem storage backend or asset directory fallback.

## Bootstrap knowledge

New installations receive the Git-versioned default corpus during the isolated deployment
preparation step. That source is installation bootstrap data, not a runtime filesystem or a
template-management API. Once the bootstrap allocations are complete, redeployments skip preparation
and every retained guide, instruction, state document, and owner document is managed through the
same stable document identities, revisions, links, and search APIs.

Validate changes to the shipped bootstrap corpus with its focused database and template tests.
Do not add a dashboard or CLI path that reapplies the bootstrap documents to an
already-initialized knowledge base.

## Knowledge automations

Context Use stores automation instructions and supporting assets as ordinary private hypermedia
documents. An external harness such as OpenClaw can schedule a job that finds the instruction by
title or stable document identity, reads it with the document tools, then follows its links and
uses the ordinary knowledge and asset tools. Scheduling, retries, and run history stay in the
harness. An incremental automation may keep exactly one non-secret opaque checkpoint in its
stable state document.

The bootstrap corpus includes instruction documents for activity distillation, diary composition,
and guideline consistency review, with checkpoint state where required. Schedule an external
harness to search for and execute the relevant instruction document. Those documents are the
canonical operating contracts and are deliberately not duplicated here.

The dashboard's **History** section shows the same durable page ledger, including creates,
updates, archives, and deletion tombstones without page bodies or diffs.
