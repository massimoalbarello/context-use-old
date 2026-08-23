import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client, Pool } from "pg";
import { disposableDatabaseUrl } from "../src/disposable-database.ts";
import {
  CorpusMigrationRepository,
  neutralPublicDirectoryTitle,
  type CorpusMigrationPlan,
  type LegacyCorpusPage,
} from "../src/corpus-migration.ts";
import { markdownObjectMetadata } from "../src/documents.ts";
import { extractDocumentLinks } from "../src/links.ts";

const databaseUrl = await disposableDatabaseUrl();
const describeDatabase = databaseUrl ? describe : describe.skip;

function bodyMetadata(revisionId: string, body: string) {
  return { id: revisionId, ...markdownObjectMetadata(revisionId, body) };
}

function sha256(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

function revisionReceipts(page: LegacyCorpusPage): string[] {
  return [...new Set([
    page.current_revision.revision_id,
    ...(page.published_revision ? [page.published_revision.revision_id] : []),
  ])].sort();
}

function artifactReceipts(page: LegacyCorpusPage): string[] {
  return page.published_artifact ? [page.published_artifact.artifact_id] : [];
}

describeDatabase("audited filesystem to hypermedia corpus migration", () => {
  let admin: Client;
  let pool: Pool;
  let repository: CorpusMigrationRepository;
  const createdDirectoryIds: string[] = [];
  const createdPageIds: string[] = [];
  const createdAssetIds: string[] = [];
  const createdSourceDocumentIds: string[] = [];
  const createdPublicIds: string[] = [];
  const createdArtifactIds: string[] = [];
  const runIds: string[] = [];
  const bodyByRevisionId = new Map<string, string>();
  let originalEntrypoint: string | null = null;

  beforeAll(async () => {
    admin = new Client({ connectionString: databaseUrl });
    await admin.connect();
    pool = new Pool({ connectionString: databaseUrl, max: 1 });
    const corpusClient = await pool.connect();
    await corpusClient.query("SET ROLE context_use_corpus");
    corpusClient.release();
    repository = new CorpusMigrationRepository(pool);
    originalEntrypoint = (await admin.query<{ entrypoint_page_id: string | null }>(
      "SELECT entrypoint_page_id FROM public_knowledge_settings WHERE singleton",
    )).rows[0]?.entrypoint_page_id ?? null;
  });

  afterAll(async () => {
    if (admin) {
      await admin.query("BEGIN").catch(() => undefined);
      try {
        await admin.query("SET CONSTRAINTS ALL DEFERRED");
        const fixtureDocumentIds = [...new Set([
          ...createdPageIds,
          ...createdAssetIds,
        ])];
        if (fixtureDocumentIds.length) {
          const resources = await admin.query<{ public_id: string }>(
            "SELECT public_id FROM public_resources WHERE document_id=ANY($1::uuid[])",
            [fixtureDocumentIds],
          );
          createdPublicIds.push(...resources.rows.map(({ public_id }) => public_id));
        }
        if (createdPageIds.length) {
          const artifacts = await admin.query<{ artifact_id: string }>(
            "SELECT artifact_id FROM published_page_artifacts WHERE page_id=ANY($1::uuid[])",
            [createdPageIds],
          );
          createdArtifactIds.push(...artifacts.rows.map(({ artifact_id }) => artifact_id));
        }
        await admin.query("DELETE FROM automation_registry");
        await admin.query("DELETE FROM directory_hub_migrations");
        if (runIds.length) {
          await admin.query("DELETE FROM corpus_migration_runs WHERE id=ANY($1::uuid[])", [runIds]);
        }
        await admin.query(
          "UPDATE public_knowledge_settings SET entrypoint_page_id=$1 WHERE singleton",
          [originalEntrypoint],
        );
        if (createdPageIds.length) {
          await admin.query(
            `UPDATE knowledge_pages
             SET published_version_id=NULL,public_path=NULL,archived_at=now()
             WHERE id=ANY($1::uuid[])`,
            [createdPageIds],
          );
        }
        if (createdPublicIds.length) {
          const uniquePublicIds = [...new Set(createdPublicIds)];
          // The database is explicitly disposable. Disable append-only guards
          // only around permanent public identity teardown, then restore normal
          // lifecycle/cascade triggers for every private fixture below.
          await admin.query("SET LOCAL session_replication_role=replica");
          await admin.query(
            "DELETE FROM public_route_aliases WHERE public_id=ANY($1::uuid[])",
            [uniquePublicIds],
          );
          await admin.query(
            "DELETE FROM public_visibility_generations WHERE public_id=ANY($1::uuid[])",
            [uniquePublicIds],
          );
          await admin.query(
            "DELETE FROM public_resources WHERE public_id=ANY($1::uuid[])",
            [uniquePublicIds],
          );
          if (createdArtifactIds.length) {
            await admin.query(
              `DELETE FROM public_artifact_id_reservations
               WHERE artifact_id=ANY($1::uuid[])`,
              [[...new Set(createdArtifactIds)]],
            );
          }
          await admin.query("SET LOCAL session_replication_role=origin");
        }
        if (createdPageIds.length) {
          await admin.query("DELETE FROM knowledge_page_versions WHERE page_id=ANY($1::uuid[])", [createdPageIds]);
          await admin.query("DELETE FROM knowledge_pages WHERE id=ANY($1::uuid[])", [createdPageIds]);
        }
        if (createdAssetIds.length) {
          await admin.query("DELETE FROM assets WHERE id=ANY($1::uuid[])", [createdAssetIds]);
        }
        if (fixtureDocumentIds.length) {
          await admin.query("SET LOCAL session_replication_role=replica");
          await admin.query(
            `DELETE FROM publication_target_generations
             WHERE target_document_id=ANY($1::uuid[])`,
            [fixtureDocumentIds],
          );
          await admin.query("SET LOCAL session_replication_role=origin");
        }
        if (createdSourceDocumentIds.length) {
          await admin.query("DELETE FROM source_records WHERE document_id=ANY($1::uuid[])", [createdSourceDocumentIds]);
          await admin.query("DELETE FROM hypermedia_documents WHERE id=ANY($1::uuid[])", [createdSourceDocumentIds]);
        }
        for (const directoryId of [...createdDirectoryIds].reverse()) {
          await admin.query("DELETE FROM knowledge_directories WHERE id=$1", [directoryId]);
        }
        await admin.query("COMMIT");
      } catch {
        await admin.query("ROLLBACK").catch(() => undefined);
      }
      await admin.end().catch(() => undefined);
    }
    await pool?.end().catch(() => undefined);
  });

  async function ensureRootGuide(): Promise<{ pageId: string; revisionId: string }> {
    const existing = await admin.query<{ id: string; current_version_id: string }>(
      "SELECT id,current_version_id FROM knowledge_pages WHERE current_path='agents'",
    );
    if (existing.rows[0]) {
      if (!bodyByRevisionId.has(existing.rows[0].current_version_id)) {
        await admin.query(
          "SELECT replace_document_links($1,'{}'::uuid[])",
          [existing.rows[0].current_version_id],
        );
        bodyByRevisionId.set(existing.rows[0].current_version_id, "");
      }
      return { pageId: existing.rows[0].id, revisionId: existing.rows[0].current_version_id };
    }
    const pageId = randomUUID();
    const revisionId = randomUUID();
    const body = "# Global guide\n";
    const object = bodyMetadata(revisionId, body);
    await admin.query("BEGIN");
    try {
      await admin.query("SET CONSTRAINTS ALL DEFERRED");
      await admin.query(
        "INSERT INTO hypermedia_documents(id,authority,representation) VALUES ($1,'knowledge','markdown')",
        [pageId],
      );
      await admin.query(
        `INSERT INTO hypermedia_document_revisions(
           id,document_id,revision_number,body_object_key,body_size_bytes,body_content_hash
         ) VALUES ($1,$2,1,$3,$4,$5)`,
        [revisionId, pageId, object.body_object_key, object.body_size_bytes, object.body_content_hash],
      );
      await admin.query(
        `INSERT INTO knowledge_pages(id,current_path,current_version_id,search_vector)
         VALUES ($1,'agents',$2,page_search_vector('agents','AGENTS.md','Global guide.',$3))`,
        [pageId, revisionId, body],
      );
      await admin.query(
        `INSERT INTO knowledge_page_versions(
           id,page_id,version_number,path,title,summary,commit_message,actor_kind,actor_subject
         ) VALUES ($1,$2,1,'agents','AGENTS.md','Global guide.',
           'Create global guide','dashboard','test')`,
        [revisionId, pageId],
      );
      await admin.query("SELECT replace_document_links($1,'{}'::uuid[])", [revisionId]);
      await admin.query("COMMIT");
    } catch (error) {
      await admin.query("ROLLBACK");
      throw error;
    }
    bodyByRevisionId.set(revisionId, body);
    return { pageId, revisionId };
  }

  async function createDirectory(path: string, title: string): Promise<string> {
    const id = randomUUID();
    const parentPath = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    if (parentPath && !(await admin.query(
      "SELECT 1 FROM knowledge_directories WHERE current_path=$1",
      [parentPath],
    )).rowCount) {
      throw new Error(`Missing fixture parent ${parentPath}`);
    }
    await admin.query(
      `INSERT INTO knowledge_directories(id,current_path,title,summary,search_vector)
       VALUES ($1,$2,$3,$4,directory_search_vector($2,$3,$4,''))`,
      [id, path, title, `Fixture directory ${title}.`],
    );
    createdDirectoryIds.push(id);
    return id;
  }

  async function createPublishedPageMovedOutOfDirectory(
    publicDirectoryPath: string,
  ): Promise<{
    pageId: string;
    currentRevisionId: string;
    publishedRevisionId: string;
    artifactId: string;
    danglingHistoricalDocumentId: string;
    danglingCurrentDocumentId: string;
  }> {
    const pageId = randomUUID();
    const publishedRevisionId = randomUUID();
    const currentRevisionId = randomUUID();
    const artifactId = randomUUID();
    const danglingHistoricalDocumentId = randomUUID();
    const danglingCurrentDocumentId = randomUUID();
    const publicBody = `# Public intro\n\n[Deleted historical ref](context-use://document/${danglingHistoricalDocumentId})\n`;
    const privateBody = `# Private working title\n\n[Unresolved current ref](context-use://document/${danglingCurrentDocumentId})\n`;
    const publicObject = bodyMetadata(publishedRevisionId, publicBody);
    const privateObject = bodyMetadata(currentRevisionId, privateBody);
    const publicPath = `${publicDirectoryPath}/intro`;
    const publishedVersionDirectoryPath = `legacy-public-${pageId}`;
    const publishedVersionPath = `${publishedVersionDirectoryPath}/intro`;
    const privatePath = `private-draft-${pageId}`;
    await createDirectory(publishedVersionDirectoryPath, "Legacy published metadata");
    await admin.query("BEGIN");
    try {
      await admin.query("SET CONSTRAINTS ALL DEFERRED");
      await admin.query(
        "INSERT INTO hypermedia_documents(id,authority,representation) VALUES ($1,'knowledge','markdown')",
        [pageId],
      );
      for (const [revisionId, number, object] of [
        [publishedRevisionId, 1, publicObject],
        [currentRevisionId, 2, privateObject],
      ] as const) {
        await admin.query(
          `INSERT INTO hypermedia_document_revisions(
             id,document_id,revision_number,body_object_key,body_size_bytes,body_content_hash
           ) VALUES ($1,$2,$3,$4,$5,$6)`,
          [revisionId, pageId, number, object.body_object_key,
            object.body_size_bytes, object.body_content_hash],
        );
      }
      await admin.query(
        `INSERT INTO knowledge_pages(id,current_path,current_version_id,search_vector)
         VALUES ($1,$2,$3,page_search_vector($2,'Public intro','Public page.',$4))`,
        [pageId, publishedVersionPath, publishedRevisionId, publicBody],
      );
      await admin.query(
        `INSERT INTO knowledge_page_versions(
           id,page_id,version_number,path,title,summary,commit_message,actor_kind,actor_subject
         ) VALUES
          ($1,$3,1,$4,'Public intro','Public page.','Publish fixture','dashboard','test'),
          ($2,$3,2,$5,'Private working title','Private draft summary.','Move private draft','dashboard','test')`,
        [publishedRevisionId, currentRevisionId, pageId, publishedVersionPath, privatePath],
      );
      await admin.query(
        `UPDATE knowledge_pages
         SET published_version_id=$2,public_path=$3
         WHERE id=$1`,
        [pageId, publishedRevisionId, publicPath],
      );
      const generation = (await admin.query<{ generation: string }>(
        "SELECT generation::text FROM public_projection_state WHERE singleton",
      )).rows[0]!.generation;
      const projectedBody = "# Public intro\n\nProjected public body.\n";
      await admin.query(
        `INSERT INTO published_page_artifacts(
           page_id,version_id,projection_generation,artifact_id,body_object_key,
           body_size_bytes,body_content_hash
         ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [pageId, publishedRevisionId, generation, artifactId,
          `documents/public/${artifactId}.md`, Buffer.byteLength(projectedBody), sha256(projectedBody)],
      );
      await admin.query(
        `UPDATE knowledge_pages
         SET current_path=$2,current_version_id=$3,
           search_vector=page_search_vector($2,'Private working title','Private draft summary.',$4)
         WHERE id=$1`,
        [pageId, privatePath, currentRevisionId, privateBody],
      );
      await admin.query("SELECT replace_document_links($1,'{}'::uuid[])", [publishedRevisionId]);
      await admin.query("SELECT replace_document_links($1,'{}'::uuid[])", [currentRevisionId]);
      await admin.query("COMMIT");
    } catch (error) {
      await admin.query("ROLLBACK");
      throw error;
    }
    createdPageIds.push(pageId);
    bodyByRevisionId.set(publishedRevisionId, publicBody);
    bodyByRevisionId.set(currentRevisionId, privateBody);
    return {
      pageId,
      currentRevisionId,
      publishedRevisionId,
      artifactId,
      danglingHistoricalDocumentId,
      danglingCurrentDocumentId,
    };
  }

  async function completeOrdinaryItems(plan: CorpusMigrationPlan): Promise<void> {
    for (const page of plan.pages) {
      const body = bodyByRevisionId.get(page.current_revision.revision_id);
      if (body === undefined) throw new Error(`Missing fixture body for ${page.document_id}`);
      await repository.completeExisting({
        run_id: plan.run_id,
        item_kind: "page",
        item_id: page.document_id,
        verified_revision_ids: revisionReceipts(page),
        verified_public_artifact_ids: artifactReceipts(page),
        body_markdown_for_index: body,
        target_document_ids: extractDocumentLinks(body),
        actor_subject: "corpus-migration-test",
      });
    }
    for (const asset of plan.assets) {
      await repository.completeExisting({
        run_id: plan.run_id,
        item_kind: "asset",
        item_id: asset.document_id,
        verified_revision_ids: [],
        verified_public_artifact_ids: [],
        actor_subject: "corpus-migration-test",
      });
    }
    for (const record of plan.records) {
      await repository.completeExisting({
        run_id: plan.run_id,
        item_kind: "record",
        item_id: record.document_id,
        verified_revision_ids: record.current_revision ? [record.current_revision.revision_id] : [],
        verified_public_artifact_ids: [],
        actor_subject: "corpus-migration-test",
      });
    }
  }

  test("seals exact public/private state, preserves trailing aliases and resumes the same hub identity", async () => {
    const guide = await ensureRootGuide();
    const suffix = randomUUID();
    const publicDirectoryPath = `published-${"x".repeat(450)}-${suffix}`;
    const publicDirectoryId = await createDirectory(publicDirectoryPath, "Published fixture");
    await createDirectory(`scaffold-${suffix}`, "Empty scaffold");
    const published = await createPublishedPageMovedOutOfDirectory(publicDirectoryPath);
    await admin.query(
      "UPDATE public_knowledge_settings SET entrypoint_page_id=$1 WHERE singleton",
      [published.pageId],
    );

    const assetId = randomUUID();
    await admin.query(
      `INSERT INTO assets(
         id,current_path,filename,content_type,size_bytes,content_hash,s3_object_key
       ) VALUES ($1,$2,'private.bin','application/octet-stream',0,$3,$4)`,
      [assetId, `${publicDirectoryPath}/private-asset`, "0".repeat(64), `objects/${assetId}`],
    );
    createdAssetIds.push(assetId);
    await admin.query(
      `INSERT INTO knowledge_asset_links(source_version_id,target_asset_id)
       VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [published.currentRevisionId, assetId],
    );
    await admin.query(
      "SELECT replace_document_links($1,$2::uuid[])",
      [published.currentRevisionId, [assetId]],
    );

    const sourceDocumentId = randomUUID();
    const sourceRevisionId = randomUUID();
    await admin.query(
      `INSERT INTO hypermedia_documents(id,authority,representation)
       VALUES ($1,'source','markdown')`,
      [sourceDocumentId],
    );
    await admin.query(
      `INSERT INTO hypermedia_document_revisions(
         id,document_id,revision_number,body_object_key,body_size_bytes,body_content_hash
       ) VALUES ($1,$2,1,$3,0,$4)`,
      [sourceRevisionId, sourceDocumentId, `documents/private/${sourceRevisionId}.md`, "0".repeat(64)],
    );
    await admin.query(
      `INSERT INTO source_records(
         document_id,current_revision_id,integration,connection_id,connection_instance_id,
         model,source_record_id,source_updated_at
       ) VALUES ($1,$2,'fixture','reused-public-id',NULL,'message',$3,now())`,
      [sourceDocumentId, sourceRevisionId, suffix],
    );
    await admin.query("SELECT replace_document_links($1,'{}'::uuid[])", [sourceRevisionId]);
    const compatibilityRevisionId = randomUUID();
    const historicalUnindexedRevisionId = randomUUID();
    for (const [revisionId, number] of [
      [compatibilityRevisionId, 2],
      [historicalUnindexedRevisionId, 3],
    ] as const) {
      await admin.query(
        `INSERT INTO hypermedia_document_revisions(
           id,document_id,revision_number,body_object_key,body_size_bytes,body_content_hash
         ) VALUES ($1,$2,$3,$4,0,$5)`,
        [revisionId, sourceDocumentId, number,
          `documents/private/${revisionId}.md`, "0".repeat(64)],
      );
    }
    await expect(admin.query(
      "SELECT replace_document_links($1,$2::uuid[])",
      [compatibilityRevisionId, [published.pageId]],
    )).resolves.toBeDefined();
    expect((await admin.query(
      "SELECT 1 FROM document_links WHERE source_revision_id=$1",
      [compatibilityRevisionId],
    )).rowCount).toBe(0);
    await admin.query(
      "UPDATE source_records SET deleted_at=now() WHERE document_id=$1",
      [sourceDocumentId],
    );
    createdSourceDocumentIds.push(sourceDocumentId);

    const prunedTombstoneDocumentId = randomUUID();
    await admin.query(
      `INSERT INTO hypermedia_documents(id,authority,representation)
       VALUES ($1,'source','markdown')`,
      [prunedTombstoneDocumentId],
    );
    await admin.query(
      `INSERT INTO source_records(
         document_id,current_revision_id,integration,connection_id,connection_instance_id,
         model,source_record_id,source_updated_at,deleted_at
       ) VALUES ($1,NULL,'fixture','pruned-public-id',NULL,'message',$2,now(),now())`,
      [prunedTombstoneDocumentId, `pruned-${suffix}`],
    );
    createdSourceDocumentIds.push(prunedTombstoneDocumentId);

    const archivedDocumentId = randomUUID();
    const archivedRevisionId = randomUUID();
    const archivedBody = "# Archived readable identity\n";
    const archivedObject = bodyMetadata(archivedRevisionId, archivedBody);
    await admin.query("BEGIN");
    try {
      await admin.query("SET CONSTRAINTS ALL DEFERRED");
      await admin.query(
        "INSERT INTO hypermedia_documents(id,authority,representation) VALUES ($1,'knowledge','markdown')",
        [archivedDocumentId],
      );
      await admin.query(
        `INSERT INTO hypermedia_document_revisions(
           id,document_id,revision_number,body_object_key,body_size_bytes,body_content_hash
         ) VALUES ($1,$2,1,$3,$4,$5)`,
        [archivedRevisionId, archivedDocumentId, archivedObject.body_object_key,
          archivedObject.body_size_bytes, archivedObject.body_content_hash],
      );
      await admin.query(
        `INSERT INTO knowledge_pages(
           id,current_path,current_version_id,archived_at,search_vector
         ) VALUES ($1,$2,$3,now(),page_search_vector($2,'Archived','Archived readable identity.',$4))`,
        [archivedDocumentId, `archived-${suffix}`, archivedRevisionId, archivedBody],
      );
      await admin.query(
        `INSERT INTO knowledge_page_versions(
           id,page_id,version_number,path,title,summary,commit_message,actor_kind,actor_subject
         ) VALUES ($1,$2,1,$3,'Archived','Archived readable identity.',
           'Archive fixture','dashboard','test')`,
        [archivedRevisionId, archivedDocumentId, `archived-${suffix}`],
      );
      await admin.query("SELECT replace_document_links($1,'{}'::uuid[])", [archivedRevisionId]);
      await admin.query("COMMIT");
    } catch (error) {
      await admin.query("ROLLBACK");
      throw error;
    }
    createdPageIds.push(archivedDocumentId);

    const inspection = await repository.inspectSource();
    const publicDirectory = inspection.directories.find(({ directory_id }) => (
      directory_id === publicDirectoryId
    ));
    expect(publicDirectory?.legacy_public_reachable).toBe(true);
    expect(publicDirectory?.public_title).toBeNull();
    expect(publicDirectory?.public_summary).toBeNull();
    expect(publicDirectory?.direct_page_ids).toEqual([]);
    const inspectedPublished = inspection.pages.find(({ document_id }) => document_id === published.pageId)!;
    expect(inspectedPublished.path).toStartWith("private-draft-");
    expect(inspectedPublished.public_path).toBe(`${publicDirectoryPath}/intro`);
    expect(inspectedPublished.title).toBe("Private working title");
    expect(inspectedPublished.published_title).toBe("Public intro");
    expect(inspectedPublished.published_artifact?.artifact_id).toBe(published.artifactId);
    expect(inspection.records.find(({ document_id }) => document_id === sourceDocumentId)
      ?.connection_instance_id).toBeNull();
    expect(inspection.records.find(({ document_id }) => document_id === sourceDocumentId)
      ?.deleted_at).not.toBeNull();
    expect(inspection.records.find(({ document_id }) => document_id === prunedTombstoneDocumentId)
      ?.current_revision).toBeNull();
    expect(inspection.pages.some(({ document_id }) => document_id === archivedDocumentId)).toBe(false);
    expect(inspection.readable_document_ids).toContain(archivedDocumentId);

    const dispositions = inspection.directories.map((directory) => ({
      directory_id: directory.directory_id,
      disposition: directory.path === ""
        ? "root_entrypoint" as const
        : /^automations(?:\/|$)/.test(directory.path)
          ? directory.legacy_public_reachable || directory.has_existing_hub
            ? "public_compatibility" as const
            : "operational" as const
        : directory.directory_id === publicDirectoryId
          ? "hub" as const
          : "retired_template_scaffold" as const,
    }));
    const plan = await repository.beginOrResume({
      inventory_token: inspection.inventory_token,
      actor_subject: "corpus-migration-test",
      directories: dispositions,
      automations: [],
    });
    runIds.push(plan.run_id);
    const hub = plan.directories.find(({ directory_id }) => directory_id === publicDirectoryId)!.hub!;
    expect(hub.document_id).toBe(publicDirectoryId);
    expect(hub.private_revision_mode).toBe("render");
    expect(hub.public_revision_mode).toBe("render");
    expect(hub.public_revision).not.toBeNull();

    const guidePlan = plan.pages.find(({ document_id }) => document_id === guide.pageId)!;
    const danglingDocumentId = randomUUID();
    const guideBody = `# Global guide\n\n[Archived](context-use://document/${archivedDocumentId})\n\n[Unresolved](context-use://document/${danglingDocumentId})\n`;
    const guideObject = bodyMetadata(guidePlan.rewrite_revision!.revision_id, guideBody);
    await expect(repository.applyPage({
      run_id: plan.run_id,
      document_id: guide.pageId,
      source_revision_id: guidePlan.current_revision.revision_id,
      revision: guideObject,
      body_markdown_for_index: guideBody,
      target_document_ids: [],
      verified_source_revision_ids: [guidePlan.current_revision.revision_id],
      verified_public_artifact_ids: [],
      actor_subject: "corpus-migration-test",
    })).rejects.toThrow("link receipt does not match its Markdown");
    await repository.applyPage({
      run_id: plan.run_id,
      document_id: guide.pageId,
      source_revision_id: guidePlan.current_revision.revision_id,
      revision: guideObject,
      body_markdown_for_index: guideBody,
      target_document_ids: [archivedDocumentId, danglingDocumentId],
      verified_source_revision_ids: [guidePlan.current_revision.revision_id],
      verified_public_artifact_ids: [],
      actor_subject: "corpus-migration-test",
    });
    await expect(repository.applyPage({
      run_id: plan.run_id,
      document_id: guide.pageId,
      source_revision_id: guidePlan.current_revision.revision_id,
      revision: guideObject,
      body_markdown_for_index: guideBody,
      target_document_ids: [archivedDocumentId, danglingDocumentId],
      verified_source_revision_ids: [guidePlan.current_revision.revision_id],
      verified_public_artifact_ids: [],
      actor_subject: "corpus-migration-test",
    })).resolves.toBeUndefined();
    bodyByRevisionId.set(guidePlan.rewrite_revision!.revision_id, guideBody);
    for (const page of plan.pages.filter(({ document_id }) => document_id !== guide.pageId)) {
      const body = bodyByRevisionId.get(page.current_revision.revision_id)!;
      await repository.completeExisting({
        run_id: plan.run_id,
        item_kind: "page",
        item_id: page.document_id,
        verified_revision_ids: revisionReceipts(page),
        verified_public_artifact_ids: artifactReceipts(page),
        body_markdown_for_index: body,
        target_document_ids: extractDocumentLinks(body),
        actor_subject: "corpus-migration-test",
      });
    }
    for (const asset of plan.assets) {
      await repository.completeExisting({
        run_id: plan.run_id,item_kind: "asset",item_id: asset.document_id,
        verified_revision_ids: [],verified_public_artifact_ids: [],actor_subject: "corpus-migration-test",
      });
    }
    for (const record of plan.records) {
      await repository.completeExisting({
        run_id: plan.run_id,item_kind: "record",item_id: record.document_id,
        verified_revision_ids: record.current_revision ? [record.current_revision.revision_id] : [],
        verified_public_artifact_ids: [],actor_subject: "corpus-migration-test",
      });
    }
    expect((await admin.query(
      `SELECT 1 FROM document_links WHERE source_revision_id=ANY($1::uuid[])
       UNION ALL SELECT 1 FROM knowledge_asset_links WHERE source_version_id=ANY($1::uuid[])`,
      [[published.currentRevisionId, published.publishedRevisionId]],
    )).rowCount).toBe(0);
    expect((await admin.query(
      `SELECT 1 FROM document_links
       WHERE source_revision_id=$1 AND target_document_id=$2`,
      [published.publishedRevisionId, published.danglingHistoricalDocumentId],
    )).rowCount).toBe(0);

    const privateHubBody = `# Published fixture\n\n[Private asset](context-use://document/${assetId})\n`;
    const publicHubBody = hub.public_body_markdown!;
    const leakingPublicHubBody = `${publicHubBody}\nPrivate owner note and [asset](context-use://document/${assetId}) that must never be published.\n`;
    const unsafePublicHubBody = `# Published fixture\n\n[Private asset](context-use://document/${assetId})\n`;
    const missingGeneratedTargetId = randomUUID();
    const danglingGeneratedHubBody = `# Published fixture\n\n[Missing](context-use://document/${missingGeneratedTargetId})\n`;
    const privateHubObject = bodyMetadata(hub.private_revision.revision_id, privateHubBody);
    const publicHubObject = bodyMetadata(hub.public_revision!.revision_id, publicHubBody);
    const unsafePublicHubObject = bodyMetadata(hub.public_revision!.revision_id, unsafePublicHubBody);
    await admin.query("BEGIN");
    try {
      await admin.query("SET LOCAL ROLE context_use_corpus");
      await admin.query("SET CONSTRAINTS ALL DEFERRED");
      const leakedObject = bodyMetadata(hub.public_revision!.revision_id, leakingPublicHubBody);
      await admin.query(
        `INSERT INTO hypermedia_documents(id,authority,representation)
         VALUES ($1,'knowledge','markdown')`,
        [publicDirectoryId],
      );
      for (const [revision, object] of [
        [hub.public_revision!, leakedObject],
        [hub.private_revision, privateHubObject],
      ] as const) {
        await admin.query(
          `INSERT INTO hypermedia_document_revisions(
             id,document_id,revision_number,body_object_key,body_size_bytes,body_content_hash
           ) VALUES ($1,$2,$3,$4,$5,$6)`,
          [revision.revision_id, publicDirectoryId, revision.revision_number,
            object.body_object_key, object.body_size_bytes, object.body_content_hash],
        );
      }
      await admin.query(
        `INSERT INTO knowledge_pages(id,current_path,current_version_id,search_vector)
         VALUES ($1,$2,$3,page_search_vector($2,$4,$5,$6))`,
        [publicDirectoryId, hub.temporary_path, hub.private_revision.revision_id,
          "Published fixture", "Fixture directory Published fixture.", privateHubBody],
      );
      await admin.query(
        `INSERT INTO knowledge_page_versions(
           id,page_id,version_number,path,title,summary,commit_message,actor_kind,actor_subject
         ) VALUES
          ($1,$3,$4,$5,$6,$7,'Malicious public staging','dashboard','malicious-test'),
          ($2,$3,$8,$5,$9,$10,'Private staging','dashboard','malicious-test')`,
        [hub.public_revision!.revision_id, hub.private_revision.revision_id,
          publicDirectoryId, hub.public_revision!.revision_number, hub.temporary_path,
          neutralPublicDirectoryTitle(publicDirectoryPath),
          "Published knowledge formerly available under this public collection.",
          hub.private_revision.revision_number, "Published fixture",
          "Fixture directory Published fixture."],
      );
      await expect(admin.query(
        "SELECT register_directory_hub_migration($1,$2)",
        [plan.run_id, publicDirectoryId],
      )).rejects.toThrow("deterministic proof");
    } finally {
      await admin.query("ROLLBACK");
    }
    await expect(repository.applyHub({
      run_id: plan.run_id,
      directory_id: publicDirectoryId,
      private_revision: {
        ...bodyMetadata(hub.private_revision.revision_id, danglingGeneratedHubBody),
        body_markdown_for_index: danglingGeneratedHubBody,
        target_document_ids: [missingGeneratedTargetId],
      },
      public_revision: {
        ...publicHubObject,body_markdown_for_index: publicHubBody,
        target_document_ids: [published.pageId],
      },
      actor_subject: "corpus-migration-test",
    })).rejects.toThrow("dangling document link");
    await expect(repository.applyHub({
      run_id: plan.run_id,
      directory_id: publicDirectoryId,
      private_revision: {
        ...privateHubObject,body_markdown_for_index: privateHubBody,target_document_ids: [assetId],
      },
      public_revision: {
        ...unsafePublicHubObject,body_markdown_for_index: unsafePublicHubBody,
        target_document_ids: [assetId],
      },
      actor_subject: "corpus-migration-test",
    })).rejects.toThrow("body does not match its deterministic proof");
    await expect(repository.applyHub({
      run_id: plan.run_id,
      directory_id: publicDirectoryId,
      private_revision: {
        ...privateHubObject,body_markdown_for_index: privateHubBody,target_document_ids: [assetId],
      },
      public_revision: {
        ...bodyMetadata(hub.public_revision!.revision_id, leakingPublicHubBody),
        body_markdown_for_index: leakingPublicHubBody,
        target_document_ids: [assetId, published.pageId].sort(),
      },
      actor_subject: "corpus-migration-test",
    })).rejects.toThrow("deterministic proof");
    await repository.applyHub({
      run_id: plan.run_id,
      directory_id: publicDirectoryId,
      private_revision: {
        ...privateHubObject,body_markdown_for_index: privateHubBody,target_document_ids: [assetId],
      },
      public_revision: {
        ...publicHubObject,body_markdown_for_index: publicHubBody,
        target_document_ids: [published.pageId],
      },
      actor_subject: "corpus-migration-test",
    });
    bodyByRevisionId.set(hub.private_revision.revision_id, privateHubBody);
    bodyByRevisionId.set(hub.public_revision!.revision_id, publicHubBody);
    createdPageIds.push(publicDirectoryId);
    const safeHubMetadata = (await admin.query<{ title: string; summary: string }>(
      "SELECT title,summary FROM knowledge_page_versions WHERE id=$1",
      [hub.public_revision!.revision_id],
    )).rows[0]!;
    expect(safeHubMetadata.title).toBe(neutralPublicDirectoryTitle(publicDirectoryPath));
    expect(safeHubMetadata.title.length).toBe(240);
    expect(safeHubMetadata.summary).toBe(
      "Published knowledge formerly available under this public collection.",
    );

    const sealed = await repository.seal(plan.run_id);
    expect(sealed.phase).toBe("ready");
    expect(sealed.blockers).toEqual([]);
    const firstReadyObjects = await repository.readyObjects(plan.run_id);
    expect(firstReadyObjects.find(({ document_id }) => document_id === guide.pageId))
      .toMatchObject({
        target_document_ids: [archivedDocumentId, danglingDocumentId].sort(),
        indexed_document_ids: [archivedDocumentId],
      });
    expect(firstReadyObjects.find(({ document_id }) => document_id === published.pageId))
      .toMatchObject({
        target_document_ids: [published.danglingCurrentDocumentId],
        indexed_document_ids: [],
      });
    const mapping = (await admin.query<{ public_id: string }>(
      "SELECT public_id FROM directory_hub_migrations WHERE directory_id=$1",
      [publicDirectoryId],
    )).rows[0]!;
    await admin.query("BEGIN");
    try {
      await expect(admin.query(
        `UPDATE knowledge_pages
         SET published_version_id=current_version_id,public_path=current_path
         WHERE id=$1`,
        [publicDirectoryId],
      )).rejects.toThrow("cannot be published");
    } finally {
      await admin.query("ROLLBACK");
    }
    await admin.query("BEGIN");
    try {
      await expect(admin.query(
        `INSERT INTO publication_intents(
           id,action,target_kind,target_id,version_id,public_path,
           owner_user_id,session_id,expires_at
         ) SELECT $1,'publish','page',page.id,page.current_version_id,page.current_path,
             'context-use-owner','corpus-hub-private',now()+interval '5 minutes'
           FROM knowledge_pages page WHERE page.id=$2`,
        [randomUUID(), publicDirectoryId],
      )).rejects.toThrow("cannot be published");
    } finally {
      await admin.query("ROLLBACK");
    }
    await admin.query("BEGIN");
    try {
      await expect(admin.query(
        "UPDATE knowledge_pages SET current_path=current_path||'-moved' WHERE id=$1",
        [publicDirectoryId],
      )).rejects.toThrow("cannot be moved");
    } finally {
      await admin.query("ROLLBACK");
    }
    expect((await admin.query(
      "SELECT 1 FROM public_route_aliases WHERE alias_path=$1 AND route_kind='directory'",
      [`/p/${publicDirectoryPath}/`],
    )).rowCount).toBe(1);
    expect((await admin.query(
      "SELECT 1 FROM public_route_aliases WHERE alias_path=ANY($1::text[])",
      [[`/p/${publicDirectoryPath}`, `/p/${publicDirectoryPath}.md`]],
    )).rowCount).toBe(0);

    await admin.query(
      `UPDATE knowledge_directories
       SET version_number=version_number+1,summary='Changed after first seal.',updated_at=now()
       WHERE id=$1`,
      [publicDirectoryId],
    );
    expect((await repository.status(plan.run_id)).phase).toBe("superseded");
    const secondInspection = await repository.inspectSource();
    expect(secondInspection.active_run_id).toBeNull();
    expect(secondInspection.pages.some(({ document_id }) => document_id === publicDirectoryId)).toBe(false);
    expect(secondInspection.directories.find(({ directory_id }) => directory_id === publicDirectoryId)
      ?.direct_page_ids).not.toContain(publicDirectoryId);
    const secondPlan = await repository.beginOrResume({
      inventory_token: secondInspection.inventory_token,
      actor_subject: "corpus-migration-test-2",
      directories: secondInspection.directories.map((directory) => ({
        directory_id: directory.directory_id,
        disposition: directory.path === ""
          ? "root_entrypoint" as const
          : /^automations(?:\/|$)/.test(directory.path)
            ? directory.legacy_public_reachable || directory.has_existing_hub
              ? "public_compatibility" as const
              : "operational" as const
          : directory.directory_id === publicDirectoryId
            ? "hub" as const
            : "retired_template_scaffold" as const,
      })),
      automations: [],
    });
    runIds.push(secondPlan.run_id);
    const secondHub = secondPlan.directories
      .find(({ directory_id }) => directory_id === publicDirectoryId)!.hub!;
    expect(secondHub.document_id).toBe(publicDirectoryId);
    expect(secondHub.public_id).toBe(mapping.public_id);
    expect(secondHub.private_revision_mode).toBe("existing");
    expect(secondHub.public_revision_mode).toBe("existing");
    expect(secondHub.private_source_revision?.revision_id).toBe(hub.private_revision.revision_id);
    expect(secondHub.public_source_revision?.revision_id).toBe(hub.public_revision!.revision_id);
    await completeOrdinaryItems(secondPlan);
    const secondPrivateBody = privateHubBody;
    const secondPublicBody = publicHubBody;
    await repository.applyHub({
      run_id: secondPlan.run_id,
      directory_id: publicDirectoryId,
      private_revision: {
        ...privateHubObject,
        body_markdown_for_index: secondPrivateBody,
        target_document_ids: [assetId],
      },
      public_revision: {
        ...bodyMetadata(secondHub.public_revision!.revision_id, secondPublicBody),
        body_markdown_for_index: secondPublicBody,
        target_document_ids: [published.pageId],
      },
      actor_subject: "corpus-migration-test-2",
    });
    bodyByRevisionId.set(secondHub.private_revision.revision_id, secondPrivateBody);
    bodyByRevisionId.set(secondHub.public_revision!.revision_id, secondPublicBody);
    expect((await repository.seal(secondPlan.run_id)).blockers).toEqual([]);
    expect((await admin.query<{ public_id: string }>(
      "SELECT public_id FROM directory_hub_migrations WHERE directory_id=$1",
      [publicDirectoryId],
    )).rows[0]?.public_id).toBe(mapping.public_id);
    let readyObjects = await repository.readyObjects(secondPlan.run_id);
    expect(readyObjects.find((object) => (
      object.document_id === publicDirectoryId && object.kind === "knowledge"
    ))).toMatchObject({
      revision: { revision_id: secondHub.private_revision.revision_id },
      target_document_ids: [assetId],
      target_asset_ids: [assetId],
    });

    await admin.query(
      `UPDATE knowledge_page_versions
       SET title='Renamed public intro',summary='Renamed public summary.'
       WHERE id=$1 AND page_id=$2`,
      [published.publishedRevisionId, published.pageId],
    );
    expect((await repository.status(secondPlan.run_id)).phase).toBe("superseded");
    const thirdInspection = await repository.inspectSource();
    const thirdPlan = await repository.beginOrResume({
      inventory_token: thirdInspection.inventory_token,
      actor_subject: "corpus-migration-test-3",
      directories: thirdInspection.directories.map((directory) => ({
        directory_id: directory.directory_id,
        disposition: directory.path === ""
          ? "root_entrypoint" as const
          : /^automations(?:\/|$)/.test(directory.path)
            ? directory.legacy_public_reachable || directory.has_existing_hub
              ? "public_compatibility" as const
              : "operational" as const
            : directory.directory_id === publicDirectoryId
              ? "hub" as const
              : "retired_template_scaffold" as const,
      })),
      automations: [],
    });
    runIds.push(thirdPlan.run_id);
    const thirdHub = thirdPlan.directories
      .find(({ directory_id }) => directory_id === publicDirectoryId)!.hub!;
    expect(thirdHub.private_revision_mode).toBe("copy");
    expect(thirdHub.public_revision_mode).toBe("render");
    expect(thirdHub.private_source_revision?.revision_id)
      .toBe(hub.private_revision.revision_id);
    await completeOrdinaryItems(thirdPlan);
    const thirdPrivateBody = privateHubBody;
    const thirdPublicBody = thirdHub.public_body_markdown!;
    await repository.applyHub({
      run_id: thirdPlan.run_id,
      directory_id: publicDirectoryId,
      private_revision: {
        ...bodyMetadata(thirdHub.private_revision.revision_id, thirdPrivateBody),
        body_markdown_for_index: thirdPrivateBody,
        target_document_ids: [assetId],
      },
      public_revision: {
        ...bodyMetadata(thirdHub.public_revision!.revision_id, thirdPublicBody),
        body_markdown_for_index: thirdPublicBody,
        target_document_ids: [published.pageId],
      },
      actor_subject: "corpus-migration-test-3",
    });
    bodyByRevisionId.set(thirdHub.private_revision.revision_id, thirdPrivateBody);
    bodyByRevisionId.set(thirdHub.public_revision!.revision_id, thirdPublicBody);
    expect((await repository.seal(thirdPlan.run_id)).blockers).toEqual([]);

    const ownerRevisionId = randomUUID();
    const ownerDanglingId = randomUUID();
    const ownerBody = `# Curated owner hub\n\n[Public intro](context-use://document/${published.pageId})\n\n[Unresolved owner ref](context-use://document/${ownerDanglingId})\n`;
    const ownerObject = bodyMetadata(ownerRevisionId, ownerBody);
    await admin.query("BEGIN");
    try {
      await admin.query("SET CONSTRAINTS ALL DEFERRED");
      await admin.query(
        `INSERT INTO hypermedia_document_revisions(
           id,document_id,revision_number,body_object_key,body_size_bytes,body_content_hash
        ) VALUES ($1,$2,$3,$4,$5,$6)`,
        [ownerRevisionId, publicDirectoryId,
          thirdHub.private_revision.revision_number + 1,
          ownerObject.body_object_key, ownerObject.body_size_bytes, ownerObject.body_content_hash],
      );
      await admin.query(
        `INSERT INTO knowledge_page_versions(
           id,page_id,version_number,path,title,summary,commit_message,actor_kind,actor_subject
        ) SELECT $1,$2,$3,current_path,'Curated owner hub','Owner-authored hub.',
             'Curate converted hub','dashboard','owner'
           FROM knowledge_pages WHERE id=$2`,
        [ownerRevisionId, publicDirectoryId, thirdHub.private_revision.revision_number + 1],
      );
      await admin.query(
        `UPDATE knowledge_pages
         SET current_version_id=$2,
           search_vector=page_search_vector(current_path,'Curated owner hub','Owner-authored hub.',$3)
         WHERE id=$1`,
        [publicDirectoryId, ownerRevisionId, ownerBody],
      );
      await admin.query(
        "SELECT replace_knowledge_revision_projections($1,$2::uuid[])",
        [ownerRevisionId, [published.pageId]],
      );
      await admin.query("COMMIT");
    } catch (error) {
      await admin.query("ROLLBACK");
      throw error;
    }
    bodyByRevisionId.set(ownerRevisionId, ownerBody);
    expect((await repository.status(thirdPlan.run_id)).phase).toBe("superseded");
    const fourthInspection = await repository.inspectSource();
    const fourthPlan = await repository.beginOrResume({
      inventory_token: fourthInspection.inventory_token,
      actor_subject: "corpus-migration-test-4",
      directories: fourthInspection.directories.map((directory) => ({
        directory_id: directory.directory_id,
        disposition: directory.path === ""
          ? "root_entrypoint" as const
          : /^automations(?:\/|$)/.test(directory.path)
            ? directory.legacy_public_reachable || directory.has_existing_hub
              ? "public_compatibility" as const
              : "operational" as const
            : directory.directory_id === publicDirectoryId
              ? "hub" as const
              : "retired_template_scaffold" as const,
      })),
      automations: [],
    });
    runIds.push(fourthPlan.run_id);
    const fourthHub = fourthPlan.directories
      .find(({ directory_id }) => directory_id === publicDirectoryId)!.hub!;
    expect(fourthHub.private_revision_mode).toBe("existing");
    expect(fourthHub.public_revision_mode).toBe("existing");
    expect(fourthHub.private_source_revision?.revision_id).toBe(ownerRevisionId);
    await completeOrdinaryItems(fourthPlan);
    await repository.applyHub({
      run_id: fourthPlan.run_id,
      directory_id: publicDirectoryId,
      private_revision: {
        ...ownerObject,
        body_markdown_for_index: ownerBody,
        target_document_ids: [published.pageId, ownerDanglingId],
      },
      public_revision: {
        ...bodyMetadata(fourthHub.public_revision!.revision_id, thirdPublicBody),
        body_markdown_for_index: thirdPublicBody,
        target_document_ids: [published.pageId],
      },
      actor_subject: "corpus-migration-test-4",
    });
    expect((await repository.seal(fourthPlan.run_id)).blockers).toEqual([]);
    readyObjects = await repository.readyObjects(fourthPlan.run_id);
    expect(readyObjects.find((object) => (
      object.document_id === publicDirectoryId && object.kind === "knowledge"
    ))).toMatchObject({
      revision: { revision_id: ownerRevisionId },
      target_document_ids: [ownerDanglingId, published.pageId].sort(),
      indexed_document_ids: [published.pageId],
    });
  }, 60_000);

  test("preserves public automation routes without turning compatibility carriers into managed private pages", async () => {
    await ensureRootGuide();
    const suffix = randomUUID();
    let automationsDirectoryId = (await admin.query<{ id: string }>(
      "SELECT id FROM knowledge_directories WHERE current_path='automations'",
    )).rows[0]?.id;
    if (!automationsDirectoryId) {
      automationsDirectoryId = await createDirectory("automations", "Automations");
    }
    const compatibilityPath = `automations/public-${suffix}`;
    const compatibilityDirectoryId = await createDirectory(
      compatibilityPath,
      "Private automation directory title",
    );
    const published = await createPublishedPageMovedOutOfDirectory(compatibilityPath);
    const refreshArtifactGeneration = async () => {
      await admin.query(
        `UPDATE published_page_artifacts artifact
         SET projection_generation=state.generation
         FROM public_projection_state state WHERE state.singleton`,
      );
    };
    await refreshArtifactGeneration();

    const priorRunId = runIds.at(-1)!;
    expect((await repository.status(priorRunId)).phase).toBe("superseded");

    const dispositionsFor = (inspection: Awaited<ReturnType<
      CorpusMigrationRepository["inspectSource"]
    >>) => inspection.directories.map((directory) => ({
      directory_id: directory.directory_id,
      disposition: directory.path === ""
        ? "root_entrypoint" as const
        : /^automations(?:\/|$)/.test(directory.path)
          ? directory.legacy_public_reachable || directory.has_existing_hub
            ? "public_compatibility" as const
            : "operational" as const
          : directory.has_existing_hub
            ? "hub" as const
            : "retired_template_scaffold" as const,
    }));
    const begin = async (actor: string) => {
      const inspection = await repository.inspectSource();
      const plan = await repository.beginOrResume({
        inventory_token: inspection.inventory_token,
        actor_subject: actor,
        directories: dispositionsFor(inspection),
        automations: [],
      });
      runIds.push(plan.run_id);
      await completeOrdinaryItems(plan);
      return plan;
    };
    const applyPreservedHub = async (
      plan: CorpusMigrationPlan,
      directoryId: string,
      actor: string,
      publicBodyOverride?: string,
    ) => {
      const directory = plan.directories.find(({ directory_id }) => (
        directory_id === directoryId
      ))!;
      const hub = directory.hub!;
      const privateBody = bodyByRevisionId.get(
        hub.private_source_revision?.revision_id ?? hub.private_revision.revision_id,
      );
      if (privateBody === undefined) throw new Error(`Missing hub body for ${directoryId}`);
      const publicBody = publicBodyOverride ?? (hub.public_revision
        ? hub.public_revision_mode === "render"
          ? hub.public_body_markdown
          : bodyByRevisionId.get(
              hub.public_source_revision?.revision_id ?? hub.public_revision.revision_id,
            )
        : null);
      if (hub.public_revision && publicBody === undefined) {
        throw new Error(`Missing public hub body for ${directoryId}`);
      }
      const resolvedPublicBody = publicBody ?? null;
      await repository.applyHub({
        run_id: plan.run_id,
        directory_id: directoryId,
        private_revision: {
          ...bodyMetadata(hub.private_revision.revision_id, privateBody),
          body_markdown_for_index: privateBody,
          target_document_ids: extractDocumentLinks(privateBody),
        },
        public_revision: hub.public_revision && resolvedPublicBody !== null ? {
          ...bodyMetadata(hub.public_revision.revision_id, resolvedPublicBody),
          body_markdown_for_index: resolvedPublicBody,
          target_document_ids: extractDocumentLinks(resolvedPublicBody),
        } : null,
        actor_subject: actor,
      });
      bodyByRevisionId.set(hub.private_revision.revision_id, privateBody);
      if (hub.public_revision && resolvedPublicBody !== null) {
        bodyByRevisionId.set(hub.public_revision.revision_id, resolvedPublicBody);
      }
    };

    const firstPlan = await begin("public-compatibility-1");
    const compatibilityDirectories = firstPlan.directories
      .filter(({ disposition }) => disposition === "public_compatibility")
      .sort((left, right) => right.path.split("/").length - left.path.split("/").length);
    expect(compatibilityDirectories.map(({ directory_id }) => directory_id))
      .toContain(compatibilityDirectoryId);
    expect(compatibilityDirectories.map(({ directory_id }) => directory_id))
      .toContain(automationsDirectoryId);
    for (const directory of firstPlan.directories.filter(({ disposition }) => (
      disposition === "hub"
    ))) {
      await applyPreservedHub(firstPlan, directory.directory_id, "public-compatibility-1");
    }
    for (const directory of compatibilityDirectories) {
      const hub = directory.hub!;
      expect(hub.private_revision_mode).toBe("render");
      expect(hub.public_revision_mode).toBe("render");
      const targets = directory.directory_id === compatibilityDirectoryId
        ? [published.pageId]
        : [compatibilityDirectoryId];
      const safeBody = hub.public_body_markdown!;
      if (directory.directory_id === compatibilityDirectoryId) {
        const omittedBody = `# ${neutralPublicDirectoryTitle(directory.path)}\n`;
        await expect(repository.applyHub({
          run_id: firstPlan.run_id,
          directory_id: directory.directory_id,
          private_revision: {
            ...bodyMetadata(hub.private_revision.revision_id, omittedBody),
            body_markdown_for_index: omittedBody,
            target_document_ids: [],
          },
          public_revision: {
            ...bodyMetadata(hub.public_revision!.revision_id, omittedBody),
            body_markdown_for_index: omittedBody,
            target_document_ids: [],
          },
          actor_subject: "public-compatibility-1",
        })).rejects.toThrow("deterministic proof");
      }
      await repository.applyHub({
        run_id: firstPlan.run_id,
        directory_id: directory.directory_id,
        private_revision: {
          ...bodyMetadata(hub.private_revision.revision_id, safeBody),
          body_markdown_for_index: safeBody,
          target_document_ids: targets,
        },
        public_revision: {
          ...bodyMetadata(hub.public_revision!.revision_id, safeBody),
          body_markdown_for_index: safeBody,
          target_document_ids: targets,
        },
        actor_subject: "public-compatibility-1",
      });
      bodyByRevisionId.set(hub.private_revision.revision_id, safeBody);
      bodyByRevisionId.set(hub.public_revision!.revision_id, safeBody);
      createdPageIds.push(directory.directory_id);
    }
    expect((await repository.seal(firstPlan.run_id)).blockers).toEqual([]);
    for (const directory of compatibilityDirectories) {
      expect((await admin.query(
        `SELECT 1 FROM public_route_aliases
         WHERE alias_path=$1 AND route_kind='directory'`,
        [`/p/${directory.path}/`],
      )).rowCount).toBe(1);
    }

    const firstCompatibilityHub = firstPlan.directories.find(({ directory_id }) => (
      directory_id === compatibilityDirectoryId
    ))!.hub!;
    const ownerRevisionId = randomUUID();
    const ownerDanglingId = randomUUID();
    const ownerBody = `# Owner-maintained compatibility page\n\n`
      + `[Published page](context-use://document/${published.pageId})\n\n`
      + `[Unresolved](context-use://document/${ownerDanglingId})\n`;
    const ownerObject = bodyMetadata(ownerRevisionId, ownerBody);
    await admin.query("BEGIN");
    try {
      await admin.query("SET CONSTRAINTS ALL DEFERRED");
      await admin.query(
        `INSERT INTO hypermedia_document_revisions(
           id,document_id,revision_number,body_object_key,body_size_bytes,body_content_hash
         ) VALUES ($1,$2,$3,$4,$5,$6)`,
        [ownerRevisionId, compatibilityDirectoryId,
          firstCompatibilityHub.private_revision.revision_number + 1,
          ownerObject.body_object_key, ownerObject.body_size_bytes, ownerObject.body_content_hash],
      );
      await admin.query(
        `INSERT INTO knowledge_page_versions(
           id,page_id,version_number,path,title,summary,commit_message,actor_kind,actor_subject
         ) SELECT $1,$2,$3,current_path,'Owner compatibility title',
             'Owner compatibility summary.','Owner edit','dashboard','owner'
           FROM knowledge_pages WHERE id=$2`,
        [ownerRevisionId, compatibilityDirectoryId,
          firstCompatibilityHub.private_revision.revision_number + 1],
      );
      await admin.query(
        `UPDATE knowledge_pages SET current_version_id=$2,
           search_vector=page_search_vector(
             current_path,'Owner compatibility title','Owner compatibility summary.',$3
           ) WHERE id=$1`,
        [compatibilityDirectoryId, ownerRevisionId, ownerBody],
      );
      await admin.query(
        "SELECT replace_knowledge_revision_projections($1,$2::uuid[])",
        [ownerRevisionId, [published.pageId]],
      );
      await admin.query(
        `UPDATE knowledge_page_versions
         SET title='Updated published title',summary='Updated published summary.'
         WHERE id=$1 AND page_id=$2`,
        [published.publishedRevisionId, published.pageId],
      );
      await admin.query("COMMIT");
    } catch (error) {
      await admin.query("ROLLBACK");
      throw error;
    }
    bodyByRevisionId.set(ownerRevisionId, ownerBody);
    await refreshArtifactGeneration();
    expect((await repository.status(firstPlan.run_id)).phase).toBe("superseded");

    const secondPlan = await begin("public-compatibility-2");
    for (const directory of secondPlan.directories
      .filter(({ hub }) => hub !== null)
      .sort((left, right) => right.path.split("/").length - left.path.split("/").length)) {
      const hub = directory.hub!;
      if (directory.directory_id === compatibilityDirectoryId) {
        expect(hub.private_revision_mode).toBe("copy");
        expect(hub.public_revision_mode).toBe("render");
        expect(hub.private_source_revision?.revision_id).toBe(ownerRevisionId);
        const updatedPublicBody = hub.public_body_markdown!;
        await applyPreservedHub(
          secondPlan,
          directory.directory_id,
          "public-compatibility-2",
          updatedPublicBody,
        );
      } else {
        await applyPreservedHub(secondPlan, directory.directory_id, "public-compatibility-2");
      }
    }
    expect((await repository.seal(secondPlan.run_id)).blockers).toEqual([]);
    const secondCompatibilityHub = secondPlan.directories.find(({ directory_id }) => (
      directory_id === compatibilityDirectoryId
    ))!.hub!;
    const copiedVersion = (await admin.query<{
      title: string;
      summary: string;
      body_content_hash: string;
    }>(
      `SELECT version.title,version.summary,revision.body_content_hash
       FROM knowledge_page_versions version
       JOIN hypermedia_document_revisions revision ON revision.id=version.id
       WHERE version.id=$1`,
      [secondCompatibilityHub.private_revision.revision_id],
    )).rows[0]!;
    expect(copiedVersion).toEqual({
      title: "Owner compatibility title",
      summary: "Owner compatibility summary.",
      body_content_hash: ownerObject.body_content_hash,
    });

    await admin.query(
      `UPDATE knowledge_pages
       SET published_version_id=NULL,public_path=NULL WHERE id=$1`,
      [published.pageId],
    );
    await refreshArtifactGeneration();
    expect((await repository.status(secondPlan.run_id)).phase).toBe("superseded");
    const thirdPlan = await begin("public-compatibility-3");
    for (const directory of thirdPlan.directories
      .filter(({ hub }) => hub !== null)
      .sort((left, right) => right.path.split("/").length - left.path.split("/").length)) {
      await applyPreservedHub(thirdPlan, directory.directory_id, "public-compatibility-3");
    }
    expect((await repository.seal(thirdPlan.run_id)).blockers).toEqual([]);
    const finalCompatibilityHub = thirdPlan.directories.find(({ directory_id }) => (
      directory_id === compatibilityDirectoryId
    ))!.hub!;
    expect(finalCompatibilityHub.private_revision_mode).toBe("existing");
    expect(finalCompatibilityHub.public_revision).toBeNull();
    expect((await admin.query<{ public_revision_id: string | null }>(
      `SELECT public_revision_id FROM directory_hub_migrations WHERE directory_id=$1`,
      [compatibilityDirectoryId],
    )).rows[0]?.public_revision_id).toBeNull();
    expect((await admin.query(
      "SELECT 1 FROM public_route_aliases WHERE alias_path=$1",
      [`/p/${compatibilityPath}/`],
    )).rowCount).toBe(1);
    expect((await admin.query<{ body_content_hash: string }>(
      `SELECT revision.body_content_hash
       FROM knowledge_pages page
       JOIN hypermedia_document_revisions revision ON revision.id=page.current_version_id
       WHERE page.id=$1`,
      [compatibilityDirectoryId],
    )).rows[0]?.body_content_hash).toBe(ownerObject.body_content_hash);
  }, 60_000);

  test("operational documents stay private across disablement and reset clears migration FKs", async () => {
    const guide = await ensureRootGuide();
    await admin.query("BEGIN");
    try {
      const operationalPageId = randomUUID();
      const operationalRevisionId = randomUUID();
      const body = "# Operational fixture\n";
      const object = bodyMetadata(operationalRevisionId, body);
      await admin.query("SET CONSTRAINTS ALL DEFERRED");
      await admin.query(
        "INSERT INTO hypermedia_documents(id,authority,representation) VALUES ($1,'knowledge','markdown')",
        [operationalPageId],
      );
      await admin.query(
        `INSERT INTO hypermedia_document_revisions(
           id,document_id,revision_number,body_object_key,body_size_bytes,body_content_hash
         ) VALUES ($1,$2,1,$3,$4,$5)`,
        [operationalRevisionId, operationalPageId,
          object.body_object_key, object.body_size_bytes, object.body_content_hash],
      );
      await admin.query(
        `INSERT INTO knowledge_pages(id,current_path,current_version_id,search_vector)
         VALUES ($1,$2,$3,page_search_vector($2,'Operational','Operational fixture.',$4))`,
        [operationalPageId, `operational-${operationalPageId}`, operationalRevisionId, body],
      );
      await admin.query(
        `INSERT INTO knowledge_page_versions(
           id,page_id,version_number,path,title,summary,commit_message,actor_kind,actor_subject
         ) VALUES ($1,$2,1,$3,'Operational','Operational fixture.','Create fixture','dashboard','test')`,
        [operationalRevisionId, operationalPageId, `operational-${operationalPageId}`],
      );
      await admin.query("SELECT replace_document_links($1,'{}'::uuid[])", [operationalRevisionId]);
      await admin.query(
        `UPDATE corpus_migration_runs
         SET phase='superseded',updated_at=now(),superseded_at=now()
         WHERE phase IN ('applying','ready')`,
      );
      const applyingRunId = randomUUID();
      const plannedKey = `fixture-${operationalPageId}`;
      const registryId = randomUUID();
      await admin.query(
        `INSERT INTO corpus_migration_runs(
           id,inventory_token,plan_token,settings_snapshot,readable_document_ids,actor_subject
         ) VALUES ($1,$2,$3,$4::jsonb,$5::uuid[],'corpus-operational-test')`,
        [applyingRunId, "a".repeat(64), "b".repeat(64), JSON.stringify({
          global_guide_document_id: guide.pageId,
          public_entrypoint_document_id: null,
        }), [operationalPageId, guide.pageId]],
      );
      await admin.query(
        `INSERT INTO corpus_migration_automation_plans(
           run_id,id,key,name,instructions_document_id
         ) VALUES ($1,$2,$3,'Operational fixture',$4)`,
        [applyingRunId, registryId, plannedKey, operationalPageId],
      );

      await admin.query("SAVEPOINT expected_planned_private");
      await expect(admin.query(
        `UPDATE knowledge_pages
         SET published_version_id=current_version_id,public_path=current_path
         WHERE id=$1`,
        [operationalPageId],
      )).rejects.toThrow("cannot be published");
      await admin.query("ROLLBACK TO SAVEPOINT expected_planned_private");
      await admin.query("SAVEPOINT expected_planned_guide_separation");
      await expect(admin.query(
        `UPDATE knowledge_settings
         SET global_guide_document_id=$1,updated_at=now() WHERE singleton`,
        [operationalPageId],
      )).rejects.toThrow("cannot be the global knowledge guide");
      await admin.query("ROLLBACK TO SAVEPOINT expected_planned_guide_separation");
      await admin.query("SAVEPOINT expected_planned_role_reuse");
      await expect(admin.query(
        `INSERT INTO automation_registry(id,key,name,instructions_document_id)
         VALUES ($1,$2,'Wrong planned role',$3)`,
        [randomUUID(), `wrong-${operationalPageId}`, operationalPageId],
      )).rejects.toThrow("reserved by the applying corpus plan");
      await admin.query("ROLLBACK TO SAVEPOINT expected_planned_role_reuse");

      await admin.query(
        `INSERT INTO automation_registry(id,key,name,instructions_document_id)
         VALUES ($1,$2,'Operational fixture',$3)`,
        [registryId, plannedKey, operationalPageId],
      );
      await admin.query("UPDATE automation_registry SET disabled_at=now() WHERE id=$1", [registryId]);

      await admin.query("SAVEPOINT expected_private");
      await expect(admin.query(
        `UPDATE knowledge_pages
         SET published_version_id=current_version_id,public_path=current_path
         WHERE id=$1`,
        [operationalPageId],
      )).rejects.toThrow("cannot be published");
      await admin.query("ROLLBACK TO SAVEPOINT expected_private");
      await admin.query("SAVEPOINT expected_archive");
      await expect(admin.query(
        "UPDATE knowledge_pages SET archived_at=now() WHERE id=$1",
        [operationalPageId],
      )).rejects.toThrow("cannot be archived");
      await admin.query("ROLLBACK TO SAVEPOINT expected_archive");
      await admin.query("SAVEPOINT expected_automation_move");
      await expect(admin.query(
        "UPDATE knowledge_pages SET current_path=current_path||'-moved' WHERE id=$1",
        [operationalPageId],
      )).rejects.toThrow("cannot be moved");
      await admin.query("ROLLBACK TO SAVEPOINT expected_automation_move");
      await admin.query("SAVEPOINT expected_guide_move");
      await expect(admin.query(
        "UPDATE knowledge_pages SET current_path=current_path||'-moved' WHERE id=$1",
        [guide.pageId],
      )).rejects.toThrow("must remain active at agents");
      await admin.query("ROLLBACK TO SAVEPOINT expected_guide_move");
      await admin.query("SAVEPOINT expected_cross_role");
      await expect(admin.query(
        `INSERT INTO automation_registry(id,key,name,instructions_document_id,state_document_id)
         VALUES ($1,$2,'Cross role',$3,$4)`,
        [randomUUID(), `cross-${operationalPageId}`, guide.pageId, operationalPageId],
      )).rejects.toThrow("cannot be reused");
      await admin.query("ROLLBACK TO SAVEPOINT expected_cross_role");

      const resetIntentId = randomUUID();
      await admin.query(
        `INSERT INTO knowledge_export_intents(
           id,owner_user_id,session_id,created_at,expires_at,confirmed_at,
           download_started_at,reset_requested,download_completed_at
         ) VALUES ($1,'context-use-owner','corpus-reset-test',now()-interval '1 minute',
           now()+interval '1 hour',now(),now(),true,now())`,
        [resetIntentId],
      );
      const resetRevisionId = randomUUID();
      const resetBody = "# Reset guide\n";
      const resetObject = bodyMetadata(resetRevisionId, resetBody);
      await admin.query(
        `SELECT clear_knowledge(
           $1,'context-use-owner','corpus-reset-test',$2,$3,$4,$5,
           'Knowledge','Reset root.','AGENTS.md','Reset guide.',
           page_search_vector('agents','AGENTS.md','Reset guide.',$6),
           'Reset global guide','context-use-template/default'
         )`,
        [resetIntentId, resetRevisionId, resetObject.body_object_key,
          resetObject.body_size_bytes, resetObject.body_content_hash, resetBody],
      );
      expect((await admin.query("SELECT 1 FROM automation_registry")).rowCount).toBe(0);
      expect((await admin.query("SELECT 1 FROM directory_hub_migrations")).rowCount).toBe(0);
      expect((await admin.query(
        "SELECT 1 FROM corpus_migration_runs WHERE phase IN ('applying','ready')",
      )).rowCount).toBe(0);
      expect((await admin.query(
        "SELECT 1 FROM corpus_migration_automation_plans WHERE run_id=$1",
        [applyingRunId],
      )).rowCount).toBe(0);
      await admin.query("ROLLBACK");
    } catch (error) {
      await admin.query("ROLLBACK");
      throw error;
    }
    // PostgreSQL sequence advances/setval calls are not rolled back with the reset transaction.
    // Restore the next history key so this rollback regression remains repeatable on one database.
    await admin.query(
      `SELECT setval(
         pg_get_serial_sequence('knowledge_page_changes','change_sequence'),
         coalesce((SELECT max(change_sequence) FROM knowledge_page_changes),0)+1,
         false
       )`,
    );
  }, 30_000);
});
