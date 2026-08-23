import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client, Pool } from "pg";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { PageRepository, PublicRepository } from "../src/index.ts";
import { disposableDatabaseUrl } from "../src/disposable-database.ts";
import { MemoryMarkdownStore } from "./memory-markdown-store.ts";

const adminUrl = await disposableDatabaseUrl();
const describeDatabase = adminUrl ? describe : describe.skip;

describeDatabase("PostgreSQL security roles", () => {
  let admin: Client;

  beforeAll(async () => {
    admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    for (const [path, title] of [["test", "Test"], ["tests", "Tests"], ["profile", "Profile"], ["profile/work", "Work"]]) {
      await admin.query(
        `INSERT INTO knowledge_directories(id,current_path,title,summary,search_vector)
         VALUES ($1,$2,$3,$4,directory_search_vector($2,$3,$4,''))
         ON CONFLICT (current_path) DO NOTHING`,
        [randomUUID(), path, title, `Fixtures under ${path}.`],
      );
    }
    if (!(await admin.query("SELECT 1 FROM knowledge_pages WHERE current_path='agents'")).rowCount) {
      const pageId = randomUUID();
      const versionId = randomUUID();
      await admin.query("BEGIN");
      await admin.query("SET CONSTRAINTS ALL DEFERRED");
      await admin.query(
        `INSERT INTO knowledge_pages(id,current_path,current_version_id,search_vector)
         VALUES ($1,'agents',$2,page_search_vector('agents','AGENTS.md','Test root guide.','Test'))`,
        [pageId, versionId],
      );
      await admin.query(
        `INSERT INTO hypermedia_document_revisions(
           id,document_id,revision_number,body_object_key,body_size_bytes,body_content_hash
         ) VALUES ($1::uuid,$2::uuid,1,'documents/private/'||$1::text||'.md',4,$3)`,
        [versionId, pageId, "532eaabd9574880dbf76b9b8cc00832c20a6ec113d6822995505d7a6e0f345e2"],
      );
      await admin.query(
        `INSERT INTO knowledge_page_versions(
           id,page_id,version_number,path,title,summary,commit_message,actor_kind,actor_subject
         ) VALUES ($1,$2,1,'agents','AGENTS.md','Test root guide.','Create test guide','dashboard','context-use-template/default')`,
        [versionId, pageId],
      );
      await admin.query("COMMIT");
    }
  });

  afterAll(async () => {
    await admin.end();
  });

  async function expectDenied(sql: string, values: unknown[] = []): Promise<void> {
    await admin.query("SAVEPOINT expected_denial");
    let denied = false;
    try {
      await admin.query(sql, values);
    } catch {
      denied = true;
      await admin.query("ROLLBACK TO SAVEPOINT expected_denial");
    }
    await admin.query("RELEASE SAVEPOINT expected_denial");
    expect(denied).toBe(true);
  }

  const challenge = (): string => randomBytes(32).toString("base64url");

  async function ensureOwnerPasskey(counter = 0): Promise<void> {
    await admin.query(
      `INSERT INTO "user"(id,name,email,"emailVerified")
       VALUES ('context-use-owner','Owner','owner@example.invalid',true)
       ON CONFLICT (id) DO NOTHING`,
    );
    await admin.query(
      `INSERT INTO passkey(
         id,name,"publicKey","userId","credentialID",counter,"deviceType","backedUp",transports,"createdAt",aaguid
       ) VALUES (
         'test-passkey','Owner passkey','test-public-key','context-use-owner',
         'test-credential',$1,'singleDevice',false,'internal',now(),'test-aaguid'
       ) ON CONFLICT (id) DO NOTHING`,
      [counter],
    );
  }

  async function issueChallenge(
    kind: "publication" | "knowledge_export" | "page_deletion",
    intentId: string,
    value = challenge(),
  ): Promise<string> {
    await admin.query("SET LOCAL ROLE context_use_confirmation");
    await admin.query(
      "SELECT issue_confirmation_challenge($1,$2,$3)",
      [kind, intentId, value],
    );
    await admin.query("RESET ROLE");
    return value;
  }

  test("MCP and dashboard roles cannot update publication columns", async () => {
    for (const role of ["context_use_mcp", "context_use_dashboard"]) {
      const privilege = await admin.query<{ allowed: boolean }>(
        "SELECT has_column_privilege($1, 'knowledge_pages', 'published_version_id', 'UPDATE') AS allowed",
        [role],
      );
      expect(privilege.rows[0]?.allowed).toBe(false);
      const path = await admin.query<{ allowed: boolean }>(
        "SELECT has_column_privilege($1, 'knowledge_pages', 'public_path', 'UPDATE') AS allowed",
        [role],
      );
      expect(path.rows[0]?.allowed).toBe(false);
    }
  });

  test("the MCP role can update and archive ordinary knowledge through the checked writer", async () => {
    const mcpPool = new Pool({ connectionString: adminUrl, max: 1 });
    try {
      await mcpPool.query("SET ROLE context_use_mcp");
      const pages = new PageRepository(mcpPool, new MemoryMarkdownStore());
      const path = `tests/mcp-operational-lock-${randomUUID()}`;
      const actor = { kind: "mcp" as const, subject: "role-test" };
      const created = await pages.create({
        path,
        title: "MCP checked writer",
        summary: "Exercises the operational-document lock as the real MCP role.",
        body_markdown: "Initial body.",
        commit_message: "Create MCP role fixture",
      }, actor);

      const updated = await pages.update(created.id, {
        path,
        title: "MCP checked writer",
        summary: "Exercises the operational-document lock as the real MCP role.",
        body_markdown: "Updated body.",
        commit_message: "Update through MCP role",
        expected_version_number: 1,
      }, actor);
      expect(updated?.version_number).toBe(2);

      const archived = await pages.archive(created.id, {
        commit_message: "Archive through MCP role",
        expected_version_number: 2,
      }, actor);
      expect(archived?.version_number).toBe(3);
      expect(archived?.archived_at).not.toBeNull();
    } finally {
      await mcpPool.end();
    }
  });

  test("full-text search indexes only the current page projection", async () => {
    const indexes = await admin.query<{ current_index: string | null; historical_index: string | null }>(
      `SELECT to_regclass('knowledge_pages_search_idx')::text AS current_index,
              to_regclass('knowledge_page_versions_search_idx')::text AS historical_index`,
    );
    expect(indexes.rows[0]).toEqual({
      current_index: "knowledge_pages_search_idx",
      historical_index: null,
    });
    expect((await admin.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name='knowledge_pages' AND column_name='search_vector'`,
    )).rowCount).toBe(1);
    expect((await admin.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name='knowledge_page_versions' AND column_name='search_vector'`,
    )).rowCount).toBe(0);
  });

  test("only confirmation role can issue challenges and execute visibility procedures", async () => {
    const functions = [
      "issue_confirmation_challenge(confirmation_intent_kind,uuid,text)",
      "confirm_publication_intent(uuid,text,text,text,integer,integer)",
      "confirm_page_deletion_intent(uuid,text,text,text,integer,integer)",
    ];
    for (const role of ["context_use_mcp", "context_use_dashboard", "context_use_public", "context_use_auth", "context_use_storage", "context_use_backup"]) {
      for (const fn of functions) {
        const result = await admin.query<{ allowed: boolean }>(
          "SELECT has_function_privilege($1,$2,'EXECUTE') AS allowed",
          [role, fn],
        );
        expect(result.rows[0]?.allowed).toBe(false);
      }
    }
    for (const fn of functions) {
      const confirmation = await admin.query<{ allowed: boolean }>(
        "SELECT has_function_privilege('context_use_confirmation',$1,'EXECUTE') AS allowed",
        [fn],
      );
      expect(confirmation.rows[0]?.allowed).toBe(true);
    }
  });

  test("page writers retain history without receiving deletion or pruning access", async () => {
    for (const role of ["context_use_dashboard", "context_use_mcp"]) {
      expect((await admin.query<{ allowed: boolean }>(
        "SELECT has_function_privilege($1,'prune_page_versions(uuid)','EXECUTE') AS allowed",
        [role],
      )).rows[0]?.allowed).toBe(false);
      expect((await admin.query<{ allowed: boolean }>(
        "SELECT has_table_privilege($1,'knowledge_page_versions','DELETE') AS allowed",
        [role],
      )).rows[0]?.allowed).toBe(false);
      expect((await admin.query<{ allowed: boolean }>(
        "SELECT has_table_privilege($1,'hypermedia_document_revisions','UPDATE') AS allowed",
        [role],
      )).rows[0]?.allowed).toBe(false);
      expect((await admin.query<{ allowed: boolean }>(
        "SELECT has_table_privilege($1,'hypermedia_document_revisions','DELETE') AS allowed",
        [role],
      )).rows[0]?.allowed).toBe(false);
    }
    for (const role of ["context_use_auth", "context_use_public", "context_use_confirmation", "context_use_storage"]) {
      expect((await admin.query<{ allowed: boolean }>(
        "SELECT has_function_privilege($1,'prune_page_versions(uuid)','EXECUTE') AS allowed",
        [role],
      )).rows[0]?.allowed).toBe(false);
    }
  });

  test("page change history is body-free, harness-readable, and database-authored only", async () => {
    const columns = await admin.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema='public' AND table_name='knowledge_page_changes'
       ORDER BY ordinal_position`,
    );
    expect(columns.rows.map(({ column_name }) => column_name)).toEqual([
      "change_sequence",
      "page_id",
      "version_id",
      "version_number",
      "change_kind",
      "path",
      "title",
      "commit_message",
      "actor_kind",
      "actor_subject",
      "changed_at",
    ]);
    for (const role of ["context_use_dashboard", "context_use_mcp", "context_use_backup"]) {
      expect((await admin.query<{ allowed: boolean }>(
        "SELECT has_table_privilege($1,'knowledge_page_changes','SELECT') AS allowed",
        [role],
      )).rows[0]?.allowed).toBe(true);
    }
    expect((await admin.query<{ allowed: boolean }>(
      "SELECT has_sequence_privilege('context_use_backup','knowledge_page_changes_change_sequence_seq','SELECT') AS allowed",
    )).rows[0]?.allowed).toBe(true);
    for (const role of ["context_use_auth", "context_use_public", "context_use_confirmation", "context_use_storage"]) {
      expect((await admin.query<{ allowed: boolean }>(
        "SELECT has_table_privilege($1,'knowledge_page_changes','SELECT') AS allowed",
        [role],
      )).rows[0]?.allowed).toBe(false);
    }
    for (const role of [
      "context_use_auth",
      "context_use_dashboard",
      "context_use_mcp",
      "context_use_public",
      "context_use_confirmation",
      "context_use_storage",
      "context_use_backup",
    ]) {
      for (const privilege of ["INSERT", "UPDATE", "DELETE"]) {
        expect((await admin.query<{ allowed: boolean }>(
          "SELECT has_table_privilege($1,'knowledge_page_changes',$2) AS allowed",
          [role, privilege],
        )).rows[0]?.allowed).toBe(false);
      }
    }
  });

  test("only the dashboard can stage a permanent page deletion", async () => {
    expect((await admin.query<{ allowed: boolean }>(
      "SELECT has_any_column_privilege('context_use_dashboard','page_deletion_intents','INSERT') AS allowed",
    )).rows[0]?.allowed).toBe(true);
    for (const role of ["context_use_auth", "context_use_mcp", "context_use_public", "context_use_confirmation", "context_use_storage", "context_use_backup"]) {
      expect((await admin.query<{ allowed: boolean }>(
        "SELECT has_any_column_privilege($1,'page_deletion_intents','INSERT') AS allowed",
        [role],
      )).rows[0]?.allowed).toBe(false);
    }
    const pageId = randomUUID();
    const versionId = randomUUID();
    await admin.query("BEGIN");
    try {
      await admin.query(
        `INSERT INTO knowledge_pages(id,current_path,current_version_id,archived_at)
         VALUES ($1,'test/dashboard-deletion-intent',$2,now())`,
        [pageId, versionId],
      );
      await admin.query(
        `INSERT INTO knowledge_page_versions(
           id,page_id,version_number,path,title,summary,commit_message,actor_kind,actor_subject
         ) VALUES ($1,$2,1,'test/dashboard-deletion-intent','Delete','A page deletion fixture.','Create fixture','dashboard','owner')`,
        [versionId, pageId],
      );
      const insert = `INSERT INTO page_deletion_intents(
          id,page_id,expected_version_id,owner_user_id,session_id,expires_at
        ) VALUES ($1,$2,$3,'context-use-owner','session',now()+interval '5 minutes')`;
      await admin.query("SET LOCAL ROLE context_use_dashboard");
      await admin.query(insert, [randomUUID(), pageId, versionId]);
      await admin.query("RESET ROLE");
      await admin.query("SET LOCAL ROLE context_use_mcp");
      await expectDenied(insert, [randomUUID(), pageId, versionId]);
      await admin.query("RESET ROLE");
    } finally {
      await admin.query("ROLLBACK");
    }
  });

  test("only the passkey-confirmation role can authorize or claim a knowledge export", async () => {
    const functions = [
      "confirm_knowledge_export_intent(uuid,text,text,text,integer,integer)",
      "claim_knowledge_export_download(uuid,text,text)",
      "complete_knowledge_export_download(uuid,text,text)",
    ];
    for (const fn of functions) {
      for (const role of ["context_use_auth", "context_use_dashboard", "context_use_mcp", "context_use_public", "context_use_backup"]) {
        expect((await admin.query<{ allowed: boolean }>(
          "SELECT has_function_privilege($1,$2,'EXECUTE') AS allowed",
          [role, fn],
        )).rows[0]?.allowed).toBe(false);
      }
      expect((await admin.query<{ allowed: boolean }>(
        "SELECT has_function_privilege('context_use_confirmation',$1,'EXECUTE') AS allowed",
        [fn],
      )).rows[0]?.allowed).toBe(true);
    }
    for (const column of ["confirmed_at", "download_started_at", "download_completed_at", "reset_completed_at"]) {
      expect((await admin.query<{ allowed: boolean }>(
        "SELECT has_column_privilege('context_use_dashboard','knowledge_export_intents',$1,'INSERT') AS allowed",
        [column],
      )).rows[0]?.allowed).toBe(false);
      expect((await admin.query<{ allowed: boolean }>(
        "SELECT has_column_privilege('context_use_dashboard','knowledge_export_intents',$1,'UPDATE') AS allowed",
        [column],
      )).rows[0]?.allowed).toBe(false);
    }
    for (const table of ["knowledge_export_intents"]) {
      expect((await admin.query<{ allowed: boolean }>(
        "SELECT has_table_privilege('context_use_confirmation',$1,'SELECT') AS allowed",
        [table],
      )).rows[0]?.allowed).toBe(false);
      for (const role of ["context_use_auth", "context_use_mcp", "context_use_public"]) {
        expect((await admin.query<{ allowed: boolean }>(
          "SELECT has_table_privilege($1,$2,'SELECT') AS allowed",
          [role, table],
        )).rows[0]?.allowed).toBe(false);
      }
    }
    expect((await admin.query<{ allowed: boolean }>(
      "SELECT has_table_privilege('context_use_confirmation','publication_intents','SELECT') AS allowed",
    )).rows[0]?.allowed).toBe(false);
  });

  test("clearing knowledge is a dashboard-only capability", async () => {
    const clear = "clear_knowledge(uuid,text,text,uuid,text,integer,text,text,text,text,text,tsvector,text,text)";
    for (const role of ["context_use_auth", "context_use_confirmation", "context_use_mcp", "context_use_public", "context_use_backup"]) {
      expect((await admin.query<{ allowed: boolean }>(
        "SELECT has_function_privilege($1,$2,'EXECUTE') AS allowed", [role, clear],
      )).rows[0]?.allowed).toBe(false);
    }
    expect((await admin.query<{ allowed: boolean }>(
      "SELECT has_function_privilege('context_use_dashboard',$1,'EXECUTE') AS allowed", [clear],
    )).rows[0]?.allowed).toBe(true);
    for (const role of ["context_use_dashboard", "context_use_mcp"]) {
      expect((await admin.query<{ allowed: boolean }>(
        "SELECT has_table_privilege($1,'knowledge_page_versions','DELETE') AS allowed", [role],
      )).rows[0]?.allowed).toBe(false);
    }
  });

  test("service roles cannot create database objects or assume internal owner roles", async () => {
    const serviceRoles = [
      "context_use_auth",
      "context_use_corpus",
      "context_use_dashboard",
      "context_use_mcp",
      "context_use_public",
      "context_use_confirmation",
      "context_use_storage",
      "context_use_backup",
    ];
    for (const role of serviceRoles) {
      expect((await admin.query<{ allowed: boolean }>(
        "SELECT has_database_privilege($1,current_database(),'CONNECT') AS allowed",
        [role],
      )).rows[0]?.allowed).toBe(true);
      expect((await admin.query<{ allowed: boolean }>(
        "SELECT has_database_privilege($1,current_database(),'TEMPORARY') AS allowed",
        [role],
      )).rows[0]?.allowed).toBe(false);
      expect((await admin.query<{ allowed: boolean }>(
        "SELECT has_schema_privilege($1,'public','CREATE') AS allowed",
        [role],
      )).rows[0]?.allowed).toBe(false);
      for (const ownerRole of ["context_use_projection_owner", "context_use_boundary_owner", "context_use_reset_owner"]) {
        expect((await admin.query<{ allowed: boolean }>(
          "SELECT pg_has_role($1,$2,'MEMBER') AS allowed",
          [role, ownerRole],
        )).rows[0]?.allowed).toBe(false);
      }
    }

    const internalOwners = await admin.query<{
      rolname: string;
      rolcanlogin: boolean;
      rolsuper: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
      rolinherit: boolean;
      rolbypassrls: boolean;
    }>(
      `SELECT rolname,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolinherit,rolbypassrls
       FROM pg_roles
       WHERE rolname IN ('context_use_projection_owner','context_use_boundary_owner','context_use_reset_owner')
       ORDER BY rolname`,
    );
    expect(internalOwners.rows).toEqual([
      {
        rolname: "context_use_boundary_owner",
        rolcanlogin: false,
        rolsuper: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolinherit: false,
        rolbypassrls: false,
      },
      {
        rolname: "context_use_projection_owner",
        rolcanlogin: false,
        rolsuper: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolinherit: false,
        rolbypassrls: false,
      },
      {
        rolname: "context_use_reset_owner",
        rolcanlogin: false,
        rolsuper: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolinherit: false,
        rolbypassrls: false,
      },
    ]);
  });

  test("corpus preparation is isolated from the long-lived dashboard credential", async () => {
    const corpusRole = await admin.query<{
      rolcanlogin: boolean;
      rolsuper: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
      rolinherit: boolean;
      rolbypassrls: boolean;
    }>(
      `SELECT rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolinherit,rolbypassrls
       FROM pg_roles WHERE rolname='context_use_corpus'`,
    );
    expect(corpusRole.rows[0]).toEqual({
      // The migration creates a NOLOGIN role; the migrator provisions the
      // one-shot corpus credential only when DB_CORPUS_PASSWORD is supplied.
      rolcanlogin: true,
      rolsuper: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolinherit: true,
      rolbypassrls: false,
    });
    expect((await admin.query<{ allowed: boolean }>(
      "SELECT pg_has_role('context_use_corpus','context_use_dashboard','MEMBER') AS allowed",
    )).rows[0]?.allowed).toBe(true);
    expect((await admin.query<{ allowed: boolean }>(
      "SELECT pg_has_role('context_use_dashboard','context_use_corpus','MEMBER') AS allowed",
    )).rows[0]?.allowed).toBe(false);

    const ledgers = [
      "corpus_migration_runs",
      "corpus_migration_inventory",
      "corpus_directory_migration_plans",
      "corpus_page_migration_plans",
      "corpus_migration_automation_plans",
      "corpus_migration_completions",
      "operational_document_replacements",
    ];
    for (const relation of ledgers) {
      for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
        expect((await admin.query<{ allowed: boolean }>(
          "SELECT has_table_privilege('context_use_dashboard',$1,$2) AS allowed",
          [relation, privilege],
        )).rows[0]?.allowed).toBe(false);
      }
      expect((await admin.query<{ allowed: boolean }>(
        "SELECT has_table_privilege('context_use_corpus',$1,'SELECT') AS allowed",
        [relation],
      )).rows[0]?.allowed).toBe(true);
    }

    for (const fn of [
      "register_directory_hub_migration(uuid,uuid)",
      "render_corpus_public_directory_hub(uuid,uuid)",
      "replace_knowledge_revision_projections(uuid,uuid[])",
      "retarget_managed_operational_document(uuid,text,uuid[])",
    ]) {
      expect((await admin.query<{ allowed: boolean }>(
        "SELECT has_function_privilege('context_use_dashboard',$1,'EXECUTE') AS allowed",
        [fn],
      )).rows[0]?.allowed).toBe(false);
      expect((await admin.query<{ allowed: boolean }>(
        "SELECT has_function_privilege('context_use_corpus',$1,'EXECUTE') AS allowed",
        [fn],
      )).rows[0]?.allowed).toBe(true);
    }

    for (const [relation, column] of [
      ["public_projection_state", "generation"],
      ["published_page_artifacts", "body_object_key"],
      ["published_page_artifacts", "body_content_hash"],
    ]) {
      expect((await admin.query<{ allowed: boolean }>(
        "SELECT has_column_privilege('context_use_dashboard',$1,$2,'SELECT') AS allowed",
        [relation, column],
      )).rows[0]?.allowed).toBe(false);
      expect((await admin.query<{ allowed: boolean }>(
        "SELECT has_column_privilege('context_use_corpus',$1,$2,'SELECT') AS allowed",
        [relation, column],
      )).rows[0]?.allowed).toBe(true);
    }
  });

  test("pathless revision and catalog boundaries enforce their real service roles", async () => {
    const authoredDocumentId = randomUUID();
    const authoredRevisionId = randomUUID();
    const adoptedDocumentId = randomUUID();
    const adoptedRevisionId = randomUUID();
    const suffix = randomUUID().slice(0, 8);
    const body = "Role-bound pathless body";
    const bodyHash = createHash("sha256").update(body).digest("hex");
    const insertFixture = async (
      documentId: string,
      revisionId: string,
      path: string,
      title: string,
    ): Promise<void> => {
      await admin.query(
        "INSERT INTO hypermedia_documents(id,authority,representation) VALUES ($1,'knowledge','markdown')",
        [documentId],
      );
      await admin.query(
        `INSERT INTO hypermedia_document_revisions(
           id,document_id,revision_number,body_object_key,body_size_bytes,body_content_hash
         ) VALUES (
           $1::uuid,$2::uuid,1,
           'documents/private/'||($1::uuid)::text||'.md',$3,$4
         )`,
        [revisionId, documentId, Buffer.byteLength(body), bodyHash],
      );
      await admin.query(
        `INSERT INTO knowledge_pages(
           id,current_path,current_version_id,search_vector
         ) VALUES ($1,$2,$3,page_search_vector($2,$4,'Role fixture.',$5))`,
        [documentId, path, revisionId, title, body],
      );
      await admin.query(
        `INSERT INTO knowledge_page_versions(
           id,page_id,version_number,path,title,summary,commit_message,actor_kind,actor_subject
         ) VALUES ($1,$2,1,$3,$4,'Role fixture.','Create pathless role fixture','dashboard','owner')`,
        [revisionId, documentId, path, title],
      );
    };

    await admin.query("BEGIN");
    try {
      await admin.query("SET CONSTRAINTS ALL DEFERRED");
      await insertFixture(
        authoredDocumentId,
        authoredRevisionId,
        `tests/pathless-authored-${suffix}`,
        "Authored role boundary",
      );
      await insertFixture(
        adoptedDocumentId,
        adoptedRevisionId,
        `tests/pathless-adopted-${suffix}`,
        "Adopted role boundary",
      );

      await admin.query("SET LOCAL ROLE context_use_dashboard");
      expect((await admin.query(
        "SELECT register_generic_knowledge_revision($1,$2,'{}'::uuid[])",
        [authoredRevisionId, body],
      )).rowCount).toBe(1);
      expect((await admin.query(
        "SELECT 1 FROM private_document_catalog WHERE document_id=$1",
        [authoredDocumentId],
      )).rowCount).toBe(1);
      expect((await admin.query(
        `SELECT 1 FROM search_private_document_catalog(
           'Authored',NULL,NULL,NULL,false,10,NULL,NULL,'knowledge',NULL,NULL,NULL
         ) WHERE search_document_id=$1`,
        [authoredDocumentId],
      )).rowCount).toBe(1);
      await expectDenied("SELECT * FROM pathless_knowledge_search_chunks");
      await expectDenied(
        "SELECT adopt_generic_knowledge_revision($1,$2,$3,'{}'::uuid[],'corpus_migration')",
        [adoptedDocumentId, adoptedRevisionId, body],
      );
      await admin.query("RESET ROLE");

      await admin.query("SET LOCAL ROLE context_use_mcp");
      expect((await admin.query(
        "SELECT register_generic_knowledge_revision($1,$2,'{}'::uuid[])",
        [authoredRevisionId, body],
      )).rowCount).toBe(1);
      expect((await admin.query(
        "SELECT 1 FROM knowledge_revision_contracts WHERE revision_id=$1",
        [authoredRevisionId],
      )).rowCount).toBe(1);
      await expectDenied("SELECT * FROM pathless_knowledge_search_chunks");
      await admin.query("RESET ROLE");

      await admin.query("SET LOCAL ROLE context_use_corpus");
      expect((await admin.query(
        "SELECT adopt_generic_knowledge_revision($1,$2,$3,'{}'::uuid[],'corpus_migration')",
        [adoptedDocumentId, adoptedRevisionId, body],
      )).rowCount).toBe(1);
      await admin.query("RESET ROLE");

      await admin.query("SET LOCAL ROLE context_use_dashboard");
      await expectDenied("INSERT INTO knowledge_revision_contracts( revision_id,document_id,provenance,body_content_hash ) VALUES ($1,$2,'authored',$3)", [randomUUID(), authoredDocumentId, bodyHash]);
      await expectDenied(
        `SELECT * FROM search_private_document_catalog(
           repeat('x',2049),NULL,NULL,NULL,false,10,NULL,NULL,NULL,NULL,NULL,NULL
         )`,
      );
      await admin.query("RESET ROLE");

      for (const role of [
        "context_use_public",
        "context_use_storage",
        "context_use_confirmation",
      ]) {
        for (const relation of [
          "knowledge_revision_contracts",
          "pathless_knowledge_search",
          "pathless_knowledge_search_chunks",
          "private_document_catalog",
        ]) {
          expect((await admin.query<{ allowed: boolean }>(
            "SELECT has_table_privilege($1,$2,'SELECT') AS allowed",
            [role, relation],
          )).rows[0]?.allowed).toBe(false);
        }
        for (const fn of [
          "record_generic_knowledge_revision(uuid,uuid,text,uuid[],knowledge_revision_contract_provenance)",
          "register_generic_knowledge_revision(uuid,text,uuid[])",
          "adopt_generic_knowledge_revision(uuid,uuid,text,uuid[],knowledge_revision_contract_provenance)",
          "search_private_document_catalog(text,real,bigint,uuid,boolean,integer,hypermedia_document_authority,hypermedia_document_representation,private_document_kind,private_document_lifecycle,text,private_document_operational_role)",
        ]) {
          expect((await admin.query<{ allowed: boolean }>(
            "SELECT has_function_privilege($1,$2,'EXECUTE') AS allowed",
            [role, fn],
          )).rows[0]?.allowed).toBe(false);
        }
      }
    } finally {
      await admin.query("ROLLBACK");
    }
  });

  test("dashboard can register a private automation without reading corpus plans", async () => {
    const pageId = randomUUID();
    const versionId = randomUUID();
    const registrationId = randomUUID();
    const suffix = randomUUID().slice(0, 8);
    await admin.query("BEGIN");
    try {
      await admin.query("SET CONSTRAINTS ALL DEFERRED");
      await admin.query(
        `INSERT INTO knowledge_pages(id,current_path,current_version_id,search_vector)
         VALUES (
           $1,$2,$3,
           page_search_vector($2,'Automation instructions','Private automation instructions.','Test')
         )`,
        [pageId, `test/dashboard-automation-${suffix}`, versionId],
      );
      await admin.query(
         `INSERT INTO hypermedia_document_revisions(
           id,document_id,revision_number,body_object_key,body_size_bytes,body_content_hash
         ) VALUES (
           $1::uuid,$2::uuid,1,'documents/private/'||($1::uuid)::text||'.md',4,$3
         )`,
        [versionId, pageId, "532eaabd9574880dbf76b9b8cc00832c20a6ec113d6822995505d7a6e0f345e2"],
      );
      await admin.query(
        `INSERT INTO knowledge_page_versions(
           id,page_id,version_number,path,title,summary,commit_message,actor_kind,actor_subject
         ) VALUES (
           $1,$2,1,$3,'Automation instructions','Private automation instructions.',
           'Create dashboard registration fixture','dashboard','owner'
         )`,
        [versionId, pageId, `test/dashboard-automation-${suffix}`],
      );

      await admin.query("SET LOCAL ROLE context_use_dashboard");
      await admin.query(
        `INSERT INTO automation_registry(id,key,name,instructions_document_id)
         VALUES ($1,$2,'Dashboard automation',$3)`,
        [registrationId, `dashboard-${suffix}`, pageId],
      );
      expect((await admin.query(
        "SELECT 1 FROM automation_registry WHERE id=$1 AND instructions_document_id=$2",
        [registrationId, pageId],
      )).rowCount).toBe(1);
      await expectDenied("SELECT * FROM corpus_migration_automation_plans");
      await admin.query("RESET ROLE");
    } finally {
      await admin.query("ROLLBACK");
    }
  });

  test("views and privileged procedures have narrowly privileged non-login owners", async () => {
    const views = await admin.query<{ relname: string; owner: string }>(
      `SELECT relname,pg_get_userbyid(relowner) AS owner
       FROM pg_class
       WHERE relnamespace='public'::regnamespace
         AND relname IN (
           'published_page_sources','published_pages','published_directories','published_assets',
           'storage_published_assets'
         )
       ORDER BY relname`,
    );
    expect(views.rows).toEqual([
      { relname: "published_assets", owner: "context_use_projection_owner" },
      { relname: "published_directories", owner: "context_use_projection_owner" },
      { relname: "published_page_sources", owner: "context_use_projection_owner" },
      { relname: "published_pages", owner: "context_use_projection_owner" },
      { relname: "storage_published_assets", owner: "context_use_projection_owner" },
    ]);

    expect((await admin.query<{ allowed: boolean }>(
      "SELECT has_function_privilege('context_use_public','project_public_markdown(text)','EXECUTE') AS allowed",
    )).rows[0]?.allowed).toBe(false);
    for (const role of ["context_use_auth", "context_use_dashboard", "context_use_mcp", "context_use_confirmation", "context_use_storage", "context_use_backup"]) {
      expect((await admin.query<{ allowed: boolean }>(
        "SELECT has_function_privilege($1,'project_public_markdown(text)','EXECUTE') AS allowed",
        [role],
      )).rows[0]?.allowed).toBe(false);
    }

    const procedures = await admin.query<{ proname: string; owner: string; security_definer: boolean }>(
      `SELECT proname,pg_get_userbyid(proowner) AS owner,prosecdef AS security_definer
       FROM pg_proc
       WHERE pronamespace='public'::regnamespace
         AND proname IN (
           'issue_confirmation_challenge',
           'consume_confirmation_challenge',
           'confirm_publication_intent',
           'confirm_knowledge_export_intent',
           'confirm_page_deletion_intent',
           'claim_knowledge_export_download',
           'complete_knowledge_export_download',
           'clear_knowledge',
           'delete_empty_knowledge_directory',
           'lock_automation_registry_for_operational_retarget',
           'lock_corpus_migration_hub_apply_tables',
           'lock_corpus_migration_runs_for_operational_change',
           'prevent_automation_document_role_reuse',
           'prune_page_versions',
           'remove_owner_passkey',
           'project_public_markdown'
         )
       ORDER BY proname`,
    );
    expect(procedures.rows).toEqual([
      { proname: "claim_knowledge_export_download", owner: "context_use_boundary_owner", security_definer: true },
      { proname: "clear_knowledge", owner: "context_use_reset_owner", security_definer: true },
      { proname: "complete_knowledge_export_download", owner: "context_use_boundary_owner", security_definer: true },
      { proname: "confirm_knowledge_export_intent", owner: "context_use_boundary_owner", security_definer: true },
      { proname: "confirm_page_deletion_intent", owner: "context_use_boundary_owner", security_definer: true },
      { proname: "confirm_publication_intent", owner: "context_use_boundary_owner", security_definer: true },
      { proname: "consume_confirmation_challenge", owner: "context_use_boundary_owner", security_definer: true },
      { proname: "delete_empty_knowledge_directory", owner: "context_use_boundary_owner", security_definer: true },
      { proname: "issue_confirmation_challenge", owner: "context_use_boundary_owner", security_definer: true },
      { proname: "lock_automation_registry_for_operational_retarget", owner: "context_use_boundary_owner", security_definer: true },
      { proname: "lock_corpus_migration_hub_apply_tables", owner: "context_use_boundary_owner", security_definer: true },
      { proname: "lock_corpus_migration_runs_for_operational_change", owner: "context_use_boundary_owner", security_definer: true },
      { proname: "prevent_automation_document_role_reuse", owner: "context_use_boundary_owner", security_definer: true },
      { proname: "project_public_markdown", owner: "context_use_projection_owner", security_definer: true },
      { proname: "prune_page_versions", owner: "context_use_boundary_owner", security_definer: true },
      { proname: "remove_owner_passkey", owner: "context_use_boundary_owner", security_definer: true },
    ]);

    for (const [relation, column] of [
      ["knowledge_directories", "title"],
      ["knowledge_page_versions", "commit_message"],
      ["assets", "s3_object_key"],
    ]) {
      expect((await admin.query<{ allowed: boolean }>(
        "SELECT has_column_privilege('context_use_boundary_owner',$1,$2,'SELECT') AS allowed",
        [relation, column],
      )).rows[0]?.allowed).toBe(false);
    }
    for (const [relation, column] of [
      ["confirmation_challenges", "challenge"],
      ["knowledge_page_versions", "path"],
      ["knowledge_pages", "archived_at"],
      ["assets", "current_path"],
      ["knowledge_export_intents", "expires_at"],
      ["passkey", "counter"],
    ]) {
      expect((await admin.query<{ allowed: boolean }>(
        "SELECT has_column_privilege('context_use_boundary_owner',$1,$2,'SELECT') AS allowed",
        [relation, column],
      )).rows[0]?.allowed).toBe(true);
    }
  });

  test("pathless publication namespace boundaries are non-login owned and backup-readable", async () => {
    const views = await admin.query<{ relname: string; owner: string }>(
      `SELECT relname,pg_get_userbyid(relowner) AS owner
       FROM pg_class
       WHERE relnamespace='public'::regnamespace
         AND relname IN (
           'live_public_namespace_conflicts','blocking_public_namespace_conflicts'
         )
       ORDER BY relname`,
    );
    expect(views.rows).toEqual([
      { relname: "blocking_public_namespace_conflicts", owner: "context_use_projection_owner" },
      { relname: "live_public_namespace_conflicts", owner: "context_use_projection_owner" },
    ]);

    expect((await admin.query<{ rolcanlogin: boolean }>(
      `SELECT rolcanlogin FROM pg_roles
       WHERE rolname='context_use_publication_lock_owner'`,
    )).rows).toEqual([{ rolcanlogin: false }]);
    const routeLockHelpers = await admin.query<{
      proname: string;
      owner: string;
      security_definer: boolean;
    }>(
      `SELECT proname,pg_get_userbyid(proowner) AS owner,
         prosecdef AS security_definer
       FROM pg_proc
       WHERE pronamespace='public'::regnamespace
         AND proname IN (
           'lock_public_routing_audit_tables','lock_public_routing_apply_tables'
         )
       ORDER BY proname`,
    );
    expect(routeLockHelpers.rows).toEqual([
      {
        proname: "lock_public_routing_apply_tables",
        owner: "context_use_publication_lock_owner",
        security_definer: true,
      },
      {
        proname: "lock_public_routing_audit_tables",
        owner: "context_use_publication_lock_owner",
        security_definer: true,
      },
    ]);
    for (const helper of [
      "lock_public_routing_audit_tables()",
      "lock_public_routing_apply_tables()",
    ]) {
      expect((await admin.query<{ allowed: boolean }>(
        "SELECT has_function_privilege('context_use_boundary_owner',$1,'EXECUTE') AS allowed",
        [helper],
      )).rows[0]?.allowed).toBe(true);
      for (const role of [
        "context_use_dashboard",
        "context_use_mcp",
        "context_use_public",
        "context_use_storage",
        "context_use_confirmation",
        "context_use_corpus",
        "context_use_backup",
        "context_use_auth",
      ]) {
        expect((await admin.query<{ allowed: boolean }>(
          "SELECT has_function_privilege($1,$2,'EXECUTE') AS allowed",
          [role, helper],
        )).rows[0]?.allowed).toBe(false);
      }
    }

    const boundaryFunctions = [
      "assert_private_uuid_available",
      "assert_public_uuid_available",
      "guard_artifact_reservation_namespace",
      "guard_corpus_directory_plan_namespace",
      "guard_legacy_alias_namespace",
      "guard_private_uuid_columns",
      "guard_public_resource_identity",
      "invalidate_pathless_asset_publication_on_legacy_drift",
      "invalidate_pathless_hub_publication_on_mapping_drift",
      "invalidate_pathless_page_publication_on_legacy_drift",
      "lock_public_uuid_namespace",
      "protect_active_pathless_asset_publication",
      "protect_active_pathless_page_publication",
      "public_uuid_has_artifact_identity",
      "public_uuid_has_legacy_alias_token",
      "public_uuid_has_private_identity",
      "public_uuid_has_reserved_public_identity",
      "reconcile_deleted_public_namespace_conflicts",
      "reconcile_finished_operational_public_namespace_conflicts",
      "reconcile_planned_public_namespace_conflicts",
      "reconcile_superseded_public_namespace_conflicts",
      "reject_pending_pathless_publication_claim_challenge",
      "require_finalized_pathless_publication_object_claim",
      "reserve_legacy_page_artifact_identity",
      "reserve_public_artifact_identity",
      "guard_pathless_publication_object_claim_history",
      "validate_active_pathless_publication_pin",
    ];
    const functions = await admin.query<{ proname: string; owner: string; security_definer: boolean }>(
      `SELECT proname,pg_get_userbyid(proowner) AS owner,prosecdef AS security_definer
       FROM pg_proc
       WHERE pronamespace='public'::regnamespace AND proname=ANY($1::text[])
       ORDER BY proname`,
      [boundaryFunctions],
    );
    expect(functions.rows.map((row) => row.proname)).toEqual([...boundaryFunctions].sort());
    for (const fn of functions.rows) {
      expect(fn.owner).toBe("context_use_boundary_owner");
      expect(fn.security_definer).toBe(true);
    }
    for (const role of [
      "context_use_auth",
      "context_use_backup",
      "context_use_confirmation",
      "context_use_corpus",
      "context_use_dashboard",
      "context_use_mcp",
      "context_use_public",
      "context_use_storage",
    ]) {
      expect((await admin.query<{ allowed: boolean }>(
        `SELECT has_function_privilege(
           $1,'reconcile_deleted_public_namespace_conflicts()','EXECUTE'
         ) AS allowed`,
        [role],
      )).rows[0]?.allowed).toBe(false);
    }
    const canonicalHelpers = await admin.query<{ proname: string; owner: string }>(
      `SELECT proname,pg_get_userbyid(proowner) AS owner
       FROM pg_proc
       WHERE pronamespace='public'::regnamespace
         AND proname IN ('canonical_legacy_alias_uuid','canonical_legacy_alias_kind')
       ORDER BY proname`,
    );
    expect(canonicalHelpers.rows).toEqual([
      { proname: "canonical_legacy_alias_kind", owner: "context_use_boundary_owner" },
      { proname: "canonical_legacy_alias_uuid", owner: "context_use_boundary_owner" },
    ]);

    expect((await admin.query<{ allowed: boolean }>(
      "SELECT has_table_privilege('context_use_boundary_owner','public_resources','UPDATE') AS allowed",
    )).rows[0]?.allowed).toBe(false);
    expect((await admin.query<{ allowed: boolean }>(
      "SELECT has_table_privilege('context_use_boundary_owner','public_route_aliases','UPDATE') AS allowed",
    )).rows[0]?.allowed).toBe(false);
    expect((await admin.query<{ allowed: boolean }>(
      `SELECT has_column_privilege(
         'context_use_boundary_owner','public_resources','document_id','UPDATE'
       ) AS allowed`,
    )).rows[0]?.allowed).toBe(true);
    for (const column of ["public_id", "original_document_id", "resource_kind"]) {
      expect((await admin.query<{ allowed: boolean }>(
        `SELECT has_column_privilege(
           'context_use_boundary_owner','public_resources',$1,'UPDATE'
         ) AS allowed`,
        [column],
      )).rows[0]?.allowed).toBe(false);
    }

    const durableRelations = [
      "asset_publications",
      "blocking_public_namespace_conflicts",
      "live_public_namespace_conflicts",
      "page_publications",
      "pathless_publication_adoptions",
      "pathless_publication_artifact_staging",
      "pathless_publication_intents",
      "pathless_publication_object_claims",
      "pathless_publication_settings",
      "public_artifact_id_reservations",
      "public_asset_artifacts",
      "public_namespace_conflicts",
      "public_page_artifacts",
    ];
    for (const relation of durableRelations) {
      expect((await admin.query<{ allowed: boolean }>(
        "SELECT has_table_privilege('context_use_backup',$1,'SELECT') AS allowed",
        [relation],
      )).rows[0]?.allowed).toBe(true);
    }

    const storageClaimFunctions = [
      "claim_pathless_publication_artifact(uuid,uuid)",
      "claim_pathless_publication_adoption_artifact(uuid,uuid)",
      "finalize_pathless_publication_artifact_claim(uuid,uuid,publication_target,bigint,text,text,text,timestamp with time zone,text,text,integer,integer,text,uuid[],uuid[],text)",
      "finalize_pathless_publication_adoption_claim(uuid,uuid,pathless_publication_adoption_kind,bigint,text,text,text,timestamp with time zone,text,text,integer,integer,text,uuid[],uuid[],text)",
    ];
    for (const fn of storageClaimFunctions) {
      expect((await admin.query<{ owner: string; security_definer: boolean }>(
        `SELECT pg_get_userbyid(proowner) AS owner,prosecdef AS security_definer
         FROM pg_proc WHERE oid=$1::regprocedure`,
        [fn],
      )).rows[0]).toEqual({
        owner: "context_use_pathless_storage_owner",
        security_definer: true,
      });
      expect((await admin.query<{ allowed: boolean }>(
        "SELECT has_function_privilege('context_use_storage',$1,'EXECUTE') AS allowed",
        [fn],
      )).rows[0]?.allowed).toBe(true);
      for (const role of [
        "context_use_auth", "context_use_backup", "context_use_confirmation",
        "context_use_corpus", "context_use_dashboard", "context_use_mcp",
        "context_use_public",
      ]) {
        expect((await admin.query<{ allowed: boolean }>(
          "SELECT has_function_privilege($1,$2,'EXECUTE') AS allowed",
          [role, fn],
        )).rows[0]?.allowed).toBe(false);
      }
    }

    const allocator = "reserve_public_artifact_identity(uuid,text,public_artifact_allocation_kind,uuid)";
    for (const role of [
      "context_use_auth",
      "context_use_backup",
      "context_use_confirmation",
      "context_use_corpus",
      "context_use_dashboard",
      "context_use_mcp",
      "context_use_public",
      "context_use_storage",
    ]) {
      expect((await admin.query<{ allowed: boolean }>(
        "SELECT has_function_privilege($1,$2,'EXECUTE') AS allowed",
        [role, allocator],
      )).rows[0]?.allowed).toBe(false);
    }

    const resetSignature = "clear_knowledge(uuid,text,text,uuid,text,integer,text,text,text,text,text,tsvector,text,text)";
    const legacyResetSignature = "clear_knowledge_legacy_implementation(uuid,text,text,uuid,text,integer,text,text,text,text,text,tsvector,text,text)";
    expect((await admin.query<{ allowed: boolean }>(
      "SELECT has_function_privilege('context_use_dashboard',$1,'EXECUTE') AS allowed",
      [resetSignature],
    )).rows[0]?.allowed).toBe(true);
    for (const role of ["context_use_dashboard", "context_use_mcp", "context_use_confirmation", "context_use_backup"]) {
      expect((await admin.query<{ allowed: boolean }>(
        "SELECT has_function_privilege($1,$2,'EXECUTE') AS allowed",
        [role, legacyResetSignature],
      )).rows[0]?.allowed).toBe(false);
    }
  });

  test("dashboard and MCP can invoke only the guarded directory deletion capability", async () => {
    for (const role of ["context_use_dashboard", "context_use_mcp"]) {
      expect((await admin.query<{ allowed: boolean }>(
        "SELECT has_table_privilege($1,'knowledge_directories','DELETE') AS allowed",
        [role],
      )).rows[0]?.allowed).toBe(false);
      expect((await admin.query<{ allowed: boolean }>(
        "SELECT has_function_privilege($1,'delete_empty_knowledge_directory(uuid,integer)','EXECUTE') AS allowed",
        [role],
      )).rows[0]?.allowed).toBe(true);

      const id = randomUUID();
      const path = `tests/guarded-delete-${role.replace("context_use_", "")}-${id.slice(0, 8)}`;
      await admin.query("BEGIN");
      try {
        await admin.query(
          `INSERT INTO knowledge_directories(id,current_path,title,summary,search_vector)
           VALUES ($1,$2,'Guarded delete','',directory_search_vector($2,'Guarded delete','',''))`,
          [id, path],
        );
        await admin.query(`SET LOCAL ROLE ${role}`);
        await expectDenied("DELETE FROM knowledge_directories WHERE id=$1", [id]);
        const result = await admin.query<{ result: { status: string; id: string } }>(
          "SELECT delete_empty_knowledge_directory($1,1) AS result",
          [id],
        );
        expect(result.rows[0]?.result).toMatchObject({ status: "deleted", id });
        await admin.query("RESET ROLE");
        await admin.query("COMMIT");
      } catch (error) {
        await admin.query("ROLLBACK");
        throw error;
      }
      expect((await admin.query("SELECT 1 FROM knowledge_directories WHERE id=$1", [id])).rowCount).toBe(0);
    }

    for (const role of ["context_use_auth", "context_use_public", "context_use_confirmation", "context_use_storage", "context_use_backup"]) {
      expect((await admin.query<{ allowed: boolean }>(
        "SELECT has_function_privilege($1,'delete_empty_knowledge_directory(uuid,integer)','EXECUTE') AS allowed",
        [role],
      )).rows[0]?.allowed).toBe(false);
    }
  });

  test("passkey procedures reject null principals and credentials", async () => {
    const exportIntentId = randomUUID();
    await admin.query("BEGIN");
    try {
      await ensureOwnerPasskey();
      await admin.query(
        `INSERT INTO knowledge_export_intents(
           id,owner_user_id,session_id,expires_at
         ) VALUES ($1,'context-use-owner','session',now()+interval '5 minutes')`,
        [exportIntentId],
      );
      await issueChallenge("knowledge_export", exportIntentId);
      await admin.query("SET LOCAL ROLE context_use_confirmation");
      await expectDenied(
        "SELECT confirm_knowledge_export_intent($1,NULL,'session','test-credential',0,1)",
        [exportIntentId],
      );
      await expectDenied(
        "SELECT confirm_knowledge_export_intent($1,'context-use-owner',NULL,'test-credential',0,1)",
        [exportIntentId],
      );
      await expectDenied(
        "SELECT confirm_knowledge_export_intent($1,'context-use-owner','session',NULL,0,1)",
        [exportIntentId],
      );
      await admin.query(
        "SELECT confirm_knowledge_export_intent($1,'context-use-owner','session','test-credential',0,1)",
        [exportIntentId],
      );
      await expectDenied(
        "SELECT claim_knowledge_export_download($1,NULL,'session')",
        [exportIntentId],
      );
      await expectDenied(
        "SELECT claim_knowledge_export_download($1,'context-use-owner',NULL)",
        [exportIntentId],
      );
      await admin.query("RESET ROLE");
    } finally {
      await admin.query("ROLLBACK");
    }
  });

  test("intent constraints enforce the owner and five-minute lifetime", async () => {
    await admin.query("BEGIN");
    try {
      await expectDenied(
        `INSERT INTO knowledge_export_intents(
           id,owner_user_id,session_id,expires_at
         ) VALUES ($1,'not-the-owner','session',now()+interval '5 minutes')`,
        [randomUUID()],
      );
      const pageId = randomUUID();
      const versionId = randomUUID();
      await admin.query(
        `INSERT INTO knowledge_pages(id,current_path,current_version_id,archived_at)
         VALUES ($1,'test/deletion-intent-constraints',$2,now())`,
        [pageId, versionId],
      );
      await admin.query(
        `INSERT INTO knowledge_page_versions(
           id,page_id,version_number,path,title,summary,commit_message,actor_kind,actor_subject
         ) VALUES ($1,$2,1,'test/deletion-intent-constraints','Delete','A deletion constraint fixture.','Create fixture','dashboard','owner')`,
        [versionId, pageId],
      );
      await expectDenied(
        `INSERT INTO page_deletion_intents(
           id,page_id,expected_version_id,owner_user_id,session_id,expires_at
         ) VALUES ($1,$2,$3,'not-the-owner','session',now()+interval '5 minutes')`,
        [randomUUID(), pageId, versionId],
      );
      await expectDenied(
        `INSERT INTO page_deletion_intents(
           id,page_id,expected_version_id,owner_user_id,session_id,expires_at
         ) VALUES ($1,$2,$3,'context-use-owner','session',now()+interval '5 minutes 1 second')`,
        [randomUUID(), pageId, versionId],
      );
      await expectDenied(
        `INSERT INTO knowledge_export_intents(
           id,owner_user_id,session_id,expires_at
         ) VALUES ($1,'context-use-owner','session',now()+interval '5 minutes 1 second')`,
        [randomUUID()],
      );
    } finally {
      await admin.query("ROLLBACK");
    }
  });

  test("only passkey confirmation can permanently delete an archived page and its versions", async () => {
    const pageId = randomUUID();
    const firstVersionId = randomUUID();
    const currentVersionId = randomUUID();
    const intentId = randomUUID();
    await admin.query("BEGIN");
    try {
      await ensureOwnerPasskey();
      await admin.query(
        `INSERT INTO knowledge_pages(id,current_path,current_version_id,archived_at)
         VALUES ($1,'test/permanent-page-deletion',$2,now())`,
        [pageId, currentVersionId],
      );
      await admin.query(
        `INSERT INTO knowledge_page_versions(
           id,page_id,version_number,path,title,summary,commit_message,actor_kind,actor_subject
         ) VALUES
           ($1,$3,1,'test/permanent-page-deletion','Delete me','A permanently deleted page fixture.','Create fixture','dashboard','owner'),
           ($2,$3,2,'test/permanent-page-deletion','Delete me','A permanently deleted page fixture.','Archive fixture','dashboard','owner')`,
        [firstVersionId, currentVersionId, pageId],
      );
      await admin.query(
        `INSERT INTO page_deletion_intents(
           id,page_id,expected_version_id,owner_user_id,session_id,expires_at
         ) VALUES ($1,$2,$3,'context-use-owner','session',now()+interval '5 minutes')`,
        [intentId, pageId, currentVersionId],
      );

      for (const role of ["context_use_dashboard", "context_use_mcp"]) {
        await admin.query(`SET LOCAL ROLE ${role}`);
        await expectDenied("DELETE FROM knowledge_page_versions WHERE page_id=$1", [pageId]);
        await expectDenied("DELETE FROM knowledge_pages WHERE id=$1", [pageId]);
        await expectDenied(
          "SELECT confirm_page_deletion_intent($1,'context-use-owner','session','test-credential',0,1)",
          [intentId],
        );
        await admin.query("RESET ROLE");
      }

      await issueChallenge("page_deletion", intentId);
      await admin.query("SET LOCAL ROLE context_use_confirmation");
      await admin.query(
        "SELECT confirm_page_deletion_intent($1,'context-use-owner','session','test-credential',0,1)",
        [intentId],
      );
      await admin.query("RESET ROLE");

      expect((await admin.query("SELECT 1 FROM knowledge_pages WHERE id=$1", [pageId])).rowCount).toBe(0);
      expect((await admin.query("SELECT 1 FROM knowledge_page_versions WHERE page_id=$1", [pageId])).rowCount).toBe(0);
      expect((await admin.query("SELECT 1 FROM page_deletion_intents WHERE id=$1", [intentId])).rowCount).toBe(0);
      expect((await admin.query("SELECT counter FROM passkey WHERE id='test-passkey'")).rows[0]?.counter).toBe(1);
      expect((await admin.query<{ change_kind: string; path: string }>(
        `SELECT change_kind,path FROM knowledge_page_changes
         WHERE page_id=$1 AND change_kind='deleted'`,
        [pageId],
      )).rows).toEqual([{ change_kind: "deleted", path: "test/permanent-page-deletion" }]);
    } finally {
      await admin.query("ROLLBACK");
    }
  });

  test("the private guide body is represented only by immutable object metadata", async () => {
    expect((await admin.query(
      "SELECT 1 FROM knowledge_pages WHERE current_path='about/intro'",
    )).rowCount).toBe(0);
    expect((await admin.query(
      `SELECT 1
       FROM knowledge_pages page
       JOIN knowledge_page_versions version ON version.id=page.current_version_id
       WHERE page.current_path='agents' AND page.archived_at IS NULL
         AND version.title='AGENTS.md'
         AND EXISTS (
           SELECT 1 FROM hypermedia_document_revisions object
           WHERE object.id=version.id AND object.document_id=page.id
         )`,
    )).rowCount).toBe(1);
  });

  test("the root AGENTS.md page cannot be moved, archived, or permanently deleted", async () => {
    const guide = await admin.query<{ id: string }>(
      "SELECT id FROM knowledge_pages WHERE current_path='agents'",
    );
    const guideId = guide.rows[0]!.id;
    await admin.query("BEGIN");
    try {
      for (const role of ["context_use_dashboard", "context_use_mcp"]) {
        await admin.query(`SET LOCAL ROLE ${role}`);
        await expectDenied(
          "UPDATE knowledge_pages SET current_path='test/moved-root-guide' WHERE id=$1",
          [guideId],
        );
        await expectDenied(
          "UPDATE knowledge_pages SET archived_at=now() WHERE id=$1",
          [guideId],
        );
        await admin.query("RESET ROLE");
      }
      await admin.query("SET LOCAL ROLE context_use_boundary_owner");
      await expectDenied("DELETE FROM knowledge_pages WHERE id=$1", [guideId]);
      await admin.query("RESET ROLE");
    } finally {
      await admin.query("ROLLBACK");
    }
  });

  test("public role can see publication views but not private base tables", async () => {
    for (const relation of ["knowledge_directories", "knowledge_pages", "assets"]) {
      const result = await admin.query<{ allowed: boolean }>(
        "SELECT has_table_privilege('context_use_public', $1, 'SELECT') AS allowed",
        [relation],
      );
      expect(result.rows[0]?.allowed).toBe(false);
    }
    for (const relation of ["published_pages", "published_directories", "published_assets"]) {
      const result = await admin.query<{ allowed: boolean }>(
        "SELECT has_table_privilege('context_use_public', $1, 'SELECT') AS allowed",
        [relation],
      );
      expect(result.rows[0]?.allowed).toBe(true);
    }
    for (const relation of ["published_page_sources", "storage_published_assets"]) {
      expect((await admin.query<{ allowed: boolean }>(
        "SELECT has_table_privilege('context_use_public',$1,'SELECT') AS allowed",
        [relation],
      )).rows[0]?.allowed).toBe(false);
    }
    const publicPageColumns = await admin.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema='public' AND table_name='published_pages'
       ORDER BY ordinal_position`,
    );
    expect(publicPageColumns.rows.map(({ column_name }) => column_name)).toEqual([
      "public_path", "title", "summary", "body_markdown", "last_edited_at",
    ]);
    const publicDirectoryColumns = await admin.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema='public' AND table_name='published_directories'
       ORDER BY ordinal_position`,
    );
    expect(publicDirectoryColumns.rows.map(({ column_name }) => column_name)).toEqual([
      "path", "title", "summary",
    ]);
    const publicAssetColumns = await admin.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema='public' AND table_name='published_assets'
       ORDER BY ordinal_position`,
    );
    expect(publicAssetColumns.rows.map(({ column_name }) => column_name)).toEqual([
      "public_path", "filename", "content_type", "size_bytes",
    ]);
  });

  test("storage role can reconcile private objects without granting that access to public services", async () => {
    for (const column of [
      "id", "s3_object_key", "filename", "content_type", "size_bytes", "content_hash", "deleted_at",
    ]) {
      expect((await admin.query<{ allowed: boolean }>(
        "SELECT has_column_privilege('context_use_storage','assets',$1,'SELECT') AS allowed",
        [column],
      )).rows[0]?.allowed).toBe(true);
    }
    for (const relation of ["knowledge_directories", "knowledge_pages", "knowledge_page_versions"]) {
      expect((await admin.query<{ allowed: boolean }>(
        "SELECT has_table_privilege('context_use_storage',$1,'SELECT') AS allowed",
        [relation],
      )).rows[0]?.allowed).toBe(false);
    }
    for (const [relation, columns] of [
      ["knowledge_directories", ["id", "current_path"]],
      ["knowledge_pages", ["id", "published_version_id", "public_path", "archived_at", "created_at", "updated_at"]],
      ["knowledge_page_versions", ["id", "page_id", "version_number", "path", "title", "summary", "created_at"]],
    ] as const) {
      for (const column of columns) {
        expect((await admin.query<{ allowed: boolean }>(
          "SELECT has_column_privilege('context_use_storage',$1,$2,'SELECT') AS allowed",
          [relation, column],
        )).rows[0]?.allowed).toBe(true);
      }
    }
    expect((await admin.query<{ allowed: boolean }>(
      "SELECT has_table_privilege('context_use_storage','assets','SELECT') AS allowed",
    )).rows[0]?.allowed).toBe(false);
    expect((await admin.query<{ allowed: boolean }>(
      "SELECT has_table_privilege('context_use_storage','storage_published_assets','SELECT') AS allowed",
    )).rows[0]?.allowed).toBe(true);
    expect((await admin.query<{ allowed: boolean }>(
      "SELECT has_table_privilege('context_use_storage','storage_published_pages','SELECT') AS allowed",
    )).rows[0]?.allowed).toBe(true);
    expect((await admin.query<{ allowed: boolean }>(
      "SELECT has_table_privilege('context_use_storage','hypermedia_document_revisions','UPDATE') AS allowed",
    )).rows[0]?.allowed).toBe(false);
    expect((await admin.query<{ allowed: boolean }>(
      "SELECT has_table_privilege('context_use_storage','published_assets','SELECT') AS allowed",
    )).rows[0]?.allowed).toBe(false);
    for (const privilege of ["INSERT", "UPDATE", "DELETE"]) {
      expect((await admin.query<{ allowed: boolean }>(
        "SELECT has_table_privilege('context_use_storage','assets',$1) AS allowed",
        [privilege],
      )).rows[0]?.allowed).toBe(false);
    }
    for (const relation of ["knowledge_pages", "knowledge_directories"]) {
      expect((await admin.query<{ allowed: boolean }>(
        "SELECT has_table_privilege('context_use_public',$1,'SELECT') AS allowed",
        [relation],
      )).rows[0]?.allowed).toBe(false);
    }
  });

  test("ordinary knowledge writers cannot put Markdown back into PostgreSQL", async () => {
    expect((await admin.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name='knowledge_page_versions'
         AND column_name='body_markdown'`,
    )).rowCount).toBe(0);
  });

  test("published assets resolve by knowledge path while private assets stay absent", async () => {
    const publishedAssetId = randomUUID();
    const privateAssetId = randomUUID();
    const intentId = randomUUID();
    const suffix = randomUUID().slice(0, 8);
    const publishedPath = `tests/${suffix}/nested/public-asset`;
    const privatePath = `tests/${suffix}/nested/private-asset`;
    await admin.query("BEGIN");
    try {
      await ensureOwnerPasskey();
      await admin.query(
        `INSERT INTO assets(id,current_path,filename,content_type,size_bytes,content_hash,s3_object_key)
         VALUES
           ($1,$2,'public.png','image/png',1,$3,$4),
           ($5,$6,'private.png','image/png',1,$3,$7)`,
        [publishedAssetId, publishedPath, "a".repeat(64), `objects/${publishedAssetId}`, privateAssetId, privatePath, `objects/${privateAssetId}`],
      );
      await admin.query(
        `INSERT INTO publication_intents(
           id,action,target_kind,target_id,public_path,owner_user_id,session_id,
           expires_at
         ) VALUES ($1,'publish','asset',$2,$3,'context-use-owner','session',now()+interval '5 minutes')`,
        [intentId, publishedAssetId, publishedPath],
      );

      await admin.query("SET LOCAL ROLE context_use_public");
      const publicAssets = new PublicRepository(admin as unknown as Pool);
      expect(await publicAssets.assetByPublicPath(publishedPath)).toBeNull();
      expect(await publicAssets.assetByPublicPath(privatePath)).toBeNull();
      await admin.query("RESET ROLE");

      await issueChallenge("publication", intentId);
      await admin.query("SET LOCAL ROLE context_use_confirmation");
      await admin.query("SELECT confirm_publication_intent($1,'context-use-owner','session','test-credential',0,1)", [intentId]);
      await admin.query("RESET ROLE");

      await admin.query("SET LOCAL ROLE context_use_public");
      expect(await publicAssets.assetByPublicPath(publishedPath)).toMatchObject({
        public_path: publishedPath,
        filename: "public.png",
      });
      expect(await publicAssets.assetByPublicPath(privatePath)).toBeNull();
      await expectDenied("SELECT * FROM assets");
    } finally {
      await admin.query("ROLLBACK");
    }
  });

  test("service roles cannot archive or delete an object while it is published", async () => {
    const pageId = randomUUID();
    const versionId = randomUUID();
    const assetId = randomUUID();
    const suffix = randomUUID().slice(0, 8);
    await admin.query("BEGIN");
    try {
      await admin.query(
        `INSERT INTO knowledge_directories(id,current_path,title,summary,search_vector)
         VALUES ($1,$2,'Lifecycle fixture','A directory for publication lifecycle tests.',directory_search_vector($2,'Lifecycle fixture','A directory for publication lifecycle tests.',''))`,
        [randomUUID(), `tests/${suffix}`],
      );
      await admin.query(
        `INSERT INTO knowledge_pages(id,current_path,current_version_id,published_version_id,public_path)
         VALUES ($1,$2,$3,$3,$2)`,
        [pageId, `tests/${suffix}/published-page`, versionId],
      );
      await admin.query(
        `INSERT INTO knowledge_page_versions(
           id,page_id,version_number,path,title,summary,commit_message,actor_kind,actor_subject
         ) VALUES ($1,$2,1,$3,'Published lifecycle','A published lifecycle fixture.','Create','dashboard','owner')`,
        [versionId, pageId, `tests/${suffix}/published-page`],
      );
      await admin.query(
        `INSERT INTO assets(
           id,current_path,public_path,filename,content_type,size_bytes,
           content_hash,s3_object_key
         ) VALUES ($1,$2,$2,'published.txt','text/plain',1,$3,$4)`,
        [assetId, `tests/${suffix}/published-asset`, "b".repeat(64), `objects/${assetId}`],
      );

      for (const role of ["context_use_dashboard", "context_use_mcp"]) {
        await admin.query(`SET LOCAL ROLE ${role}`);
        await expectDenied("UPDATE knowledge_pages SET archived_at=now() WHERE id=$1", [pageId]);
        await admin.query("RESET ROLE");
      }
      await admin.query("SET LOCAL ROLE context_use_dashboard");
      await expectDenied("UPDATE assets SET deleted_at=now() WHERE id=$1", [assetId]);
      await admin.query("RESET ROLE");

      // Once the passkey-owned visibility fields have been cleared, ordinary
      // private lifecycle operations are valid again.
      await admin.query(
        "UPDATE knowledge_pages SET published_version_id=NULL,public_path=NULL WHERE id=$1",
        [pageId],
      );
      await admin.query(
        "UPDATE assets SET public_path=NULL WHERE id=$1",
        [assetId],
      );
      await admin.query("SET LOCAL ROLE context_use_dashboard");
      expect((await admin.query(
        "UPDATE knowledge_pages SET archived_at=now() WHERE id=$1",
        [pageId],
      )).rowCount).toBe(1);
      expect((await admin.query(
        "UPDATE assets SET deleted_at=now() WHERE id=$1",
        [assetId],
      )).rowCount).toBe(1);
      await admin.query("RESET ROLE");
    } finally {
      await admin.query("ROLLBACK");
    }
  });

  test("MCP can create and archive assets without editing immutable metadata or deleting rows", async () => {
    for (const column of ["id", "current_path", "filename", "content_type", "size_bytes", "content_hash", "s3_object_key", "width", "height", "duration_seconds"]) {
      expect((await admin.query<{ allowed: boolean }>(
        "SELECT has_column_privilege('context_use_mcp', 'assets', $1, 'INSERT') AS allowed",
        [column],
      )).rows[0]?.allowed).toBe(true);
    }
    for (const column of ["public_path", "deleted_at"]) {
      expect((await admin.query<{ allowed: boolean }>(
        "SELECT has_column_privilege('context_use_mcp', 'assets', $1, 'INSERT') AS allowed",
        [column],
      )).rows[0]?.allowed).toBe(false);
    }
    expect((await admin.query<{ allowed: boolean }>(
      "SELECT has_column_privilege('context_use_mcp', 'assets', 'deleted_at', 'UPDATE') AS allowed",
    )).rows[0]?.allowed).toBe(true);
    for (const column of ["current_path", "public_path", "filename", "content_type", "size_bytes", "content_hash", "s3_object_key"]) {
      expect((await admin.query<{ allowed: boolean }>(
        "SELECT has_column_privilege('context_use_mcp', 'assets', $1, 'UPDATE') AS allowed",
        [column],
      )).rows[0]?.allowed).toBe(false);
    }
    for (const privilege of ["UPDATE", "DELETE"]) {
      expect((await admin.query<{ allowed: boolean }>(
        "SELECT has_table_privilege('context_use_mcp', 'assets', $1) AS allowed",
        [privilege],
      )).rows[0]?.allowed).toBe(false);
    }
  });

  test("scheduler state is absent and automation instructions use ordinary private pages", async () => {
    const removed = await admin.query<{
      schedules: string | null;
      versions: string | null;
      runs: string | null;
      provenance_columns: string;
    }>(
      `SELECT
         to_regclass('cron_schedules')::text AS schedules,
         to_regclass('automation_versions')::text AS versions,
         to_regclass('automation_runs')::text AS runs,
         (
           SELECT count(*)::text
           FROM information_schema.columns
           WHERE table_schema='public'
             AND table_name='knowledge_pages'
             AND column_name='automation_id'
         ) AS provenance_columns`,
    );
    expect(removed.rows[0]).toEqual({
      schedules: null,
      versions: null,
      runs: null,
      provenance_columns: "0",
    });

    await admin.query("BEGIN");
    try {
      const pageId = randomUUID();
      const versionId = randomUUID();
      await admin.query("SET LOCAL ROLE context_use_mcp");
      await admin.query(
        `INSERT INTO knowledge_pages(id,current_path,current_version_id,search_vector)
         VALUES ($1,'automations/external-instructions',$2,page_search_vector(
           'automations/external-instructions','External automation instructions',
           'Instructions followed by an external automation harness.','Run externally.'
         ))`,
        [pageId, versionId],
      );
      await admin.query(
        `INSERT INTO hypermedia_document_revisions(
           id,document_id,revision_number,body_object_key,body_size_bytes,body_content_hash
         ) VALUES (
           $1::uuid,$2::uuid,1,'documents/private/'||$1::text||'.md',
           octet_length($3),encode(digest(convert_to($3,'UTF8'),'sha256'),'hex')
         )`,
        [versionId, pageId, "Run externally."],
      );
      await admin.query(
        `INSERT INTO knowledge_page_versions(
           id,page_id,version_number,path,title,summary,
           commit_message,actor_kind,actor_subject
         ) VALUES (
           $1,$2,1,'automations/external-instructions','External automation instructions',
           'Instructions followed by an external automation harness.',
           'Create external automation instructions','mcp','role-test'
         )`,
        [versionId, pageId],
      );
      await admin.query("SET CONSTRAINTS ALL IMMEDIATE");
      await admin.query("RESET ROLE");
    } finally {
      await admin.query("ROLLBACK");
    }

    expect((await admin.query<{ allowed: boolean }>(
      "SELECT has_any_column_privilege('context_use_mcp','publication_intents','INSERT') AS allowed",
    )).rows[0]?.allowed).toBe(false);
    expect((await admin.query<{ allowed: boolean }>(
      "SELECT has_any_column_privilege('context_use_dashboard','publication_intents','INSERT') AS allowed",
    )).rows[0]?.allowed).toBe(true);
  });

  test("application-level knowledge restore is absent", async () => {
    const objects = await admin.query<{
      import_intents: string | null;
      confirm_import: string | null;
      restore_import: string | null;
      restore_owner: string | null;
      export_kind: string | null;
    }>(
      `SELECT
         to_regclass('knowledge_import_intents')::text AS import_intents,
         to_regprocedure('confirm_knowledge_import_intent(uuid,text,text,text,integer,integer)')::text AS confirm_import,
         to_regprocedure('restore_knowledge_import(uuid,text,text)')::text AS restore_import,
         (SELECT rolname FROM pg_roles WHERE rolname='context_use_restore_owner') AS restore_owner,
         (SELECT column_name FROM information_schema.columns
           WHERE table_schema='public' AND table_name='knowledge_export_intents'
             AND column_name='export_kind') AS export_kind`,
    );
    expect(objects.rows[0]).toEqual({
      import_intents: null,
      confirm_import: null,
      restore_import: null,
      restore_owner: null,
      export_kind: null,
    });
  });

  test("auth role cannot read knowledge tables", async () => {
    const result = await admin.query<{ allowed: boolean }>(
      "SELECT has_table_privilege('context_use_auth', 'knowledge_pages', 'SELECT') AS allowed",
    );
    expect(result.rows[0]?.allowed).toBe(false);
  });

  test("auth can advance replay state but cannot replace owner or passkey identity", async () => {
    await admin.query("BEGIN");
    try {
      await ensureOwnerPasskey();
      await admin.query("SET LOCAL ROLE context_use_auth");

      await admin.query("UPDATE passkey SET counter=1 WHERE id='test-passkey'");
      await admin.query("UPDATE \"user\" SET name='Updated owner' WHERE id='context-use-owner'");
      await expectDenied("UPDATE passkey SET counter=0 WHERE id='test-passkey'");
      await expectDenied("UPDATE passkey SET \"publicKey\"='attacker-key' WHERE id='test-passkey'");
      await expectDenied("UPDATE passkey SET \"credentialID\"='attacker-credential' WHERE id='test-passkey'");
      await expectDenied("UPDATE passkey SET \"userId\"='attacker' WHERE id='test-passkey'");
      await expectDenied("DELETE FROM passkey WHERE id='test-passkey'");
      await expectDenied("UPDATE \"user\" SET email='attacker@example.invalid' WHERE id='context-use-owner'");
      await expectDenied("UPDATE \"user\" SET \"emailVerified\"=false WHERE id='context-use-owner'");
      await expectDenied("DELETE FROM \"user\" WHERE id='context-use-owner'");
      await admin.query("RESET ROLE");

      expect((await admin.query(
        `SELECT "publicKey","credentialID","userId",counter
         FROM passkey WHERE id='test-passkey'`,
      )).rows[0]).toEqual({
        publicKey: "test-public-key",
        credentialID: "test-credential",
        userId: "context-use-owner",
        counter: 1,
      });
    } finally {
      await admin.query("ROLLBACK");
    }
  });

  test("auth can manage enrollment intents and invoke narrow passkey removal without direct deletion", async () => {
    expect((await admin.query<{ allowed: boolean }>(
      "SELECT has_table_privilege('context_use_auth','passkey_management_intents','SELECT,INSERT,UPDATE,DELETE') AS allowed",
    )).rows[0]?.allowed).toBe(true);
    expect((await admin.query<{ allowed: boolean }>(
      "SELECT has_function_privilege('context_use_auth','remove_owner_passkey(text,text)','EXECUTE') AS allowed",
    )).rows[0]?.allowed).toBe(true);
    expect((await admin.query<{ allowed: boolean }>(
      "SELECT has_table_privilege('context_use_auth','passkey','DELETE') AS allowed",
    )).rows[0]?.allowed).toBe(false);
    for (const role of ["context_use_dashboard", "context_use_mcp", "context_use_public", "context_use_confirmation", "context_use_storage"]) {
      expect((await admin.query<{ allowed: boolean }>(
        "SELECT has_table_privilege($1,'passkey_management_intents','SELECT,INSERT,UPDATE,DELETE') AS allowed",
        [role],
      )).rows[0]?.allowed).toBe(false);
    }
  });

  test("confirmation challenges are isolated, globally unique, and single-use", async () => {
    const sharedId = randomUUID();
    const pageId = randomUUID();
    const versionId = randomUUID();
    const publicationChallenge = challenge();
    const exportChallenge = challenge();
    await admin.query("BEGIN");
    try {
      await ensureOwnerPasskey();
      await admin.query(
        `INSERT INTO knowledge_pages(id,current_path,current_version_id)
         VALUES ($1,'test/challenge-isolation',$2)`,
        [pageId, versionId],
      );
      await admin.query(
        `INSERT INTO knowledge_page_versions(
           id,page_id,version_number,path,title,summary,commit_message,actor_kind,actor_subject
         ) VALUES (
           $1,$2,1,'test/challenge-isolation','Challenge isolation','A confirmation challenge isolation fixture.',
           'Create fixture','dashboard','owner'
         )`,
        [versionId, pageId],
      );
      await admin.query(
        `INSERT INTO publication_intents(
           id,action,target_kind,target_id,version_id,public_path,owner_user_id,
           session_id,expires_at
         ) VALUES (
           $1,'publish','page',$2,$3,'test/challenge-isolation',
           'context-use-owner','session',now()+interval '5 minutes'
         )`,
        [sharedId, pageId, versionId],
      );
      await admin.query(
        `INSERT INTO knowledge_export_intents(id,owner_user_id,session_id,expires_at)
         VALUES ($1,'context-use-owner','session',now()+interval '5 minutes')`,
        [sharedId],
      );

      await admin.query("SET LOCAL ROLE context_use_dashboard");
      await expectDenied(
        "SELECT issue_confirmation_challenge('publication',$1,$2)",
        [sharedId, publicationChallenge],
      );
      await expectDenied(
        "INSERT INTO confirmation_challenges(intent_kind,intent_id,challenge) VALUES ('publication',$1,$2)",
        [sharedId, publicationChallenge],
      );
      await admin.query("RESET ROLE");

      await issueChallenge("publication", sharedId, publicationChallenge);
      await admin.query("SET LOCAL ROLE context_use_confirmation");
      await expectDenied(
        "SELECT issue_confirmation_challenge('publication',$1,$2)",
        [sharedId, challenge()],
      );
      await expectDenied(
        "SELECT issue_confirmation_challenge('knowledge_export',$1,$2)",
        [sharedId, publicationChallenge],
      );
      await admin.query(
        "SELECT issue_confirmation_challenge('knowledge_export',$1,$2)",
        [sharedId, exportChallenge],
      );
      await expectDenied(
        "SELECT confirm_knowledge_export_intent($1,'context-use-owner','session','test-credential',99,100)",
        [sharedId],
      );
      await admin.query(
        "SELECT confirm_publication_intent($1,'context-use-owner','session','test-credential',0,1)",
        [sharedId],
      );
      await expectDenied(
        "SELECT confirm_publication_intent($1,'context-use-owner','session','test-credential',1,2)",
        [sharedId],
      );
      await expectDenied(
        "SELECT confirm_knowledge_export_intent($1,'context-use-owner','session','test-credential',0,1)",
        [sharedId],
      );
      await admin.query(
        "SELECT confirm_knowledge_export_intent($1,'context-use-owner','session','test-credential',1,2)",
        [sharedId],
      );
      await admin.query("RESET ROLE");

      expect((await admin.query(
        "SELECT 1 FROM confirmation_challenges WHERE intent_id=$1",
        [sharedId],
      )).rowCount).toBe(0);
      expect((await admin.query("SELECT counter FROM passkey WHERE id='test-passkey'")).rows[0]?.counter).toBe(2);
    } finally {
      await admin.query("ROLLBACK");
    }
  });

  test("audit history is not stored", async () => {
    const result = await admin.query<{ security_audit: string | null; publication_audit: string | null }>(
      `SELECT to_regclass('security_audit_events')::text AS security_audit,
              to_regclass('publication_events')::text AS publication_audit`,
    );
    expect(result.rows[0]).toEqual({ security_audit: null, publication_audit: null });
  });

  test("the anonymous public role is denied every private base table", async () => {
    const tables = await admin.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema='public' AND table_type='BASE TABLE'`,
    );
    for (const { table_name } of tables.rows) {
      const result = await admin.query<{ allowed: boolean }>(
        "SELECT has_table_privilege('context_use_public', format('%I', $1::text), 'SELECT') AS allowed",
        [table_name],
      );
      expect(result.rows[0]?.allowed).toBe(false);
    }
  });

  test("public webpage role sees only reconciled artifact metadata", async () => {
    const privatePageId = randomUUID();
    const privateVersionId = randomUUID();
    const parentPageId = randomUUID();
    const parentVersionId = randomUUID();
    const childPageId = randomUUID();
    const childVersionId = randomUUID();
    const privateAssetId = randomUUID();
    const publishedAssetId = randomUUID();
    await admin.query("BEGIN");
    try {
      const workDirectory = await admin.query<{ id: string }>(
        "SELECT id FROM knowledge_directories WHERE current_path='profile/work'",
      );
      await admin.query(
        `INSERT INTO knowledge_pages(id,current_path,current_version_id)
         VALUES ($1,'profile/private-work',$2)`,
        [privatePageId, privateVersionId],
      );
      await admin.query(
        `INSERT INTO knowledge_page_versions(
           id,page_id,version_number,path,title,summary,commit_message,actor_kind,actor_subject
         ) VALUES ($1,$2,1,'profile/private-work','PRIVATE-CANARY title','A private work fixture.','Create private page','dashboard','owner')`,
        [privateVersionId, privatePageId],
      );
      await admin.query(
        `INSERT INTO knowledge_pages(id,current_path,current_version_id,published_version_id,public_path)
         VALUES ($1,'profile-home',$2,$2,'profile')`,
        [parentPageId, parentVersionId],
      );
      await admin.query(
        `INSERT INTO knowledge_page_versions(
           id,page_id,version_number,path,title,summary,commit_message,actor_kind,actor_subject
         ) VALUES ($1,$2,1,'profile-home','Profile','A public profile fixture.','Create public parent','dashboard','owner')`,
        [parentVersionId, parentPageId],
      );
      await admin.query(
        `INSERT INTO knowledge_pages(id,current_path,current_version_id,published_version_id,public_path)
         VALUES ($1,'profile/work/project',$2,$2,'profile/work/project')`,
        [childPageId, childVersionId],
      );
      await admin.query(
        `INSERT INTO knowledge_page_versions(
           id,page_id,version_number,path,title,summary,commit_message,actor_kind,actor_subject
         ) VALUES (
           $1,$2,1,'profile/work/project','Project','A public project fixture.',
           'Create public child','dashboard','owner'
         )`,
        [childVersionId, childPageId],
      );
      await admin.query(
        `INSERT INTO assets(
           id,current_path,public_path,filename,content_type,size_bytes,
           content_hash,s3_object_key
         ) VALUES (
           $1,'media/public-image','media/public-image','public.png','image/png',1,
           $2,$3
         )`,
        [publishedAssetId, "a".repeat(64), `objects/${publishedAssetId}`],
      );
      const generation = (await admin.query<{ generation: string }>(
        "SELECT generation::text FROM public_projection_state WHERE singleton",
      )).rows[0]!.generation;
      for (const [pageId, versionId] of [
        [parentPageId, parentVersionId],
        [childPageId, childVersionId],
      ]) {
        const artifactId = randomUUID();
        await admin.query(
          `INSERT INTO published_page_artifacts(
             page_id,version_id,projection_generation,artifact_id,body_object_key,
             body_size_bytes,body_content_hash
           ) VALUES ($1,$2,$3,$4,$5,1,$6)`,
          [pageId, versionId, generation, artifactId,
            `documents/public/${artifactId}.md`, "a".repeat(64)],
        );
      }
      await admin.query(
        "UPDATE public_knowledge_settings SET entrypoint_page_id=$1 WHERE singleton",
        [parentPageId],
      );

      await admin.query("SET LOCAL ROLE context_use_public");
      const webpage = await admin.query<{
        public_path: string;
        title: string;
        summary: string;
        body_markdown: string;
        last_edited_at: Date;
      }>(
        "SELECT public_path,title,summary,body_markdown,last_edited_at FROM published_pages WHERE public_path='profile/work/project'",
      );
      const canProjectPrivateBodies = await admin.query<{ allowed: boolean }>(
        "SELECT has_function_privilege('context_use_public','project_public_markdown(text)','EXECUTE') AS allowed",
      );
      const publicKnowledge = new PublicRepository(admin as unknown as Pool);
      const siteSettings = await publicKnowledge.settings();
      const rootIndex = await publicKnowledge.directoryIndex("");
      const profileIndex = await publicKnowledge.directoryIndex("profile");
      const workIndex = await publicKnowledge.directoryIndex("profile/work");
      const missingIndex = await publicKnowledge.directoryIndex("profile/private");
      await admin.query("RESET ROLE");
      expect(Object.keys(webpage.rows[0]!).sort()).toEqual(["body_markdown", "last_edited_at", "public_path", "summary", "title"]);
      expect(webpage.rows[0]?.last_edited_at).toBeInstanceOf(Date);
      expect(webpage.rows[0]?.summary).toBe("A public project fixture.");
      expect(webpage.rows[0]?.body_markdown).toBeNull();
      expect(canProjectPrivateBodies.rows[0]?.allowed).toBe(false);
      expect(siteSettings).toEqual({ entrypoint_public_path: "profile" });
      expect(rootIndex?.entries).toContainEqual({
        kind: "directory",
        path: "profile",
        title: "Profile",
        summary: "Fixtures under profile.",
        published_count: 1,
        default_page_path: null,
      });
      expect(rootIndex?.title).toBe("Knowledge");
      expect(rootIndex?.summary).toBe("The root of the owner's private, progressively discoverable knowledge base.");
      expect(rootIndex?.default_page_path).toBeNull();
      expect(profileIndex).toEqual({
        path: "profile",
        title: "Profile",
        summary: "Fixtures under profile.",
        default_page_path: null,
        entries: [{
          kind: "directory",
          path: "profile/work",
          title: "Work",
          summary: "Fixtures under profile/work.",
          published_count: 1,
          default_page_path: "profile/work/project",
        }],
      });
      expect(workIndex?.title).toBe("Work");
      expect(workIndex?.summary).toBe("Fixtures under profile/work.");
      expect(workIndex?.default_page_path).toBe("profile/work/project");
      expect(workIndex?.entries).toEqual([{
        kind: "page",
        path: "profile/work/project",
        title: "Project",
        summary: "A public project fixture.",
        published_count: 1,
        default_page_path: null,
      }]);
      expect(missingIndex).toBeNull();
    } finally {
      await admin.query("ROLLBACK");
    }
  });

  test("publication procedure is the only successful private-to-public transition", async () => {
    const pageId = randomUUID();
    const versionId = randomUUID();
    const intentId = randomUUID();
    const mismatchedIntentId = randomUUID();
    await admin.query("BEGIN");
    try {
      await ensureOwnerPasskey();
      await admin.query(
        `INSERT INTO knowledge_pages(id,current_path,current_version_id) VALUES ($1,'test/security-boundary',$2)`,
        [pageId, versionId],
      );
      await admin.query(
        `INSERT INTO knowledge_page_versions(id,page_id,version_number,path,title,summary,commit_message,actor_kind,actor_subject)
         VALUES ($1,$2,1,'test/security-boundary','Boundary','A publication boundary fixture.','Create fixture','dashboard','test-owner')`,
        [versionId, pageId],
      );
      await admin.query(
        `INSERT INTO publication_intents(id,action,target_kind,target_id,version_id,public_path,owner_user_id,session_id,expires_at)
         VALUES ($1,'publish','page',$2,$3,'test/security-boundary','context-use-owner','session',now()+interval '5 minutes')`,
        [intentId, pageId, versionId],
      );
      await admin.query(
        `INSERT INTO publication_intents(id,action,target_kind,target_id,version_id,public_path,owner_user_id,session_id,expires_at)
         VALUES ($1,'publish','page',$2,$3,'test/forged-path','context-use-owner','session',now()+interval '5 minutes')`,
        [mismatchedIntentId, pageId, versionId],
      );

      for (const role of ["context_use_dashboard", "context_use_mcp"]) {
        await admin.query(`SET LOCAL ROLE ${role}`);
        await expectDenied("UPDATE knowledge_pages SET public_path='bypass' WHERE id=$1", [pageId]);
        await admin.query("RESET ROLE");
      }

      await issueChallenge("publication", intentId);
      await issueChallenge("publication", mismatchedIntentId);
      await admin.query("SET LOCAL ROLE context_use_confirmation");
      await expectDenied(
        "SELECT confirm_publication_intent($1,NULL,'session','test-credential',0,1)",
        [intentId],
      );
      await expectDenied(
        "SELECT confirm_publication_intent($1,'context-use-owner',NULL,'test-credential',0,1)",
        [intentId],
      );
      await expectDenied(
        "SELECT confirm_publication_intent($1,'context-use-owner','session',NULL,0,1)",
        [intentId],
      );
      await expectDenied(
        "SELECT confirm_publication_intent($1,'context-use-owner','session','test-credential',0,1)",
        [mismatchedIntentId],
      );
      await admin.query("SELECT confirm_publication_intent($1,'context-use-owner','session','test-credential',0,1)", [intentId]);
      await expectDenied("UPDATE knowledge_pages SET current_path='confirmation-cannot-edit' WHERE id=$1", [pageId]);
      await admin.query("RESET ROLE");

      const published = await admin.query("SELECT 1 FROM published_page_sources WHERE id=$1 AND published_version_id=$2", [pageId, versionId]);
      expect(published.rowCount).toBe(1);
      await expect(admin.query("SELECT confirm_publication_intent($1,'context-use-owner','session','test-credential',1,2)", [intentId])).rejects.toThrow();
    } finally {
      await admin.query("ROLLBACK");
    }
  });
});
