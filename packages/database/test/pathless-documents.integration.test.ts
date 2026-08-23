import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Client, Pool } from "pg";
import {
  AssetArchiveConflictError,
  DirectoryRepository,
  DocumentAssetRepository,
  InvalidPrivateDocumentCursorError,
  KnowledgeDocumentRepository,
  PageRepository,
  PrivateDocumentCatalogRepository,
  SourceRecordRepository,
  VersionConflictError,
} from "../src/index.ts";
import { disposableDatabaseUrl } from "../src/disposable-database.ts";
import { MemoryMarkdownStore } from "./memory-markdown-store.ts";

const databaseUrl = await disposableDatabaseUrl();
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("pathless private documents", () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 8 });
  const bodies = new MemoryMarkdownStore();
  const knowledge = new KnowledgeDocumentRepository(pool, bodies);
  const assets = new DocumentAssetRepository(pool);
  const catalog = new PrivateDocumentCatalogRepository(pool);
  const records = new SourceRecordRepository(pool, bodies);
  const createdDocumentIds = new Set<string>();
  const createdDirectoryIds = new Set<string>();
  const actor = { kind: "dashboard" as const, subject: "pathless-integration" };

  afterAll(async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET CONSTRAINTS ALL DEFERRED");
      const ids = [...createdDocumentIds];
      if (ids.length) {
        await client.query(
          `DELETE FROM document_links
           WHERE source_revision_id IN (
             SELECT id FROM hypermedia_document_revisions
             WHERE document_id=ANY($1::uuid[])
           ) OR target_document_id=ANY($1::uuid[])`,
          [ids],
        );
        await client.query(
          `DELETE FROM knowledge_asset_links
           WHERE source_version_id IN (
             SELECT id FROM knowledge_page_versions WHERE page_id=ANY($1::uuid[])
           ) OR target_asset_id=ANY($1::uuid[])`,
          [ids],
        );
        await client.query("DELETE FROM knowledge_page_changes WHERE page_id=ANY($1::uuid[])", [ids]);
        await client.query("DELETE FROM source_records WHERE document_id=ANY($1::uuid[])", [ids]);
        // The page->current-version constraint is deferred; the inverse
        // version->page FK is not, so break the cycle child-first.
        await client.query("DELETE FROM knowledge_page_versions WHERE page_id=ANY($1::uuid[])", [ids]);
        await client.query("DELETE FROM knowledge_pages WHERE id=ANY($1::uuid[])", [ids]);
        await client.query("DELETE FROM assets WHERE id=ANY($1::uuid[])", [ids]);
        await client.query("DELETE FROM hypermedia_document_revisions WHERE document_id=ANY($1::uuid[])", [ids]);
        await client.query("DELETE FROM hypermedia_documents WHERE id=ANY($1::uuid[])", [ids]);
      }
      for (const id of [...createdDirectoryIds].reverse()) {
        await client.query("DELETE FROM knowledge_directories WHERE id=$1", [id]);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
      await pool.end();
    }
  });

  test("creates, revises and archives without exposing compatibility paths or storage keys", async () => {
    const changesBefore = (await knowledge.changesSince()).next_cursor;
    const asset = await assets.create({
      filename: "pathless-diagram.png",
      content_type: "image/png",
      size_bytes: 1234,
      sha256: "a".repeat(64),
      width: 640,
      height: 480,
      duration_seconds: 1.25,
    });
    createdDocumentIds.add(asset.document.document_id);
    expect(Object.keys(asset.document).sort()).toEqual([
      "content_hash", "content_type", "created_at", "deleted_at", "document_id",
      "duration_seconds", "filename", "height", "legacy_published", "public_id",
      "size_bytes", "width",
    ]);
    expect(asset.document).toMatchObject({
      size_bytes: "1234",
      duration_seconds: "1.25",
      public_id: null,
      legacy_published: false,
    });
    // The storage locator is an explicit internal handoff. Only the legacy
    // compatibility path (verified below for pages) must be unlinkable from
    // private document identity.
    expect(asset.storage.object_key).toBe(`objects/${asset.document.document_id}`);
    expect(await assets.getForStorage(asset.document.document_id)).toEqual({
      ...asset.document,
      object_key: asset.storage.object_key,
    });

    const dangling = randomUUID();
    const createdBody = [
      `![Diagram](context-use://document/${asset.document.document_id})`,
      `[Missing](context-use://document/${dangling})`,
    ].join("\n\n");
    const created = await knowledge.create({
      title: "Pathless lifecycle",
      summary: "A document used to verify path-independent mutation.",
      body_markdown: createdBody,
      commit_message: "Create pathless lifecycle document",
    }, actor);
    createdDocumentIds.add(created.document_id);
    expect(created).not.toHaveProperty("path");
    expect(created).not.toHaveProperty("current_path");
    expect(created).not.toHaveProperty("body_object_key");
    expect(created).toMatchObject({
      revision_number: 1,
      current_link_contract: "generic_document_v1",
      pathless_search_ready: true,
    });

    const legacy = await pool.query<{ current_path: string }>(
      "SELECT current_path FROM knowledge_pages WHERE id=$1",
      [created.document_id],
    );
    expect(legacy.rows[0]!.current_path).toStartWith("pathless-page-");
    expect(legacy.rows[0]!.current_path).not.toContain(created.document_id);
    const receipt = await pool.query<{ target_document_ids: string[] }>(
      "SELECT target_document_ids FROM knowledge_revision_contracts WHERE revision_id=$1",
      [created.current_revision_id],
    );
    expect(receipt.rows[0]!.target_document_ids).toEqual(
      [asset.document.document_id, dangling].sort(),
    );
    expect((await pool.query<{ target_document_id: string }>(
      "SELECT target_document_id FROM document_links WHERE source_revision_id=$1",
      [created.current_revision_id],
    )).rows).toEqual([{ target_document_id: asset.document.document_id }]);
    expect((await pool.query<{ target_asset_id: string }>(
      "SELECT target_asset_id FROM knowledge_asset_links WHERE source_version_id=$1",
      [created.current_revision_id],
    )).rows).toEqual([{ target_asset_id: asset.document.document_id }]);

    // A legacy-only active retention edge must still block archival. Replaying
    // adoption repairs the exact generic graph from the immutable receipt.
    await pool.query(
      "DELETE FROM document_links WHERE source_revision_id=$1",
      [created.current_revision_id],
    );
    await expect(assets.archive({ asset_id: asset.document.document_id }))
      .rejects.toBeInstanceOf(AssetArchiveConflictError);
    await pool.query(
      "SELECT register_generic_knowledge_revision($1,$2,$3::uuid[])",
      [created.current_revision_id, createdBody,
        [asset.document.document_id, dangling].sort()],
    );
    await expect(assets.archive({ asset_id: asset.document.document_id }))
      .rejects.toBeInstanceOf(AssetArchiveConflictError);
    const objectCount = bodies.bodies.size;
    await expect(knowledge.update(created.document_id, {
      title: "Stale",
      summary: "A stale update must not allocate immutable object bytes.",
      body_markdown: "stale",
      commit_message: "Attempt stale update",
      expected_revision_number: 99,
    }, actor)).rejects.toBeInstanceOf(VersionConflictError);
    expect(bodies.bodies.size).toBe(objectCount);

    const updated = await knowledge.update(created.document_id, {
      title: "Pathless lifecycle updated",
      summary: "The active asset retention edge has been removed.",
      body_markdown: "Searchable current body term pathlesscurrentneedle",
      commit_message: "Remove asset reference",
      expected_revision_number: 1,
    }, actor);
    expect(updated?.revision_number).toBe(2);
    const deletedAsset = await assets.archive({ asset_id: asset.document.document_id });
    expect(deletedAsset?.deleted_at).not.toBeNull();

    const tombstoneLinked = await knowledge.update(created.document_id, {
      title: "Pathless lifecycle updated",
      summary: "Deleted asset identity remains linkable without retaining its bytes.",
      body_markdown: `[Deleted asset](context-use://document/${asset.document.document_id})`,
      commit_message: "Link asset tombstone",
      expected_revision_number: 2,
    }, actor);
    expect((await pool.query(
      "SELECT 1 FROM document_links WHERE source_revision_id=$1 AND target_document_id=$2",
      [tombstoneLinked!.current_revision_id, asset.document.document_id],
    )).rowCount).toBe(1);
    expect((await pool.query(
      "SELECT 1 FROM knowledge_asset_links WHERE source_version_id=$1",
      [tombstoneLinked!.current_revision_id],
    )).rowCount).toBe(0);

    const history = await knowledge.history(created.document_id, { limit: Number.NaN });
    expect(history.revisions.map(({ revision_number }) => revision_number)).toEqual([3, 2, 1]);
    expect(await knowledge.revision(created.document_id, 2)).toMatchObject({
      document_id: created.document_id,
      revision_number: 2,
      title: "Pathless lifecycle updated",
      body_markdown: "Searchable current body term pathlesscurrentneedle",
    });
    expect(await knowledge.revision(created.document_id, 99)).toBeNull();
    const archived = await knowledge.archive(created.document_id, {
      commit_message: "Archive pathless lifecycle document",
      expected_revision_number: 3,
    }, actor);
    expect(archived).toMatchObject({ revision_number: 4 });
    expect(archived?.archived_at).not.toBeNull();

    const changes = await knowledge.changesSince({ cursor: changesBefore });
    expect(changes.changes.find(({ document_id }) => document_id === created.document_id))
      .toMatchObject({
        document_id: created.document_id,
        revision_id: archived!.current_revision_id,
        revision_number: 4,
        previous_revision_number: null,
        change_kind: "archived",
        title: "Pathless lifecycle updated",
      });
    expect(changes.changes.find(({ document_id }) => document_id === created.document_id))
      .not.toHaveProperty("path");
    expect(await knowledge.oldestRetainedRevisionAfter(created.document_id, 1, 4))
      .toMatchObject({
        document_id: created.document_id,
        revision_number: 2,
        body_markdown: "Searchable current body term pathlesscurrentneedle",
      });
  });

  test("searches and navigates the unified private catalog with stable shapes", async () => {
    const target = await knowledge.create({
      title: "Running résumé playbook",
      summary: "The strongest title match for a ranked search.",
      body_markdown: "target body",
      commit_message: "Create ranked target",
    }, actor);
    createdDocumentIds.add(target.document_id);
    const dangling = randomUUID();
    const source = await knowledge.create({
      title: "Catalog source metadataalpha",
      summary: "A source document for neighborhood pagination.",
      body_markdown: [
        `[Target](context-use://document/${target.document_id})`,
        `[Dangling](context-use://document/${dangling})`,
        "running pathlessbodyneedle",
      ].join("\n\n"),
      commit_message: "Create neighborhood source",
    }, actor);
    createdDocumentIds.add(source.document_id);
    const secondSource = await knowledge.create({
      title: "Second catalog source",
      summary: "A second source used to paginate backlinks.",
      body_markdown: `[Target](context-use://document/${target.document_id})`,
      commit_message: "Create second backlink source",
    }, actor);
    createdDocumentIds.add(secondSource.document_id);
    const asset = await assets.create({
      filename: "catalog-search-needle.webm",
      content_type: "video/webm",
      size_bytes: 900719,
      sha256: "b".repeat(64),
      width: 1920,
      height: 1080,
      duration_seconds: 12.5,
    });
    createdDocumentIds.add(asset.document.document_id);
    const remote = await records.write({
      integration: "pathless-test",
      connectionInstanceId: 987654,
      connectionId: `connection-${randomUUID()}`,
      model: "note",
      sourceRecordId: randomUUID(),
      action: "added",
      sourceUpdatedAt: new Date().toISOString(),
      markdown: "remote connector body remotefulltextneedle",
    });
    createdDocumentIds.add(remote.document_id);

    const assetCatalog = await catalog.get(asset.document.document_id);
    expect(assetCatalog).toMatchObject({
      document_kind: "asset",
      size_bytes: "900719",
      duration_seconds: "12.5",
      width: 1920,
      height: 1080,
    });
    expect(assetCatalog).not.toHaveProperty("current_path");
    expect(assetCatalog).not.toHaveProperty("object_key");
    expect(typeof assetCatalog!.created_at).toBe("string");

    const ranked = await catalog.search("Running", { document_kind: "knowledge" });
    expect(ranked.documents[0]?.document_id).toBe(target.document_id);
    const mixedVector = await knowledge.create({
      title: "Running metadata-only term",
      summary: "The second term exists only in the body search chunks.",
      body_markdown: "mixedvectorbodyneedle",
      commit_message: "Create mixed-vector search fixture",
    }, actor);
    createdDocumentIds.add(mixedVector.document_id);
    expect((await catalog.search("Running mixedvectorbodyneedle", {
      document_kind: "knowledge",
    })).documents.map(({ document_id }) => document_id)).toContain(mixedVector.document_id);
    expect((await catalog.search("résumé", {
      document_kind: "knowledge",
    })).documents.map(({ document_id }) => document_id)).toContain(target.document_id);
    expect((await catalog.search("pathlessbodyneedle", {
      document_kind: "knowledge",
    })).documents.map(({ document_id }) => document_id)).toContain(source.document_id);
    expect((await catalog.search("metadataalpha pathlessbodyneedle", {
      document_kind: "knowledge",
    })).documents.map(({ document_id }) => document_id)).toContain(source.document_id);
    expect((await catalog.search("remotefulltextneedle", {
      authority: "source",
    })).documents.map(({ document_id }) => document_id)).toContain(remote.document_id);
    expect((await catalog.search("catalog-search-needle", {
      representation: "asset",
    })).documents.map(({ document_id }) => document_id)).toContain(asset.document.document_id);
    const hiddenPath = (await pool.query<{ current_path: string }>(
      "SELECT current_path FROM knowledge_pages WHERE id=$1",
      [source.document_id],
    )).rows[0]!.current_path;
    expect((await catalog.search(hiddenPath)).documents).toEqual([]);
    expect((await catalog.list({
      authority: "source",
      integration: "pathless-test",
    })).documents.map(({ document_id }) => document_id)).toContain(remote.document_id);
    expect((await catalog.list({
      authority: "source",
      integration: "not-this-integration",
    })).documents).toEqual([]);
    expect((await catalog.list({
      operational_role: "global_guide",
    })).documents.every(({ operational_roles }) => (
      operational_roles.includes("global_guide")
    ))).toBe(true);

    const firstList = await catalog.list({
      document_kind: "asset",
      include_retired: true,
      limit: 1,
    });
    expect(firstList.documents).toHaveLength(1);
    expect(firstList.next_cursor).not.toBeNull();
    const secondList = await catalog.list({
      document_kind: "asset",
      include_retired: true,
      limit: 1,
      cursor: firstList.next_cursor!,
    });
    expect(secondList.documents[0]?.document_id)
      .not.toBe(firstList.documents[0]?.document_id);
    const cursorValue = JSON.parse(
      Buffer.from(firstList.next_cursor!, "base64url").toString("utf8"),
    ) as { document_id: string };
    cursorValue.document_id = cursorValue.document_id.toUpperCase();
    const mutated = Buffer.from(JSON.stringify(cursorValue), "utf8").toString("base64url");
    await expect(catalog.list({
      document_kind: "asset",
      include_retired: true,
      cursor: mutated,
    })).rejects.toBeInstanceOf(InvalidPrivateDocumentCursorError);

    const firstNeighborhood = await catalog.neighborhood(source.document_id, {
      outbound_limit: 1,
    });
    expect(firstNeighborhood?.outbound.revision_id).toBe(source.current_revision_id);
    expect(firstNeighborhood?.outbound.index_complete).toBe(true);
    await pool.query(
      "DELETE FROM document_links WHERE source_revision_id=$1 AND target_document_id=$2",
      [source.current_revision_id, target.document_id],
    );
    expect((await catalog.neighborhood(source.document_id))?.outbound.index_complete).toBe(false);
    await pool.query(
      "SELECT register_generic_knowledge_revision($1,$2,$3::uuid[])",
      [source.current_revision_id, source.body_markdown,
        [target.document_id, dangling].sort()],
    );
    await pool.query(
      `INSERT INTO document_links(source_revision_id,target_document_id)
       VALUES ($1,$2)`,
      [source.current_revision_id, asset.document.document_id],
    );
    expect((await catalog.neighborhood(source.document_id))?.outbound.index_complete).toBe(false);
    await pool.query(
      "SELECT register_generic_knowledge_revision($1,$2,$3::uuid[])",
      [source.current_revision_id, source.body_markdown,
        [target.document_id, dangling].sort()],
    );
    expect((await catalog.neighborhood(source.document_id))?.outbound.index_complete).toBe(true);
    expect(firstNeighborhood?.outbound.neighbors).toHaveLength(1);
    expect(firstNeighborhood?.outbound.has_more).toBe(true);
    await expect(catalog.neighborhood(source.document_id, {
      outbound_after_document_id: firstNeighborhood!.outbound.next_cursor!,
    })).rejects.toBeInstanceOf(InvalidPrivateDocumentCursorError);
    const secondNeighborhood = await catalog.neighborhood(source.document_id, {
      requested_revision_id: firstNeighborhood!.outbound.revision_id!,
      outbound_after_document_id: firstNeighborhood!.outbound.next_cursor!,
      outbound_limit: 1,
    });
    expect(secondNeighborhood?.outbound.neighbors).toHaveLength(1);
    expect([
      ...firstNeighborhood!.outbound.neighbors,
      ...secondNeighborhood!.outbound.neighbors,
    ].map(({ target_document_id }) => target_document_id).sort()).toEqual(
      [target.document_id, dangling].sort(),
    );
    const targetNeighborhood = await catalog.neighborhood(target.document_id, {
      backlink_limit: 1,
    });
    expect(targetNeighborhood?.backlinks.has_more).toBe(true);
    const secondBacklinks = await catalog.neighborhood(target.document_id, {
      backlink_limit: 1,
      backlink_after_document_id: targetNeighborhood!.backlinks.next_cursor!,
    });
    expect([
      ...targetNeighborhood!.backlinks.documents,
      ...secondBacklinks!.backlinks.documents,
    ].map(({ document_id }) => document_id).sort()).toEqual(
      [source.document_id, secondSource.document_id].sort(),
    );
    expect(targetNeighborhood?.backlinks).toMatchObject({
      completeness_checked: false,
      complete: null,
    });
    // The reset/bootstrap guide has not yet been hydrated into a 027 receipt,
    // so an explicitly requested global private graph proof is conservative.
    expect((await catalog.neighborhood(target.document_id, {
      audit_global_completeness: true,
    }))?.backlinks).toMatchObject({
      completeness_checked: true,
      complete: false,
    });
  });

  test("adopts archived legacy bodies and chunks near-limit pathless search safely", async () => {
    const legacyPages = new PageRepository(pool, bodies);
    const suffix = randomUUID().slice(0, 8);
    const legacyBody = "archived legacy body archivedbodyneedle";
    const legacy = await legacyPages.create({
      path: `archived-pathless-${suffix}`,
      title: "Archived adoption title needle",
      summary: "An archived pre-contract page.",
      body_markdown: legacyBody,
      commit_message: "Create legacy archived fixture",
    }, actor);
    createdDocumentIds.add(legacy.id);
    const archived = await legacyPages.archive(legacy.id, {
      commit_message: "Archive legacy fixture",
      expected_version_number: 1,
    }, actor);
    expect(archived?.archived_at).not.toBeNull();
    expect((await catalog.search("Archived adoption title needle", {
      document_kind: "knowledge",
      include_retired: true,
    })).documents.map(({ document_id }) => document_id)).toContain(legacy.id);
    expect((await catalog.search("archivedbodyneedle", {
      document_kind: "knowledge",
      include_retired: true,
    })).documents.map(({ document_id }) => document_id)).not.toContain(legacy.id);
    await expect(pool.query(
      "SELECT register_generic_knowledge_revision($1,$2,'{}'::uuid[])",
      [archived!.current_version_id, legacyBody],
    )).rejects.toThrow();
    await expect(knowledge.adoptCurrent({
      document_id: randomUUID(),
      revision_id: archived!.current_version_id,
      body_markdown: archived!.body_markdown,
    })).rejects.toThrow();
    expect((await pool.query(
      "SELECT 1 FROM knowledge_revision_contracts WHERE revision_id=$1",
      [archived!.current_version_id],
    )).rowCount).toBe(0);
    const adopted = await knowledge.adoptCurrent({
      document_id: legacy.id,
      revision_id: archived!.current_version_id,
      body_markdown: archived!.body_markdown,
    });
    expect(adopted.pathless_search_ready).toBe(true);
    expect((await catalog.search("archivedbodyneedle", {
      document_kind: "knowledge",
      include_retired: true,
    })).documents.map(({ document_id }) => document_id)).toContain(legacy.id);

    const stale = await legacyPages.create({
      path: `stale-pathless-${suffix}`,
      title: "Current-only chunk fixture",
      summary: "Search chunks must follow the current immutable revision.",
      body_markdown: "stalev1needle",
      commit_message: "Create stale-search fixture",
    }, actor);
    createdDocumentIds.add(stale.id);
    await knowledge.adoptCurrent({
      document_id: stale.id,
      revision_id: stale.current_version_id,
      body_markdown: stale.body_markdown,
    });
    expect((await catalog.search("stalev1needle", {
      document_kind: "knowledge",
    })).documents.map(({ document_id }) => document_id)).toContain(stale.id);
    const advanced = await legacyPages.update(stale.id, {
      path: stale.current_path,
      title: "Current-only chunk fixture",
      summary: "Search chunks must follow the current immutable revision.",
      body_markdown: "freshv2needle",
      commit_message: "Advance outside the pathless writer",
      expected_version_number: 1,
    }, actor);
    expect((await catalog.get(stale.id))?.pathless_search_ready).toBe(false);
    expect((await catalog.search("stalev1needle", {
      document_kind: "knowledge",
    })).documents.map(({ document_id }) => document_id)).not.toContain(stale.id);
    expect((await catalog.search("freshv2needle", {
      document_kind: "knowledge",
    })).documents.map(({ document_id }) => document_id)).not.toContain(stale.id);
    await knowledge.adoptCurrent({
      document_id: stale.id,
      revision_id: advanced!.current_version_id,
      body_markdown: advanced!.body_markdown,
    });
    expect((await catalog.search("stalev1needle", {
      document_kind: "knowledge",
    })).documents.map(({ document_id }) => document_id)).not.toContain(stale.id);
    expect((await catalog.search("freshv2needle", {
      document_kind: "knowledge",
    })).documents.map(({ document_id }) => document_id)).toContain(stale.id);

    const token = (index: number): string => `t${index.toString(36).padStart(7, "0")}`;
    const tokenCount = 400_000;
    const largeBody = Array.from({ length: tokenCount }, (_, index) => token(index)).join(" ");
    expect(Buffer.byteLength(largeBody)).toBeGreaterThan(3_500_000);
    expect(Buffer.byteLength(largeBody)).toBeLessThan(4_000_000);
    const large = await knowledge.create({
      title: "Chunked pathless search",
      summary: "A near-limit body whose full-text index is revision-bound and bounded.",
      body_markdown: largeBody,
      commit_message: "Create chunked-search fixture",
    }, actor);
    createdDocumentIds.add(large.document_id);
    expect((await pool.query(
      "SELECT 1 FROM pathless_knowledge_search_chunks WHERE document_id=$1",
      [large.document_id],
    )).rowCount).toBeGreaterThan(50);
    for (const query of [token(6_827), token(tokenCount - 1)]) {
      expect((await catalog.search(query, {
        document_kind: "knowledge",
      })).documents.map(({ document_id }) => document_id)).toContain(large.document_id);
    }
  }, 30_000);

  test("serializes active asset registration against archival", async () => {
    const asset = await assets.create({
      filename: "registration-race.png",
      content_type: "image/png",
      size_bytes: 42,
      sha256: "c".repeat(64),
    });
    createdDocumentIds.add(asset.document.document_id);
    const body = `[Race asset](context-use://document/${asset.document.document_id})`;
    const legacyPages = new PageRepository(pool, bodies);
    const page = await legacyPages.create({
      path: `registration-race-${randomUUID().slice(0, 8)}`,
      title: "Registration race",
      summary: "Pins the active-asset lifecycle lock order.",
      body_markdown: body,
      commit_message: "Create registration race fixture",
    }, actor);
    createdDocumentIds.add(page.id);
    await pool.query(
      "DELETE FROM document_links WHERE source_revision_id=$1",
      [page.current_version_id],
    );
    await pool.query(
      "DELETE FROM knowledge_asset_links WHERE source_version_id=$1",
      [page.current_version_id],
    );

    const registering = new Client({ connectionString: databaseUrl });
    await registering.connect();
    try {
      await registering.query("BEGIN");
      await registering.query(
        "SELECT register_generic_knowledge_revision($1,$2,$3::uuid[])",
        [page.current_version_id, body, [asset.document.document_id]],
      );
      let archiveSettled = false;
      const archive = assets.archive({ asset_id: asset.document.document_id })
        .finally(() => { archiveSettled = true; });
      await Bun.sleep(75);
      expect(archiveSettled).toBe(false);
      await registering.query("COMMIT");
      await expect(archive).rejects.toBeInstanceOf(AssetArchiveConflictError);
      expect((await pool.query(
        `SELECT 1 FROM knowledge_asset_links
         WHERE source_version_id=$1 AND target_asset_id=$2`,
        [page.current_version_id, asset.document.document_id],
      )).rowCount).toBe(1);
    } finally {
      await registering.query("ROLLBACK").catch(() => undefined);
      await registering.end();
    }
  });

  test("keeps ranked cursors stable across microseconds and cursor-document mutation", async () => {
    const needle = `cursorstable${randomUUID().slice(0, 8)}`;
    const cursorAssets = [];
    for (const [index, micros] of [456, 789, 999].entries()) {
      const asset = await assets.create({
        filename: `${needle}-${index}.bin`,
        content_type: "application/octet-stream",
        size_bytes: 10 + index,
        sha256: String(index + 1).repeat(64),
      });
      cursorAssets.push(asset);
      createdDocumentIds.add(asset.document.document_id);
      await pool.query(
        "UPDATE hypermedia_documents SET updated_at=$2::timestamptz WHERE id=$1",
        [asset.document.document_id, `2026-08-22T12:00:00.123${micros}+00:00`],
      );
    }
    const first = await catalog.search(needle, {
      representation: "asset",
      include_retired: true,
      limit: 1,
    });
    expect(first.documents).toHaveLength(1);
    expect(first.next_cursor).not.toBeNull();
    const firstId = first.documents[0]!.document_id;
    await assets.archive({ asset_id: firstId });
    const second = await catalog.search(needle, {
      representation: "asset",
      include_retired: true,
      limit: 1,
      cursor: first.next_cursor!,
    });
    expect(second.documents).toHaveLength(1);
    expect(second.documents[0]!.document_id).not.toBe(firstId);
    expect(cursorAssets.map(({ document }) => document.document_id))
      .toContain(second.documents[0]!.document_id);
  });

  test("legacy filesystem writers wait behind the corpus transition barrier", async () => {
    const admin = new Client({ connectionString: databaseUrl });
    await admin.connect();
    const directories = new DirectoryRepository(pool);
    const legacyPages = new PageRepository(pool, bodies);
    const suffix = randomUUID().slice(0, 8);
    try {
      await admin.query("BEGIN");
      await admin.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('filesystem-hypermedia-corpus-transition',0))",
      );
      let directorySettled = false;
      const directoryPromise = directories.create({
        path: `barrier-${suffix}`,
        title: "Barrier directory",
        summary: "A directory created after the transition barrier is released.",
      }).finally(() => { directorySettled = true; });
      await Bun.sleep(75);
      expect(directorySettled).toBe(false);
      await admin.query("COMMIT");
      const directory = await directoryPromise;
      createdDirectoryIds.add(directory.id);

      await admin.query("BEGIN");
      await admin.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('filesystem-hypermedia-corpus-transition',0))",
      );
      let pageSettled = false;
      const pagePromise = legacyPages.create({
        path: `barrier-${suffix}/page`,
        title: "Barrier page",
        summary: "A page created after the transition barrier is released.",
        body_markdown: "barrier body",
        commit_message: "Create barrier page",
      }, actor).finally(() => { pageSettled = true; });
      await Bun.sleep(75);
      expect(pageSettled).toBe(false);
      await admin.query("COMMIT");
      const page = await pagePromise;
      createdDocumentIds.add(page.id);
    } finally {
      await admin.query("ROLLBACK").catch(() => undefined);
      await admin.end();
    }
  });
});
