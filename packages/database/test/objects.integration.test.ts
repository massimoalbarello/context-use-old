import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Client, Pool } from "pg";
import {
  AssetArchiveConflictError,
  AssetRepository,
  InvalidPrivateObjectCursorError,
  KnowledgePageRepository,
  PrivateObjectCatalogRepository,
  SourceRecordRepository,
  VersionConflictError,
} from "../src/index.ts";
import { disposableDatabaseUrl } from "../src/disposable-database.ts";
import { MemoryMarkdownStore } from "./memory-markdown-store.ts";

const databaseUrl = await disposableDatabaseUrl();
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("canonical private objects", () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 8 });
  const bodies = new MemoryMarkdownStore();
  const knowledge = new KnowledgePageRepository(pool, bodies);
  const assets = new AssetRepository(pool);
  const catalog = new PrivateObjectCatalogRepository(pool);
  const records = new SourceRecordRepository(pool, bodies);
  const createdDocumentIds = new Set<string>();
  const actor = { kind: "dashboard" as const, subject: "canonical-integration" };

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
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
      await pool.end();
    }
  });

  test("creates, revises and archives without exposing storage keys", async () => {
    const changesBefore = (await knowledge.changesSince()).next_cursor;
    const asset = await assets.create({
      filename: "canonical-diagram.png",
      content_type: "image/png",
      size_bytes: 1234,
      sha256: "a".repeat(64),
      width: 640,
      height: 480,
      duration_seconds: 1.25,
    });
    createdDocumentIds.add(asset.object.object_id);
    expect(Object.keys(asset.object).sort()).toEqual([
      "content_hash", "content_type", "created_at", "deleted_at",
      "duration_seconds", "filename", "height", "object_id", "public_id",
      "size_bytes", "width",
    ]);
    expect(asset.object).toMatchObject({
      size_bytes: "1234",
      duration_seconds: "1.25",
      public_id: null,
    });
    // The storage locator is an explicit internal handoff.
    expect(asset.storage.blob_key).toBe(`blobs/${asset.object.object_id}`);
    expect(await assets.getForStorage(asset.object.object_id)).toEqual({
      object_id: asset.object.object_id,
      blob_key: asset.storage.blob_key,
      filename: asset.object.filename,
      content_type: asset.object.content_type,
      size_bytes: asset.object.size_bytes,
      content_hash: asset.object.content_hash,
    });

    const dangling = randomUUID();
    const createdBody = [
      `![Diagram](context-use://object/${asset.object.object_id})`,
      `[Missing](context-use://object/${dangling})`,
    ].join("\n\n");
    const created = await knowledge.create({
      title: "Canonical lifecycle",
      summary: "A document used to verify identity-based mutation.",
      body_markdown: createdBody,
      commit_message: "Create canonical lifecycle document",
    }, actor);
    createdDocumentIds.add(created.object_id);
    expect(created).not.toHaveProperty("body_object_key");
    expect(created).toMatchObject({
      revision_number: 1,
      current_link_contract: "generic_document_v1",
      search_ready: true,
    });

    const receipt = await pool.query<{ target_document_ids: string[] }>(
      "SELECT target_document_ids FROM knowledge_revision_contracts WHERE revision_id=$1",
      [created.current_revision_id],
    );
    expect(receipt.rows[0]!.target_document_ids).toEqual(
      [asset.object.object_id, dangling].sort(),
    );
    expect((await pool.query<{ target_document_id: string }>(
      "SELECT target_document_id FROM document_links WHERE source_revision_id=$1",
      [created.current_revision_id],
    )).rows).toEqual([{ target_document_id: asset.object.object_id }]);
    expect((await pool.query<{ target_asset_id: string }>(
      "SELECT target_asset_id FROM knowledge_asset_links WHERE source_version_id=$1",
      [created.current_revision_id],
    )).rows).toEqual([{ target_asset_id: asset.object.object_id }]);

    // A legacy-only active retention edge must still block archival. Replaying
    // Retained publication evidence repairs the exact generic graph from the immutable receipt.
    await pool.query(
      "DELETE FROM document_links WHERE source_revision_id=$1",
      [created.current_revision_id],
    );
    await expect(assets.archive({ object_id: asset.object.object_id }))
      .rejects.toBeInstanceOf(AssetArchiveConflictError);
    await pool.query(
      "SELECT register_generic_knowledge_revision($1,$2,$3::uuid[])",
      [created.current_revision_id, createdBody,
        [asset.object.object_id, dangling].sort()],
    );
    await expect(assets.archive({ object_id: asset.object.object_id }))
      .rejects.toBeInstanceOf(AssetArchiveConflictError);
    const objectCount = bodies.bodies.size;
    await expect(knowledge.update(created.object_id, {
      title: "Stale",
      summary: "A stale update must not allocate immutable object bytes.",
      body_markdown: "stale",
      commit_message: "Attempt stale update",
      expected_revision_number: 99,
    }, actor)).rejects.toBeInstanceOf(VersionConflictError);
    expect(bodies.bodies.size).toBe(objectCount);

    const updated = await knowledge.update(created.object_id, {
      title: "Canonical lifecycle updated",
      summary: "The active asset retention edge has been removed.",
      body_markdown: "Searchable current body term canonicalcurrentneedle",
      commit_message: "Remove asset reference",
      expected_revision_number: 1,
    }, actor);
    expect(updated?.revision_number).toBe(2);
    const deletedAsset = await assets.archive({ object_id: asset.object.object_id });
    expect(deletedAsset?.deleted_at).not.toBeNull();
    expect(await assets.getForStorage(asset.object.object_id)).toBeNull();
    expect(await assets.getDeletedForStorage(asset.object.object_id)).toEqual({
      object_id: asset.object.object_id,
      blob_key: asset.storage.blob_key,
    });

    const tombstoneLinked = await knowledge.update(created.object_id, {
      title: "Canonical lifecycle updated",
      summary: "Deleted asset identity remains linkable without retaining its bytes.",
      body_markdown: `[Deleted asset](context-use://object/${asset.object.object_id})`,
      commit_message: "Link asset tombstone",
      expected_revision_number: 2,
    }, actor);
    expect((await pool.query(
      "SELECT 1 FROM document_links WHERE source_revision_id=$1 AND target_document_id=$2",
      [tombstoneLinked!.current_revision_id, asset.object.object_id],
    )).rowCount).toBe(1);
    expect((await pool.query(
      "SELECT 1 FROM knowledge_asset_links WHERE source_version_id=$1",
      [tombstoneLinked!.current_revision_id],
    )).rowCount).toBe(0);

    const history = await knowledge.history(created.object_id, { limit: Number.NaN });
    expect(history.revisions.map(({ revision_number }) => revision_number)).toEqual([3, 2, 1]);
    expect(await knowledge.revision(created.object_id, 2)).toMatchObject({
      object_id: created.object_id,
      revision_number: 2,
      title: "Canonical lifecycle updated",
      body_markdown: "Searchable current body term canonicalcurrentneedle",
    });
    expect(await knowledge.revision(created.object_id, 99)).toBeNull();
    const archived = await knowledge.archive(created.object_id, {
      commit_message: "Archive canonical lifecycle page",
      expected_revision_number: 3,
    }, actor);
    expect(archived).toMatchObject({ revision_number: 4 });
    expect(archived?.archived_at).not.toBeNull();

    const changes = await knowledge.changesSince({ cursor: changesBefore });
    const archivedChange = changes.changes.find(({ object_id, change_kind }) => (
      object_id === created.object_id && change_kind === "archived"
    ));
    expect(archivedChange)
      .toMatchObject({
        object_id: created.object_id,
        revision_id: archived!.current_revision_id,
        revision_number: 4,
        previous_revision_number: null,
        change_kind: "archived",
        title: "Canonical lifecycle updated",
      });
    expect(archivedChange).not.toHaveProperty("path");
    expect(await knowledge.oldestRetainedRevisionAfter(created.object_id, 1, 4))
      .toMatchObject({
        object_id: created.object_id,
        revision_number: 2,
        body_markdown: "Searchable current body term canonicalcurrentneedle",
      });
  });

  test("lists and deletes standalone assets through stable object identities", async () => {
    const created = await assets.create({
      filename: "standalone.txt",
      content_type: "text/plain",
      size_bytes: 12,
      sha256: "b".repeat(64),
    });
    createdDocumentIds.add(created.object.object_id);
    expect(await assets.list()).toContainEqual(created.object);
    expect(await assets.delete(created.object.object_id)).toBe(created.storage.blob_key);
    expect(await assets.get(created.object.object_id)).toBeNull();
    expect(await assets.getForStorage(created.object.object_id)).toBeNull();
  });

  test("searches and navigates the unified private catalog with stable shapes", async () => {
    const target = await knowledge.create({
      title: "Running résumé playbook",
      summary: "The strongest title match for a ranked search.",
      body_markdown: "target body",
      commit_message: "Create ranked target",
    }, actor);
    createdDocumentIds.add(target.object_id);
    const dangling = randomUUID();
    const source = await knowledge.create({
      title: "Catalog source metadataalpha",
      summary: "A source object for neighborhood pagination.",
      body_markdown: [
        `[Target](context-use://object/${target.object_id})`,
        `[Dangling](context-use://object/${dangling})`,
        "running canonicalbodyneedle",
      ].join("\n\n"),
      commit_message: "Create neighborhood source",
    }, actor);
    createdDocumentIds.add(source.object_id);
    const secondSource = await knowledge.create({
      title: "Second catalog source",
      summary: "A second source used to paginate backlinks.",
      body_markdown: `[Target](context-use://object/${target.object_id})`,
      commit_message: "Create second backlink source",
    }, actor);
    createdDocumentIds.add(secondSource.object_id);
    const asset = await assets.create({
      filename: "catalog-search-needle.webm",
      content_type: "video/webm",
      size_bytes: 900719,
      sha256: "b".repeat(64),
      width: 1920,
      height: 1080,
      duration_seconds: 12.5,
    });
    createdDocumentIds.add(asset.object.object_id);
    const remote = await records.write({
      integration: "canonical-test",
      connectionInstanceId: 987654,
      connectionId: `connection-${randomUUID()}`,
      model: "note",
      sourceRecordId: randomUUID(),
      action: "added",
      sourceUpdatedAt: new Date().toISOString(),
      markdown: "remote connector body remotefulltextneedle catalog-search-needle",
    });
    createdDocumentIds.add(remote.object_id);

    const assetCatalog = await catalog.get(asset.object.object_id);
    expect(assetCatalog).toMatchObject({
      object_kind: "asset",
      size_bytes: "900719",
      duration_seconds: "12.5",
      width: 1920,
      height: 1080,
    });
    expect(assetCatalog).not.toHaveProperty("object_key");
    expect(typeof assetCatalog!.created_at).toBe("string");

    const ranked = await catalog.search("Running", { object_kind: "page" });
    expect(ranked.objects[0]?.object_id).toBe(target.object_id);
    const mixedVector = await knowledge.create({
      title: "Running metadata-only term",
      summary: "The second term exists only in the body search chunks.",
      body_markdown: "mixedvectorbodyneedle",
      commit_message: "Create mixed-vector search fixture",
    }, actor);
    createdDocumentIds.add(mixedVector.object_id);
    expect((await catalog.search("Running mixedvectorbodyneedle", {
      object_kind: "page",
    })).objects.map(({ object_id }) => object_id)).toContain(mixedVector.object_id);
    expect((await catalog.search("résumé", {
      object_kind: "page",
    })).objects.map(({ object_id }) => object_id)).toContain(target.object_id);
    expect((await catalog.search("canonicalbodyneedle", {
      object_kind: "page",
    })).objects.map(({ object_id }) => object_id)).toContain(source.object_id);
    expect((await catalog.search("metadataalpha canonicalbodyneedle", {
      object_kind: "page",
    })).objects.map(({ object_id }) => object_id)).toContain(source.object_id);
    expect((await catalog.search("remotefulltextneedle", {
      authority: "source",
    })).objects.map(({ object_id }) => object_id)).toContain(remote.object_id);
    expect((await catalog.search("catalog-search-needle", {
      representation: "asset",
    })).objects.map(({ object_id }) => object_id)).toContain(asset.object.object_id);
    const mixedTypes = await catalog.search("catalog-search-needle", {
      catalog_types: ["record", "asset"],
    });
    expect(mixedTypes.objects.map(({ object_id }) => object_id))
      .toContain(asset.object.object_id);
    expect(mixedTypes.objects.map(({ object_id }) => object_id))
      .toContain(remote.object_id);
    expect(mixedTypes.objects.every(({ object_kind, lifecycle }) => (
      (object_kind === "record" || object_kind === "asset") && lifecycle === "active"
    ))).toBe(true);
    expect((await catalog.list({
      authority: "source",
      integration: "canonical-test",
    })).objects.map(({ object_id }) => object_id)).toContain(remote.object_id);
    expect((await catalog.list({
      authority: "source",
      integration: "not-this-integration",
    })).objects).toEqual([]);
    expect((await catalog.list({
      operational_role: "global_guide",
    })).objects.every(({ operational_roles }) => (
      operational_roles.includes("global_guide")
    ))).toBe(true);

    const firstList = await catalog.list({
      object_kind: "asset",
      include_retired: true,
      limit: 1,
    });
    expect(firstList.objects).toHaveLength(1);
    expect(firstList.next_cursor).not.toBeNull();
    const secondList = await catalog.list({
      object_kind: "asset",
      include_retired: true,
      limit: 1,
      cursor: firstList.next_cursor!,
    });
    expect(secondList.objects[0]?.object_id)
      .not.toBe(firstList.objects[0]?.object_id);
    const cursorValue = JSON.parse(
      Buffer.from(firstList.next_cursor!, "base64url").toString("utf8"),
    ) as { document_id: string };
    cursorValue.document_id = cursorValue.document_id.toUpperCase();
    const mutated = Buffer.from(JSON.stringify(cursorValue), "utf8").toString("base64url");
    await expect(catalog.list({
      object_kind: "asset",
      include_retired: true,
      cursor: mutated,
    })).rejects.toBeInstanceOf(InvalidPrivateObjectCursorError);

    const firstNeighborhood = await catalog.neighborhood(source.object_id, {
      outbound_limit: 1,
    });
    expect(firstNeighborhood?.outbound.revision_id).toBe(source.current_revision_id);
    expect(firstNeighborhood?.outbound.index_complete).toBe(true);
    await pool.query(
      "DELETE FROM document_links WHERE source_revision_id=$1 AND target_document_id=$2",
      [source.current_revision_id, target.object_id],
    );
    expect((await catalog.neighborhood(source.object_id))?.outbound.index_complete).toBe(false);
    await pool.query(
      "SELECT register_generic_knowledge_revision($1,$2,$3::uuid[])",
      [source.current_revision_id, source.body_markdown,
        [target.object_id, dangling].sort()],
    );
    await pool.query(
      `INSERT INTO document_links(source_revision_id,target_document_id)
       VALUES ($1,$2)`,
      [source.current_revision_id, asset.object.object_id],
    );
    expect((await catalog.neighborhood(source.object_id))?.outbound.index_complete).toBe(false);
    await pool.query(
      "SELECT register_generic_knowledge_revision($1,$2,$3::uuid[])",
      [source.current_revision_id, source.body_markdown,
        [target.object_id, dangling].sort()],
    );
    expect((await catalog.neighborhood(source.object_id))?.outbound.index_complete).toBe(true);
    expect(firstNeighborhood?.outbound.neighbors).toHaveLength(1);
    expect(firstNeighborhood?.outbound.has_more).toBe(true);
    await expect(catalog.neighborhood(source.object_id, {
      outbound_after_object_id: firstNeighborhood!.outbound.next_cursor!,
    })).rejects.toBeInstanceOf(InvalidPrivateObjectCursorError);
    const secondNeighborhood = await catalog.neighborhood(source.object_id, {
      requested_revision_id: firstNeighborhood!.outbound.revision_id!,
      outbound_after_object_id: firstNeighborhood!.outbound.next_cursor!,
      outbound_limit: 1,
    });
    expect(secondNeighborhood?.outbound.neighbors).toHaveLength(1);
    expect([
      ...firstNeighborhood!.outbound.neighbors,
      ...secondNeighborhood!.outbound.neighbors,
    ].map(({ target_object_id }) => target_object_id).sort()).toEqual(
      [target.object_id, dangling].sort(),
    );
    const targetNeighborhood = await catalog.neighborhood(target.object_id, {
      backlink_limit: 1,
    });
    expect(targetNeighborhood?.backlinks.has_more).toBe(true);
    const secondBacklinks = await catalog.neighborhood(target.object_id, {
      backlink_limit: 1,
      backlink_after_object_id: targetNeighborhood!.backlinks.next_cursor!,
    });
    expect([
      ...targetNeighborhood!.backlinks.objects,
      ...secondBacklinks!.backlinks.objects,
    ].map(({ object_id }) => object_id).sort()).toEqual(
      [source.object_id, secondSource.object_id].sort(),
    );
    expect(targetNeighborhood?.backlinks).toMatchObject({
      completeness_checked: false,
      complete: null,
    });
    const auditedNeighborhood = await catalog.neighborhood(target.object_id, {
      audit_global_completeness: true,
    });
    expect(auditedNeighborhood?.backlinks).toMatchObject({
      completeness_checked: true,
    });
    expect(typeof auditedNeighborhood?.backlinks.complete).toBe("boolean");
  });

  test("chunks near-limit hypermedia search safely", async () => {
    const token = (index: number): string => `t${index.toString(36).padStart(7, "0")}`;
    const tokenCount = 400_000;
    const largeBody = Array.from({ length: tokenCount }, (_, index) => token(index)).join(" ");
    expect(Buffer.byteLength(largeBody)).toBeGreaterThan(3_500_000);
    expect(Buffer.byteLength(largeBody)).toBeLessThan(4_000_000);
    const large = await knowledge.create({
      title: "Chunked canonical search",
      summary: "A near-limit body whose full-text index is revision-bound and bounded.",
      body_markdown: largeBody,
      commit_message: "Create chunked-search fixture",
    }, actor);
    createdDocumentIds.add(large.object_id);
    expect((await pool.query(
      "SELECT 1 FROM knowledge_search_chunks WHERE document_id=$1",
      [large.object_id],
    )).rowCount).toBeGreaterThan(50);
    for (const query of [token(6_827), token(tokenCount - 1)]) {
      expect((await catalog.search(query, {
        object_kind: "page",
      })).objects.map(({ object_id }) => object_id)).toContain(large.object_id);
    }
  }, 30_000);

  test("serializes active asset registration against archival", async () => {
    const asset = await assets.create({
      filename: "registration-race.png",
      content_type: "image/png",
      size_bytes: 42,
      sha256: "c".repeat(64),
    });
    createdDocumentIds.add(asset.object.object_id);
    const body = `[Race asset](context-use://object/${asset.object.object_id})`;
    const page = await knowledge.create({
      title: "Registration race",
      summary: "Pins the active-asset lifecycle lock order.",
      body_markdown: body,
      commit_message: "Create registration race fixture",
    }, actor);
    createdDocumentIds.add(page.object_id);
    await pool.query(
      "DELETE FROM document_links WHERE source_revision_id=$1",
      [page.current_revision_id],
    );
    await pool.query(
      "DELETE FROM knowledge_asset_links WHERE source_version_id=$1",
      [page.current_revision_id],
    );

    const registering = new Client({ connectionString: databaseUrl });
    await registering.connect();
    try {
      await registering.query("BEGIN");
      await registering.query(
        "SELECT register_generic_knowledge_revision($1,$2,$3::uuid[])",
        [page.current_revision_id, body, [asset.object.object_id]],
      );
      let archiveSettled = false;
      const archive = assets.archive({ object_id: asset.object.object_id })
        .finally(() => { archiveSettled = true; });
      await Bun.sleep(75);
      expect(archiveSettled).toBe(false);
      await registering.query("COMMIT");
      await expect(archive).rejects.toBeInstanceOf(AssetArchiveConflictError);
      expect((await pool.query(
        `SELECT 1 FROM knowledge_asset_links
         WHERE source_version_id=$1 AND target_asset_id=$2`,
        [page.current_revision_id, asset.object.object_id],
      )).rowCount).toBe(1);
    } finally {
      await registering.query("ROLLBACK").catch(() => undefined);
      await registering.end();
    }
  });

  test("keeps ranked cursors stable across microseconds and cursor-object mutation", async () => {
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
      createdDocumentIds.add(asset.object.object_id);
      await pool.query(
        "UPDATE hypermedia_documents SET updated_at=$2::timestamptz WHERE id=$1",
        [asset.object.object_id, `2026-08-22T12:00:00.123${micros}+00:00`],
      );
    }
    const first = await catalog.search(needle, {
      representation: "asset",
      include_retired: true,
      limit: 1,
    });
    expect(first.objects).toHaveLength(1);
    expect(first.next_cursor).not.toBeNull();
    const firstId = first.objects[0]!.object_id;
    await assets.archive({ object_id: firstId });
    const second = await catalog.search(needle, {
      representation: "asset",
      include_retired: true,
      limit: 1,
      cursor: first.next_cursor!,
    });
    expect(second.objects).toHaveLength(1);
    expect(second.objects[0]!.object_id).not.toBe(firstId);
    expect(cursorAssets.map(({ object }) => object.object_id))
      .toContain(second.objects[0]!.object_id);
  });

});
