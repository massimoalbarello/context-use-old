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

The local stack stores immutable blobs for pages, records, and assets in MinIO through the same S3 client used in
production. `bun run local reset` removes that object-store volume together with the database
knowledge state.

## Bootstrap knowledge

New installations receive the Git-versioned default corpus during the isolated deployment
preparation step. On later deployments, that same stopped-consumer boundary compares the configured
global guide with the release's embedded `AGENTS.md` and creates one new immutable revision when they
differ. Matching guides are left unchanged. The automation instruction, state, and owner pages are
not reapplied; they remain managed through their stable object identities, revisions,
links and search APIs. There is no template-management API.

Validate changes to the shipped bootstrap corpus with its focused database and template tests.
Do not add a dashboard or CLI path that reapplies the bootstrap corpus to an already-initialized
knowledge base.

## Knowledge automations

Context Use stores automation instructions as ordinary private pages and supporting media as assets.
An external harness such as OpenClaw can schedule a job that finds the instruction by title or stable
object identity, reads it with the object tools, then follows its links and
uses the ordinary knowledge and asset tools. Scheduling, retries, and run history stay in the
harness. An incremental automation may keep exactly one non-secret opaque checkpoint in its
stable state page.

The bootstrap corpus includes instruction pages for activity distillation, diary composition,
and guideline consistency review, with checkpoint state where required. Schedule an external
harness to search for and execute the relevant instruction page. Those pages are the
canonical operating contracts and are deliberately not duplicated here.

The dashboard's **History** section shows the same durable page ledger, including creates,
updates, archives, and deletion tombstones without page bodies or diffs.
