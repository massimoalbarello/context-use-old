import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client, Pool } from "pg";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { DocumentAssetRepository, KnowledgeDocumentRepository } from "../src/index.ts";
import { disposableDatabaseUrl } from "../src/disposable-database.ts";
import { MemoryMarkdownStore } from "./memory-markdown-store.ts";

const adminUrl = await disposableDatabaseUrl();
const describeDatabase = adminUrl ? describe : describe.skip;

describeDatabase("PostgreSQL security roles", () => {
  let admin: Client;

  beforeAll(async () => {
    admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    if (!(await admin.query(
      "SELECT 1 FROM knowledge_settings WHERE singleton AND global_guide_document_id IS NOT NULL",
    )).rowCount) {
      const pageId = randomUUID();
      const versionId = randomUUID();
      await admin.query("BEGIN");
      await admin.query("SET CONSTRAINTS ALL DEFERRED");
      await admin.query(
        `INSERT INTO knowledge_pages(id,current_version_id,search_vector)
         VALUES ($1,$2,''::tsvector)`,
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
           id,page_id,version_number,title,summary,commit_message,actor_kind,actor_subject
         ) VALUES ($1,$2,1,'AGENTS.md','Test root guide.','Create test guide','dashboard','context-use-template/default')`,
        [versionId, pageId],
      );
      await admin.query("COMMIT");
      await admin.query(
        "UPDATE knowledge_settings SET global_guide_document_id=$1,updated_at=now() WHERE singleton",
        [pageId],
      );
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

  test("the MCP role can update and archive ordinary knowledge through the checked writer", async () => {
    const mcpPool = new Pool({ connectionString: adminUrl, max: 1 });
    try {
      await mcpPool.query("SET ROLE context_use_mcp");
      const documents = new KnowledgeDocumentRepository(mcpPool, new MemoryMarkdownStore());
      const actor = { kind: "mcp" as const, subject: "role-test" };
      const created = await documents.create({
        title: "MCP checked writer",
        summary: "Exercises the operational-document lock as the real MCP role.",
        body_markdown: "Initial body.",
        commit_message: "Create MCP role fixture",
      }, actor);

      const updated = await documents.update(created.document_id, {
        title: "MCP checked writer",
        summary: "Exercises the operational-document lock as the real MCP role.",
        body_markdown: "Updated body.",
        commit_message: "Update through MCP role",
        expected_revision_number: 1,
      }, actor);
      expect(updated?.revision_number).toBe(2);

      const archived = await documents.archive(created.document_id, {
        commit_message: "Archive through MCP role",
        expected_revision_number: 2,
      }, actor);
      expect(archived?.revision_number).toBe(3);
      expect(archived?.archived_at).not.toBeNull();
    } finally {
      await mcpPool.end();
    }
  });

  test("full-text search indexes only the current page projection", async () => {
    const indexes = await admin.query<{ current_index: string | null }>(
      `SELECT to_regclass('knowledge_pages_search_idx')::text AS current_index`,
    );
    expect(indexes.rows[0]).toEqual({
      current_index: "knowledge_pages_search_idx",
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

  test("fresh hypermedia bootstrap allocations remain corpus-only and immutable", async () => {
    for (const signature of [
      "begin_hypermedia_bootstrap()",
      "complete_hypermedia_bootstrap()",
    ]) {
      expect((await admin.query<{ allowed: boolean }>(
        "SELECT has_function_privilege('context_use_corpus',$1,'EXECUTE') AS allowed",
        [signature],
      )).rows[0]?.allowed).toBe(true);
      const routine = (await admin.query<{ owner: string; security_definer: boolean }>(
        `SELECT pg_get_userbyid(proowner) AS owner,prosecdef AS security_definer
         FROM pg_proc WHERE oid=$1::regprocedure`,
        [signature],
      )).rows[0];
      expect(routine).toEqual({
        owner: "context_use_boundary_owner",
        security_definer: true,
      });
      for (const role of [
        "context_use_auth", "context_use_dashboard", "context_use_mcp",
        "context_use_public", "context_use_confirmation", "context_use_storage",
      ]) {
        expect((await admin.query<{ allowed: boolean }>(
          "SELECT has_function_privilege($1,$2,'EXECUTE') AS allowed",
          [role, signature],
        )).rows[0]?.allowed).toBe(false);
      }
    }
    for (const column of ["document_kind", "document_id", "revision_id"]) {
      expect((await admin.query<{ allowed: boolean }>(
        `SELECT has_column_privilege(
           'context_use_corpus','hypermedia_bootstrap_allocations',$1,'SELECT'
         ) AS allowed`,
        [column],
      )).rows[0]?.allowed).toBe(true);
    }
    for (const privilege of ["INSERT", "UPDATE", "DELETE"]) {
      expect((await admin.query<{ allowed: boolean }>(
        `SELECT has_table_privilege(
           'context_use_corpus','hypermedia_bootstrap_allocations',$1
         ) AS allowed`,
        [privilege],
      )).rows[0]?.allowed).toBe(false);
    }
    expect((await admin.query<{ allowed: boolean }>(
      `SELECT has_table_privilege(
         'context_use_backup','hypermedia_bootstrap_allocations','SELECT'
       ) AS allowed`,
    )).rows[0]?.allowed).toBe(true);
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
        `INSERT INTO knowledge_pages(id,current_version_id,archived_at)
         VALUES ($1,$2,now())`,
        [pageId, versionId],
      );
      await admin.query(
        `INSERT INTO knowledge_page_versions(
           id,page_id,version_number,title,summary,commit_message,actor_kind,actor_subject
         ) VALUES ($1,$2,1,'Delete','A page deletion fixture.','Create fixture','dashboard','owner')`,
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
    for (const column of ["confirmed_at", "download_started_at"]) {
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
  });

  test("the reset owner is inert", async () => {
    expect((await admin.query<{ allowed: boolean }>(
      "SELECT has_schema_privilege('context_use_reset_owner','public','USAGE') AS allowed",
    )).rows[0]?.allowed).toBe(false);
    expect((await admin.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM information_schema.role_table_grants
       WHERE grantee='context_use_reset_owner' AND table_schema='public'`,
    )).rows[0]?.count).toBe("0");
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

  test("hypermedia bootstrap is isolated from the long-lived dashboard credential", async () => {
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

    for (const fn of ["replace_knowledge_revision_projections(uuid,uuid[])"]) {
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
      ["retained_page_artifacts", "body_object_key"],
      ["retained_page_artifacts", "body_content_hash"],
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

  test("revision and catalog boundaries enforce their service roles", async () => {
    const authoredDocumentId = randomUUID();
    const authoredRevisionId = randomUUID();
    const body = "Role-bound document body";
    const bodyHash = createHash("sha256").update(body).digest("hex");
    const insertFixture = async (
      documentId: string,
      revisionId: string,
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
           id,current_version_id,search_vector
         ) VALUES ($1,$2,''::tsvector)`,
        [documentId, revisionId],
      );
      await admin.query(
        `INSERT INTO knowledge_page_versions(
           id,page_id,version_number,title,summary,commit_message,actor_kind,actor_subject
         ) VALUES ($1,$2,1,$3,'Role fixture.','Create role fixture','dashboard','owner')`,
        [revisionId, documentId, title],
      );
    };

    await admin.query("BEGIN");
    try {
      await admin.query("SET CONSTRAINTS ALL DEFERRED");
      await insertFixture(
        authoredDocumentId,
        authoredRevisionId,
        "Authored role boundary",
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
      await expectDenied("SELECT * FROM knowledge_search_chunks");
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
      await expectDenied("SELECT * FROM knowledge_search_chunks");
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
          "knowledge_search",
          "knowledge_search_chunks",
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

  test("dashboard can register a private automation without migration state", async () => {
    const pageId = randomUUID();
    const versionId = randomUUID();
    const registrationId = randomUUID();
    const suffix = randomUUID().slice(0, 8);
    await admin.query("BEGIN");
    try {
      await admin.query("SET CONSTRAINTS ALL DEFERRED");
      await admin.query(
        `INSERT INTO knowledge_pages(id,current_version_id,search_vector)
         VALUES ($1,$2,''::tsvector)`,
        [pageId, versionId],
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
           id,page_id,version_number,title,summary,commit_message,actor_kind,actor_subject
         ) VALUES (
           $1,$2,1,'Automation instructions','Private automation instructions.',
           'Create dashboard registration fixture','dashboard','owner'
         )`,
        [versionId, pageId],
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
         AND relname IN ('private_document_catalog')
       ORDER BY relname`,
    );
    expect(views.rows).toEqual([
      { relname: "private_document_catalog", owner: "context_use_projection_owner" },
    ]);

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
           'lock_automation_registry_for_operational_retarget',
           'prevent_automation_document_role_reuse',
           'prune_page_versions',
           'remove_owner_passkey'
         )
       ORDER BY proname`,
    );
    expect(procedures.rows).toEqual([
      { proname: "claim_knowledge_export_download", owner: "context_use_boundary_owner", security_definer: true },
      { proname: "confirm_knowledge_export_intent", owner: "context_use_boundary_owner", security_definer: true },
      { proname: "confirm_page_deletion_intent", owner: "context_use_boundary_owner", security_definer: true },
      { proname: "confirm_publication_intent", owner: "context_use_boundary_owner", security_definer: true },
      { proname: "consume_confirmation_challenge", owner: "context_use_boundary_owner", security_definer: true },
      { proname: "issue_confirmation_challenge", owner: "context_use_boundary_owner", security_definer: true },
      { proname: "lock_automation_registry_for_operational_retarget", owner: "context_use_boundary_owner", security_definer: true },
      { proname: "prevent_automation_document_role_reuse", owner: "context_use_boundary_owner", security_definer: true },
      { proname: "prune_page_versions", owner: "context_use_boundary_owner", security_definer: true },
      { proname: "remove_owner_passkey", owner: "context_use_boundary_owner", security_definer: true },
    ]);

    for (const [relation, column] of [
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
      ["knowledge_pages", "archived_at"],
      ["knowledge_export_intents", "expires_at"],
      ["passkey", "counter"],
    ]) {
      expect((await admin.query<{ allowed: boolean }>(
        "SELECT has_column_privilege('context_use_boundary_owner',$1,$2,'SELECT') AS allowed",
        [relation, column],
      )).rows[0]?.allowed).toBe(true);
    }
  });

  test("publication namespace boundaries are non-login owned and backup-readable", async () => {
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
      "guard_legacy_alias_namespace",
      "guard_private_uuid_columns",
      "guard_public_resource_identity",
      "lock_public_uuid_namespace",
      "protect_active_asset_publication",
      "protect_active_page_publication",
      "public_uuid_has_artifact_identity",
      "public_uuid_has_legacy_alias_token",
      "public_uuid_has_private_identity",
      "public_uuid_has_reserved_public_identity",
      "reject_pending_publication_claim_challenge",
      "require_finalized_publication_object_claim",
      "reserve_retained_page_artifact_identity",
      "reserve_public_artifact_identity",
      "guard_publication_object_claim_history",
      "validate_active_publication_pin",
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
    const dashboardStatus =
      "get_dashboard_publication_status(publication_target,uuid)";
    expect((await admin.query<{ owner: string; security_definer: boolean }>(
      `SELECT pg_get_userbyid(proowner) AS owner,prosecdef AS security_definer
       FROM pg_proc WHERE oid=$1::regprocedure`,
      [dashboardStatus],
    )).rows[0]).toEqual({
      owner: "context_use_boundary_owner",
      security_definer: true,
    });
    expect((await admin.query<{ allowed: boolean }>(
      "SELECT has_function_privilege('context_use_dashboard',$1,'EXECUTE') AS allowed",
      [dashboardStatus],
    )).rows[0]?.allowed).toBe(true);
    // Corpus deliberately inherits this read-only dashboard capability.
    expect((await admin.query<{ allowed: boolean }>(
      "SELECT has_function_privilege('context_use_corpus',$1,'EXECUTE') AS allowed",
      [dashboardStatus],
    )).rows[0]?.allowed).toBe(true);
    for (const role of [
      "context_use_auth",
      "context_use_backup",
      "context_use_confirmation",
      "context_use_mcp",
      "context_use_public",
      "context_use_storage",
    ]) {
      expect((await admin.query<{ allowed: boolean }>(
        "SELECT has_function_privilege($1,$2,'EXECUTE') AS allowed",
        [role, dashboardStatus],
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
      "publication_artifact_staging",
      "publication_intents",
      "publication_object_claims",
      "publication_settings",
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
      "claim_publication_artifact(uuid,uuid)",
      "finalize_publication_artifact_claim(uuid,uuid,publication_target,bigint,text,text,text,timestamp with time zone,text,text,integer,integer,text,uuid[],uuid[],text)",
    ];
    for (const fn of storageClaimFunctions) {
      expect((await admin.query<{ owner: string; security_definer: boolean }>(
        `SELECT pg_get_userbyid(proowner) AS owner,prosecdef AS security_definer
         FROM pg_proc WHERE oid=$1::regprocedure`,
        [fn],
      )).rows[0]).toEqual({
        owner: "context_use_storage_owner",
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
        `INSERT INTO knowledge_pages(id,current_version_id,archived_at)
         VALUES ($1,$2,now())`,
        [pageId, versionId],
      );
      await admin.query(
        `INSERT INTO knowledge_page_versions(
           id,page_id,version_number,title,summary,commit_message,actor_kind,actor_subject
         ) VALUES ($1,$2,1,'Delete','A deletion constraint fixture.','Create fixture','dashboard','owner')`,
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
        `INSERT INTO knowledge_pages(id,current_version_id,archived_at)
         VALUES ($1,$2,now())`,
        [pageId, currentVersionId],
      );
      await admin.query(
        `INSERT INTO knowledge_page_versions(
           id,page_id,version_number,title,summary,commit_message,actor_kind,actor_subject
         ) VALUES
           ($1,$3,1,'Delete me','A permanently deleted page fixture.','Create fixture','dashboard','owner'),
           ($2,$3,2,'Delete me','A permanently deleted page fixture.','Archive fixture','dashboard','owner')`,
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
      expect((await admin.query<{ change_kind: string }>(
        `SELECT change_kind FROM knowledge_page_changes
         WHERE page_id=$1 AND change_kind='deleted'`,
        [pageId],
      )).rows).toEqual([{ change_kind: "deleted" }]);
    } finally {
      await admin.query("ROLLBACK");
    }
  });

  test("the private guide body is represented only by immutable object metadata", async () => {
    expect((await admin.query(
      `SELECT 1
       FROM knowledge_settings settings
       JOIN knowledge_pages page ON page.id=settings.global_guide_document_id
       JOIN knowledge_page_versions version ON version.id=page.current_version_id
       WHERE settings.singleton AND page.archived_at IS NULL
         AND version.title='AGENTS.md'
         AND EXISTS (
           SELECT 1 FROM hypermedia_document_revisions object
           WHERE object.id=version.id AND object.document_id=page.id
         )`,
    )).rowCount).toBe(1);
  });

  test("public role can see only publication views, not private tables", async () => {
    for (const relation of ["knowledge_pages", "assets"]) {
      const result = await admin.query<{ allowed: boolean }>(
        "SELECT has_table_privilege('context_use_public', $1, 'SELECT') AS allowed",
        [relation],
      );
      expect(result.rows[0]?.allowed).toBe(false);
    }
    const retiredViews = await admin.query<{ relation: string | null }>(
      `SELECT to_regclass(name)::text AS relation
       FROM unnest(ARRAY[
         'published_pages','published_directories','published_assets',
         'published_site_settings','storage_published_pages','storage_published_assets'
       ]) AS name`,
    );
    expect(retiredViews.rows.every(({ relation }) => relation === null)).toBe(true);
    for (const relation of ["public_pages", "public_assets"]) {
      expect((await admin.query<{ allowed: boolean }>(
        "SELECT has_table_privilege('context_use_public',$1,'SELECT') AS allowed",
        [relation],
      )).rows[0]?.allowed).toBe(true);
    }
    expect((await admin.query<{ relation: string | null }>(
      "SELECT to_regclass('public.published_page_sources')::text AS relation",
    )).rows[0]?.relation).toBeNull();
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
    for (const relation of ["knowledge_pages", "knowledge_page_versions"]) {
      expect((await admin.query<{ allowed: boolean }>(
        "SELECT has_table_privilege('context_use_storage',$1,'SELECT') AS allowed",
        [relation],
      )).rows[0]?.allowed).toBe(false);
    }
    for (const [relation, columns] of [
      ["knowledge_pages", ["id", "current_version_id", "archived_at", "created_at", "updated_at"]],
      ["knowledge_page_versions", ["id", "page_id", "version_number", "title", "summary", "created_at"]],
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
      "SELECT has_table_privilege('context_use_storage','public_resources','SELECT') AS allowed",
    )).rows[0]?.allowed).toBe(false);
    expect((await admin.query<{ allowed: boolean }>(
      "SELECT has_table_privilege('context_use_storage','hypermedia_document_revisions','UPDATE') AS allowed",
    )).rows[0]?.allowed).toBe(false);
    for (const privilege of ["INSERT", "UPDATE", "DELETE"]) {
      expect((await admin.query<{ allowed: boolean }>(
        "SELECT has_table_privilege('context_use_storage','assets',$1) AS allowed",
        [privilege],
      )).rows[0]?.allowed).toBe(false);
    }
    for (const relation of ["knowledge_pages"]) {
      expect((await admin.query<{ allowed: boolean }>(
        "SELECT has_table_privilege('context_use_public',$1,'SELECT') AS allowed",
        [relation],
      )).rows[0]?.allowed).toBe(false);
    }
  });

  test("storage role can authorize a canonical private asset write", async () => {
    const assetId = randomUUID();
    const objectKey = `objects/${assetId}`;
    const contentHash = createHash("sha256").update("storage").digest("hex");
    await admin.query("BEGIN");
    try {
      await admin.query(
        `INSERT INTO assets(
           id,filename,content_type,size_bytes,content_hash,s3_object_key
         ) VALUES ($1,'storage.txt','text/plain',7,$2,$3)`,
        [assetId, contentHash, objectKey],
      );
      await admin.query("SET LOCAL ROLE context_use_storage");
      const assets = new DocumentAssetRepository(admin as unknown as Pool);
      expect(await assets.getForStorage(assetId)).toEqual({
        document_id: assetId,
        object_key: objectKey,
        filename: "storage.txt",
        content_type: "text/plain",
        size_bytes: "7",
        content_hash: contentHash,
      });
    } finally {
      await admin.query("ROLLBACK");
    }
  });

  test("ordinary knowledge writers cannot put Markdown back into PostgreSQL", async () => {
    expect((await admin.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name='knowledge_page_versions'
         AND column_name='body_markdown'`,
    )).rowCount).toBe(0);
  });

  test("MCP can create and archive assets without editing immutable metadata or deleting rows", async () => {
    for (const column of ["id", "filename", "content_type", "size_bytes", "content_hash", "s3_object_key", "width", "height", "duration_seconds"]) {
      expect((await admin.query<{ allowed: boolean }>(
        "SELECT has_column_privilege('context_use_mcp', 'assets', $1, 'INSERT') AS allowed",
        [column],
      )).rows[0]?.allowed).toBe(true);
    }
    for (const column of ["deleted_at"]) {
      expect((await admin.query<{ allowed: boolean }>(
        "SELECT has_column_privilege('context_use_mcp', 'assets', $1, 'INSERT') AS allowed",
        [column],
      )).rows[0]?.allowed).toBe(false);
    }
    expect((await admin.query<{ allowed: boolean }>(
      "SELECT has_column_privilege('context_use_mcp', 'assets', 'deleted_at', 'UPDATE') AS allowed",
    )).rows[0]?.allowed).toBe(true);
    for (const column of ["filename", "content_type", "size_bytes", "content_hash", "s3_object_key"]) {
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

  test("scheduler and legacy publication entrypoints are absent", async () => {
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

});
