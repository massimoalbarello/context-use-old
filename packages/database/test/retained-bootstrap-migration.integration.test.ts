import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Client, Pool } from "pg";
import {
  AutomationRegistryRepository,
  defaultHypermediaBootstrapTemplate,
  HypermediaBootstrapRepository,
  KnowledgeSettingsRepository,
  type HypermediaBootstrapAllocation,
  type HypermediaBootstrapDocumentKind,
} from "../src/index.ts";
import { disposableDatabaseUrl } from "../src/disposable-database.ts";
import { developmentResetSql } from "../src/reset-development.ts";
import { MemoryMarkdownStore } from "./memory-markdown-store.ts";

const serverUrl = await disposableDatabaseUrl();
const describeDatabase = serverUrl ? describe : describe.skip;
const migrationSql = await readFile(
  new URL("../migrations/002_normalize_retained_bootstrap.sql", import.meta.url),
  "utf8",
);

function identifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function targetUrl(source: string, database: string): string {
  const target = new URL(source);
  target.pathname = `/${database}`;
  return target.toString();
}

type RetainedSnapshot = {
  document_kind: string;
  document_id: string;
  revision_id: string;
  document_created_at: Date | string;
  document_updated_at: Date | string;
  page_created_at: Date | string;
  page_updated_at: Date | string;
  version_number: number;
  title: string;
  summary: string;
  commit_message: string;
  actor_kind: string;
  actor_subject: string;
  version_created_at: Date | string;
  body_object_key: string;
  body_size_bytes: number;
  body_content_hash: string;
  revision_created_at: Date | string;
  contract_body_content_hash: string;
  contract_registered_at: Date | string;
  search_indexed_at: Date | string;
};

describeDatabase("retained bootstrap allocation normalization", () => {
  const database = `context_use_retained_${randomUUID().replaceAll("-", "")}`;
  const sourceDatabase = new URL(serverUrl ?? "postgres://localhost/postgres")
    .pathname.replace(/^\//, "");
  const maintenanceUrl = targetUrl(serverUrl ?? "postgres://localhost/postgres", "postgres");
  const adminUrl = targetUrl(serverUrl ?? "postgres://localhost/postgres", database);
  let maintenance: Client;
  let admin: Client;
  let corpus: Pool;
  let bodies: MemoryMarkdownStore;

  beforeAll(async () => {
    maintenance = new Client({ connectionString: maintenanceUrl });
    await maintenance.connect();
    await maintenance.query(
      `CREATE DATABASE ${identifier(database)} TEMPLATE ${identifier(sourceDatabase)}`,
    );
    admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    corpus = new Pool({
      connectionString: adminUrl,
      max: 2,
      options: "-c role=context_use_corpus",
    });
  });

  beforeEach(async () => {
    await admin.query(developmentResetSql());
    bodies = new MemoryMarkdownStore();
  });

  afterAll(async () => {
    await corpus?.end().catch(() => {});
    await admin?.end().catch(() => {});
    if (maintenance) {
      await maintenance.query(`DROP DATABASE IF EXISTS ${identifier(database)} WITH (FORCE)`);
      await maintenance.end();
    }
  });

  async function installBootstrap(): Promise<HypermediaBootstrapAllocation[]> {
    const bootstrap = new HypermediaBootstrapRepository(corpus, bodies);
    const allocations = await bootstrap.begin();
    const byKind = new Map(allocations.map((allocation) => [allocation.document_kind, allocation]));
    for (const [document_kind, input] of Object.entries(defaultHypermediaBootstrapTemplate.documents)) {
      const allocation = byKind.get(document_kind as HypermediaBootstrapDocumentKind);
      if (!allocation) throw new Error(`Missing bootstrap allocation: ${document_kind}`);
      await bootstrap.ensureDocument({
        ...allocation,
        input: {
          ...input,
          commit_message: "Install retained bootstrap migration fixture",
        },
      });
    }
    await new KnowledgeSettingsRepository(corpus).updateGlobalGuide(
      byKind.get("global_guide")!.document_id,
    );
    const registry = new AutomationRegistryRepository(corpus);
    for (const automation of defaultHypermediaBootstrapTemplate.automations) {
      await registry.register({
        key: automation.key,
        name: automation.name,
        instructions_document_id: byKind.get(automation.instructions)!.document_id,
        state_document_id: byKind.get(automation.state)!.document_id,
      });
    }
    await bootstrap.complete();
    return allocations;
  }

  async function removeAllocations(): Promise<void> {
    await admin.query("SET session_replication_role='replica'");
    try {
      await admin.query("DELETE FROM hypermedia_bootstrap_allocations");
    } finally {
      await admin.query("SET session_replication_role='origin'");
    }
  }

  async function retainedSnapshot(ids: string[]): Promise<RetainedSnapshot[]> {
    const result = await admin.query<RetainedSnapshot>(
      `SELECT role.document_kind,page.id::text AS document_id,
         page.current_version_id::text AS revision_id,
         document.created_at AS document_created_at,
         document.updated_at AS document_updated_at,
         page.created_at AS page_created_at,page.updated_at AS page_updated_at,
         version.version_number,version.title,version.summary,version.commit_message,
         version.actor_kind::text,version.actor_subject,
         version.created_at AS version_created_at,
         revision.body_object_key,revision.body_size_bytes,revision.body_content_hash,
         revision.created_at AS revision_created_at,
         contract.body_content_hash AS contract_body_content_hash,
         contract.registered_at AS contract_registered_at,
         search.indexed_at AS search_indexed_at
       FROM knowledge_pages page
       JOIN hypermedia_documents document ON document.id=page.id
       JOIN knowledge_page_versions version
         ON version.id=page.current_version_id AND version.page_id=page.id
       JOIN hypermedia_document_revisions revision
         ON revision.id=version.id AND revision.document_id=page.id
       JOIN knowledge_revision_contracts contract
         ON contract.revision_id=version.id AND contract.document_id=page.id
       JOIN knowledge_search search
         ON search.revision_id=version.id AND search.document_id=page.id
       JOIN (VALUES
         ('global_guide'::text,$2::uuid),
         ('activity_distiller_instructions',$3::uuid),
         ('activity_distiller_state',$4::uuid),
         ('diary_composer_instructions',$5::uuid),
         ('diary_composer_state',$6::uuid)
       ) role(document_kind,document_id) ON role.document_id=page.id
       WHERE page.id=ANY($1::uuid[])
       ORDER BY role.document_kind`,
      [ids, ...ids],
    );
    return result.rows;
  }

  test("leaves a fresh installation unchanged", async () => {
    const freshStateSql = `SELECT
      (SELECT count(*)::integer FROM hypermedia_bootstrap_allocations) AS allocations,
      (SELECT count(*)::integer FROM knowledge_pages) AS documents,
      (SELECT count(*)::integer FROM automation_registry) AS automations,
      (SELECT global_guide_document_id FROM knowledge_settings WHERE singleton) AS guide,
      (SELECT updated_at FROM publication_settings WHERE singleton) AS publication_updated_at`;
    const before = await admin.query(freshStateSql);
    await admin.query(migrationSql);
    const after = await admin.query(freshStateSql);
    expect(after.rows).toEqual(before.rows);
  });

  test("adopts the exact retained state without changing document or object identity", async () => {
    const originalAllocations = await installBootstrap();
    const ordered = new Map(originalAllocations.map((allocation) => [allocation.document_kind, allocation]));
    const ids = [
      ordered.get("global_guide")!.document_id,
      ordered.get("activity_distiller_instructions")!.document_id,
      ordered.get("activity_distiller_state")!.document_id,
      ordered.get("diary_composer_instructions")!.document_id,
      ordered.get("diary_composer_state")!.document_id,
    ];
    const beforeDocuments = await retainedSnapshot(ids);
    const beforeBodies = [...bodies.bodies.entries()].sort(([left], [right]) => left.localeCompare(right));
    const publicationBefore = (await admin.query<{ updated_at: Date | string }>(
      "SELECT updated_at FROM publication_settings WHERE singleton",
    )).rows[0]!.updated_at;

    await removeAllocations();
    await admin.query(migrationSql);

    const normalized = await admin.query<HypermediaBootstrapAllocation & { completed: boolean }>(
      `SELECT document_kind,document_id::text,revision_id::text,
         completed_at IS NOT NULL AS completed
       FROM hypermedia_bootstrap_allocations ORDER BY document_kind`,
    );
    expect(normalized.rows).toEqual(
      [...originalAllocations]
        .sort((left, right) => left.document_kind.localeCompare(right.document_kind))
        .map((allocation) => ({ ...allocation, completed: true })),
    );
    expect(await retainedSnapshot(ids)).toEqual(beforeDocuments);
    expect([...bodies.bodies.entries()].sort(([left], [right]) => left.localeCompare(right)))
      .toEqual(beforeBodies);
    expect((await admin.query<{ updated_at: Date | string }>(
      "SELECT updated_at FROM publication_settings WHERE singleton",
    )).rows[0]!.updated_at).toEqual(publicationBefore);

    expect(await new HypermediaBootstrapRepository(corpus, bodies).begin()).toEqual([]);
    await expect(corpus.query(
      "SELECT completed_at FROM hypermedia_bootstrap_allocations",
    )).rejects.toMatchObject({ code: "42501" });
    await expect(corpus.query("SELECT updated_at FROM publication_settings"))
      .rejects.toMatchObject({ code: "42501" });
  }, 20_000);

  test("fails closed for partial retained operational state", async () => {
    await installBootstrap();
    await removeAllocations();
    await admin.query(
      "UPDATE automation_registry SET disabled_at=now() WHERE key='diary-composer'",
    );
    await expect(admin.query(migrationSql)).rejects.toThrow(
      "retained hypermedia bootstrap operational state is partial",
    );
    expect((await admin.query(
      "SELECT count(*)::integer AS count FROM hypermedia_bootstrap_allocations",
    )).rows[0]?.count).toBe(0);
  });

  test("fails closed when a retained operational document is archived", async () => {
    const allocations = await installBootstrap();
    await removeAllocations();
    await admin.query("SET session_replication_role='replica'");
    try {
      await admin.query(
        "UPDATE knowledge_pages SET archived_at=now() WHERE id=$1",
        [allocations.find(({ document_kind }) => document_kind === "global_guide")!.document_id],
      );
    } finally {
      await admin.query("SET session_replication_role='origin'");
    }
    await expect(admin.query(migrationSql)).rejects.toThrow(
      "retained hypermedia bootstrap documents are incomplete or conflicting",
    );
    expect((await admin.query(
      "SELECT count(*)::integer AS count FROM hypermedia_bootstrap_allocations",
    )).rows[0]?.count).toBe(0);
  });
});
