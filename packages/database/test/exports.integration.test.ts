import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import {
  ConfirmationRepository,
  DocumentAssetRepository,
  KnowledgeDocumentRepository,
  KnowledgeExportRepository,
} from "../src/index.ts";
import { disposableDatabaseUrl } from "../src/disposable-database.ts";
import { MemoryMarkdownStore } from "./memory-markdown-store.ts";

const databaseUrl = await disposableDatabaseUrl();
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("passkey-bound current knowledge exports", () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const bodies = new MemoryMarkdownStore();
  const documents = new KnowledgeDocumentRepository(pool, bodies);
  const assets = new DocumentAssetRepository(pool);
  const exports = new KnowledgeExportRepository(pool, bodies);
  const confirmations = new ConfirmationRepository(pool);
  const actor = { kind: "dashboard" as const, subject: "knowledge-export-test" };
  const fixtureDocumentIds: string[] = [];
  const fixtureIntentIds: string[] = [];
  const fixtureAssetIds: string[] = [];
  let createdOwner = false;

  beforeAll(async () => {
    // The owner identity is a singleton, so this suite adopts one that another
    // suite already left behind rather than colliding with it — and records
    // whether it created the row, because teardown must only remove its own.
    const owner = await pool.query(
      `INSERT INTO "user"(id,name,email,"emailVerified")
       VALUES ('context-use-owner','Owner','owner@example.com',true)
       ON CONFLICT (id) DO NOTHING`,
    );
    createdOwner = owner.rowCount === 1;
    await pool.query(
      `INSERT INTO passkey(id,"publicKey","userId","credentialID",counter,"deviceType","backedUp")
       VALUES ('export-test-passkey','public-key','context-use-owner','verified-credential',0,'multiDevice',true)`,
    );
  });

  afterAll(async () => {
    // Repository methods intentionally own their transactions. Clean the
    // committed fixture with trigger/FK enforcement suspended only on this
    // superuser test connection so the immutable production rows stay
    // undeletable to every application role.
    await pool.query("BEGIN");
    try {
      await pool.query("SET LOCAL session_replication_role=replica");
      for (const fixtureIntentId of fixtureIntentIds) {
        await pool.query("DELETE FROM confirmation_challenges WHERE intent_id=$1", [fixtureIntentId]);
        await pool.query("DELETE FROM knowledge_export_intents WHERE id=$1", [fixtureIntentId]);
      }
      if (fixtureDocumentIds.length) {
        await pool.query(
          `DELETE FROM knowledge_asset_links
           WHERE source_version_id IN (
             SELECT id FROM knowledge_page_versions WHERE page_id=ANY($1::uuid[])
           ) OR target_asset_id=ANY($1::uuid[])`,
          [fixtureDocumentIds],
        );
        await pool.query(
          `DELETE FROM document_links
           WHERE source_revision_id IN (
             SELECT id FROM hypermedia_document_revisions WHERE document_id=ANY($1::uuid[])
           ) OR target_document_id=ANY($1::uuid[])`,
          [fixtureDocumentIds],
        );
        await pool.query("DELETE FROM knowledge_search_chunks WHERE document_id=ANY($1::uuid[])", [fixtureDocumentIds]);
        await pool.query("DELETE FROM knowledge_search WHERE document_id=ANY($1::uuid[])", [fixtureDocumentIds]);
        await pool.query("DELETE FROM knowledge_revision_contracts WHERE document_id=ANY($1::uuid[])", [fixtureDocumentIds]);
        await pool.query("DELETE FROM knowledge_page_changes WHERE page_id=ANY($1::uuid[])", [fixtureDocumentIds]);
        await pool.query("DELETE FROM knowledge_page_versions WHERE page_id=ANY($1::uuid[])", [fixtureDocumentIds]);
        await pool.query("DELETE FROM knowledge_pages WHERE id=ANY($1::uuid[])", [fixtureDocumentIds]);
        await pool.query("DELETE FROM hypermedia_document_revisions WHERE document_id=ANY($1::uuid[])", [fixtureDocumentIds]);
        await pool.query("DELETE FROM hypermedia_documents WHERE id=ANY($1::uuid[])", [fixtureDocumentIds]);
        await pool.query("DELETE FROM publication_target_generations WHERE target_document_id=ANY($1::uuid[])", [fixtureDocumentIds]);
      }
      if (fixtureAssetIds.length) {
        await pool.query("DELETE FROM assets WHERE id=ANY($1::uuid[])", [fixtureAssetIds]);
        await pool.query("DELETE FROM hypermedia_documents WHERE id=ANY($1::uuid[])", [fixtureAssetIds]);
        await pool.query(
          "DELETE FROM publication_target_generations WHERE target_document_id=ANY($1::uuid[])",
          [fixtureAssetIds],
        );
      }
      await pool.query("DELETE FROM passkey WHERE id='export-test-passkey'");
      if (createdOwner) await pool.query("DELETE FROM \"user\" WHERE id='context-use-owner'");
      await pool.query("COMMIT");
    } catch (error) {
      await pool.query("ROLLBACK");
      throw error;
    }
    await pool.end();
  });

  test("exports active knowledge as of download and permits resumable same-session claims", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const active = await documents.create({
      title: "Active export page",
      summary: "The active page included in an export.",
      body_markdown: "Latest active body",
      commit_message: "Create active export fixture",
    }, actor);
    fixtureDocumentIds.push(active.document_id);
    const archived = await documents.create({
      title: "Archived export page",
      summary: "An archived page excluded from an export.",
      body_markdown: "Archived body",
      commit_message: "Create archived export fixture",
    }, actor);
    fixtureDocumentIds.push(archived.document_id);
    await documents.archive(archived.document_id, {
      expected_revision_number: 1,
      commit_message: "Archive export fixture",
    }, actor);
    const asset = await assets.create({
      filename: "friendly.pdf",
      content_type: "application/pdf",
      size_bytes: 123,
      sha256: "a".repeat(64),
    });
    fixtureAssetIds.push(asset.document.document_id);

    const principal = { ownerUserId: "context-use-owner", sessionId: `session-${suffix}` };
    const intent = await exports.createIntent(principal);
    fixtureIntentIds.push(intent.id);
    await confirmations.issueChallenge("knowledge_export", intent.id, randomBytes(32).toString("base64url"));
    expect(intent.page_count).toBeGreaterThanOrEqual(1);
    expect(intent.asset_count).toBeGreaterThanOrEqual(1);
    await expect(confirmations.claimExport(intent.id, principal)).rejects.toThrow();
    await expect(confirmations.confirmExport(intent.id, { ...principal, sessionId: "wrong-session" }, {
      credentialId: "verified-credential", expectedCounter: 0, newCounter: 0,
    })).rejects.toThrow();
    await confirmations.confirmExport(intent.id, principal, {
      credentialId: "verified-credential", expectedCounter: 0, newCounter: 0,
    });
    await expect(confirmations.claimExport(intent.id, { ...principal, sessionId: "wrong-session" })).rejects.toThrow();

    await documents.update(active.document_id, {
      title: "Active export page",
      summary: "The active page included in an export.",
      body_markdown: "Current body at download",
      commit_message: "Update after export authorization",
      expected_revision_number: 1,
    }, actor);

    await confirmations.claimExport(intent.id, principal);
    const snapshot = await exports.currentSnapshot();
    expect(snapshot.pages.find(({ document_id }) => document_id === active.document_id)?.body_markdown)
      .toBe("Current body at download");
    expect(snapshot.pages.find(({ document_id }) => document_id === active.document_id)?.summary)
      .toBe("The active page included in an export.");
    expect(snapshot.pages.some(({ document_id }) => document_id === archived.document_id)).toBe(false);
    expect(snapshot.assets.find(({ document_id }) => document_id === asset.document.document_id)).toMatchObject({
      filename: "friendly.pdf",
    });
    expect(snapshot.links.every((link) => !Object.hasOwn(link, "path"))).toBe(true);
    expect(await exports.getIntent(intent.id)).toMatchObject({ download_started_at: expect.any(Date) });
    const confirmedIntent = await exports.getIntent(intent.id);
    expect(new Date(confirmedIntent!.expires_at).getTime()).toBeGreaterThan(Date.now() + 23 * 60 * 60 * 1_000);
    await confirmations.claimExport(intent.id, principal);

  });
});
