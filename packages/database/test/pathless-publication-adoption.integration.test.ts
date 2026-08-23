import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { Client } from "pg";
import { disposableDatabaseUrl } from "../src/disposable-database.ts";
import { cleanupPathlessPublicationFixtures } from "./pathless-publication-fixture-cleanup.ts";

const databaseUrl = await disposableDatabaseUrl();
const describeDatabase = databaseUrl ? describe : describe.skip;
const hash = (value: string): string =>
  createHash("sha256").update(value).digest("hex");
const fixtureDocumentIds = new Set<string>();

type AdoptionTarget = {
  claim_token: string;
  adoption_kind: "legacy_page" | "legacy_asset" | "directory_hub";
  source_body_size_bytes: string;
  source_body_content_hash: string;
  public_title: string | null;
  public_summary: string | null;
  public_last_edited_at: string | null;
  public_filename: string | null;
  public_content_type: string | null;
  public_width: number | null;
  public_height: number | null;
  public_duration_seconds: string | null;
  projected_target_public_ids: string[];
  projection_receipt_hash: string;
  target_projection: unknown[];
};

async function asRole<T>(
  client: Client,
  role: string,
  action: () => Promise<T>,
): Promise<T> {
  await client.query(`SET ROLE ${role}`);
  try {
    return await action();
  } finally {
    await client.query("RESET ROLE");
  }
}

async function stageAdoption(
  client: Client,
  adoptionId: string,
  target: AdoptionTarget,
  overrides: { bodySize?: string; bodyHash?: string } = {},
): Promise<void> {
  await asRole(client, "context_use_storage", async () => {
    await client.query(
      `SELECT finalize_pathless_publication_adoption_claim(
         $1,$2,$3,$4::bigint,$5,$6,$7,$8::timestamptz,$9,$10,$11,$12,
         $13,$14::uuid[],$15::uuid[],$16
       )`,
      [
        target.claim_token,
        adoptionId,
        target.adoption_kind,
        overrides.bodySize ?? target.source_body_size_bytes,
        overrides.bodyHash ?? target.source_body_content_hash,
        target.public_title,
        target.public_summary,
        target.public_last_edited_at,
        target.public_filename,
        target.public_content_type,
        target.public_width,
        target.public_height,
        target.public_duration_seconds,
        target.projected_target_public_ids,
        target.projected_target_public_ids,
        target.projection_receipt_hash,
      ],
    );
  });
}

async function getAdoptionTarget(
  client: Client,
  adoptionId: string,
): Promise<AdoptionTarget> {
  return await asRole(client, "context_use_storage", async () => {
    const claim = (await client.query<{
      claim_token: string;
      authorization: Omit<AdoptionTarget, "claim_token">;
    }>(
      "SELECT * FROM claim_pathless_publication_adoption_artifact($1,$2)",
      [adoptionId, randomUUID()],
    )).rows[0]!;
    return { claim_token: claim.claim_token, ...claim.authorization };
  });
}

async function beginAdoption(
  client: Client,
  adoptionId: string,
  adoptionKind: AdoptionTarget["adoption_kind"],
  sourceDocumentId: string,
): Promise<Record<string, unknown>> {
  return await asRole(client, "context_use_corpus", async () =>
    (await client.query(
      "SELECT * FROM begin_pathless_publication_adoption($1,$2,$3)",
      [adoptionId, adoptionKind, sourceDocumentId],
    )).rows[0]!,
  );
}

async function applyAdoption(
  client: Client,
  adoptionId: string,
): Promise<string> {
  return await asRole(client, "context_use_corpus", async () =>
    (await client.query<{ phase: string }>(
      "SELECT apply_pathless_publication_adoption($1) AS phase",
      [adoptionId],
    )).rows[0]!.phase,
  );
}

async function seedLegacyAssetSource(client: Client): Promise<{
  assetId: string;
  publicId: string;
  currentPath: string;
}> {
  const assetId = randomUUID();
  const currentPath = `adoption-source-${randomUUID().slice(0, 8)}`;
  await client.query(
    `INSERT INTO assets(
       id,current_path,public_path,filename,content_type,size_bytes,
       content_hash,s3_object_key,width,height,duration_seconds
     ) VALUES ($1,$2,$2,'child.png','image/png',19,$3,$4,8,9,2.500)`,
    [assetId, currentPath, hash("d"), `objects/${assetId}`],
  );
  fixtureDocumentIds.add(assetId);
  const publicId = (await client.query<{ public_id: string }>(
    "SELECT public_id FROM public_resources WHERE document_id=$1",
    [assetId],
  )).rows[0]!.public_id;
  return { assetId, publicId, currentPath };
}

async function seedActiveAdoptedAsset(client: Client): Promise<{
  assetId: string;
  publicId: string;
  adoptionId: string;
}> {
  const source = await seedLegacyAssetSource(client);
  const adoptionId = randomUUID();
  await beginAdoption(client, adoptionId, "legacy_asset", source.assetId);
  const target = await getAdoptionTarget(client, adoptionId);
  await stageAdoption(client, adoptionId, target);
  expect(await applyAdoption(client, adoptionId)).toBe("applied");
  return { ...source, adoptionId };
}

async function seedLegacyPageSource(client: Client): Promise<{
  pageId: string;
  revisionId: string;
  publicId: string;
  currentPath: string;
}> {
  const pageId = randomUUID();
  const revisionId = randomUUID();
  const artifactId = randomUUID();
  const currentPath = `adoption-page-${randomUUID().slice(0, 8)}`;
  await client.query("BEGIN");
  await client.query("SET CONSTRAINTS ALL DEFERRED");
  try {
    await client.query(
      `INSERT INTO knowledge_pages(
         id,current_path,current_version_id,published_version_id,public_path
       ) VALUES ($1,$2,$3,$3,$2)`,
      [pageId, currentPath, revisionId],
    );
    await client.query(
      `INSERT INTO hypermedia_document_revisions(
         id,document_id,revision_number,body_object_key,body_size_bytes,
         body_content_hash,created_at
       ) VALUES ($1,$2,1,$3,37,$4,'2026-08-23 03:04:05.654321+00')`,
      [revisionId, pageId, `documents/private/${revisionId}.md`, hash("e")],
    );
    await client.query(
      `INSERT INTO knowledge_page_versions(
         id,page_id,version_number,path,title,summary,commit_message,
         actor_kind,actor_subject,created_at
       ) VALUES (
         $1,$2,1,$3,'Adoption source','A safe legacy page source.',
         'Seed adoption source','dashboard','context-use-owner',
         '2026-08-23 03:04:05.654321+00'
       )`,
      [revisionId, pageId, currentPath],
    );
    await client.query(
      `INSERT INTO published_page_artifacts(
         page_id,version_id,projection_generation,artifact_id,
         body_object_key,body_size_bytes,body_content_hash
       ) SELECT $1,$2,generation,$3,$4,43,$5
         FROM public_projection_state WHERE singleton`,
      [
        pageId,
        revisionId,
        artifactId,
        `documents/public/${artifactId}.md`,
        hash("f"),
      ],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
  const publicId = (await client.query<{ public_id: string }>(
    "SELECT public_id FROM public_resources WHERE document_id=$1",
    [pageId],
  )).rows[0]!.public_id;
  fixtureDocumentIds.add(pageId);
  return { pageId, revisionId, publicId, currentPath };
}

async function seedHubSource(client: Client): Promise<{
  pageId: string;
  publicId: string;
  privateRevisionId: string;
  publicRevisionId: string;
  runId: string;
  childAssetId: string;
  childPublicId: string;
}> {
  const child = await seedActiveAdoptedAsset(client);
  const pageId = randomUUID();
  const publicId = randomUUID();
  const privateRevisionId = randomUUID();
  const publicRevisionId = randomUUID();
  const runId = randomUUID();
  const temporaryPath = `hub-private-${randomUUID().slice(0, 8)}`;
  const legacyPath = `hub-public-${randomUUID().slice(0, 8)}`;

  await client.query("BEGIN");
  await client.query("SET CONSTRAINTS ALL DEFERRED");
  try {
    await client.query(
      `INSERT INTO knowledge_pages(id,current_path,current_version_id)
       VALUES ($1,$2,$3)`,
      [pageId, temporaryPath, privateRevisionId],
    );
    await client.query(
      `INSERT INTO hypermedia_document_revisions(
         id,document_id,revision_number,body_object_key,body_size_bytes,
         body_content_hash
       ) VALUES ($1,$2,1,$3,53,$4)`,
      [privateRevisionId, pageId, `documents/private/${privateRevisionId}.md`, hash("g")],
    );
    await client.query(
      `INSERT INTO knowledge_page_versions(
         id,page_id,version_number,path,title,summary,commit_message,
         actor_kind,actor_subject
       ) VALUES (
         $1,$2,1,$3,'Private directory hub','The private directory index.',
         'Create private hub','dashboard','fixture'
       )`,
      [privateRevisionId, pageId, temporaryPath],
    );
    await client.query(
      `INSERT INTO hypermedia_document_revisions(
         id,document_id,revision_number,body_object_key,body_size_bytes,
         body_content_hash,links_indexed_at,links_index_attempted_at
       ) VALUES ($1,$2,2,$3,59,$4,now(),now())`,
      [publicRevisionId, pageId, `documents/private/${publicRevisionId}.md`, hash("h")],
    );
    await client.query(
      `INSERT INTO knowledge_page_versions(
         id,page_id,version_number,path,title,summary,commit_message,
         actor_kind,actor_subject
       ) VALUES (
         $1,$2,2,$3,'Published collection','A projected public collection.',
         'Create public hub source','dashboard','fixture'
       )`,
      [publicRevisionId, pageId, legacyPath],
    );
    await client.query(
      `INSERT INTO document_links(source_revision_id,target_document_id)
       VALUES ($1,$2)`,
      [publicRevisionId, child.assetId],
    );
    await client.query(
      `INSERT INTO public_resources(public_id,document_id,resource_kind)
       VALUES ($1,$2,'page')`,
      [publicId, pageId],
    );
    await client.query(
      `INSERT INTO corpus_migration_runs(
         id,inventory_token,plan_token,settings_snapshot,readable_document_ids,
         phase,actor_subject,ready_at
       ) VALUES ($1,$2,$3,'{}'::jsonb,$4::uuid[],'ready','fixture',now())`,
      [runId, hash("i"), hash("j"), [pageId, child.assetId]],
    );
    await client.query(
      `INSERT INTO corpus_migration_inventory(
         run_id,item_kind,item_id,legacy_path,source_fingerprint,snapshot
       ) VALUES ($1,'directory',$2,$3,$4,'{}'::jsonb)`,
      [runId, pageId, legacyPath, hash("k")],
    );
    await client.query(
      `INSERT INTO corpus_migration_completions(
         run_id,item_kind,item_id,source_fingerprint,result_kind,
         output_document_id,output_revision_id,actor_subject,details
       ) VALUES (
         $1,'directory',$2,$3,'hub',$2,$4,'fixture',
         jsonb_build_object('public_target_document_ids',to_jsonb($5::uuid[]))
       )`,
      [runId, pageId, hash("k"), privateRevisionId, [child.assetId]],
    );
    await client.query(
      `INSERT INTO directory_hub_migrations(
         directory_id,document_id,migration_run_id,legacy_path,temporary_path,
         private_revision_id,public_revision_id,public_id,
         private_projection_fingerprint,public_projection_fingerprint
       ) VALUES ($1,$1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        pageId,
        runId,
        legacyPath,
        temporaryPath,
        privateRevisionId,
        publicRevisionId,
        publicId,
        hash("l"),
        hash("m"),
      ],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
  fixtureDocumentIds.add(pageId);
  return {
    pageId,
    publicId,
    privateRevisionId,
    publicRevisionId,
    runId,
    childAssetId: child.assetId,
    childPublicId: child.publicId,
  };
}

describeDatabase("pathless publication adoption boundaries", () => {
  const client = new Client({ connectionString: databaseUrl });

  beforeAll(async () => {
    await client.connect();
  });

  afterAll(async () => {
    try {
      await cleanupPathlessPublicationFixtures(client, fixtureDocumentIds);
    } finally {
      await client.end().catch(() => undefined);
    }
  });

  test("copies an exact legacy asset through storage and corpus roles", async () => {
    const assetId = randomUUID();
    const currentPath = `adopt-asset-${randomUUID().slice(0, 8)}`;
    await client.query(
      `INSERT INTO assets(
         id,current_path,public_path,filename,content_type,size_bytes,
         content_hash,s3_object_key,width,height,duration_seconds
       ) VALUES ($1,$2,$2,'adopt.png','image/png',23,$3,$4,12,13,1.2300)`,
      [assetId, currentPath, hash("a"), `objects/${assetId}`],
    );
    fixtureDocumentIds.add(assetId);
    const publicId = (await client.query<{ public_id: string }>(
      "SELECT public_id FROM public_resources WHERE document_id=$1",
      [assetId],
    )).rows[0]!.public_id;
    const adoptionId = randomUUID();
    const planned = await beginAdoption(
      client,
      adoptionId,
      "legacy_asset",
      assetId,
    );
    expect(planned.public_id).toBe(publicId);

    const target = await getAdoptionTarget(client, adoptionId);
    expect(target.public_duration_seconds).toBe("1.2300");
    await stageAdoption(client, adoptionId, target);
    expect(await applyAdoption(client, adoptionId)).toBe("applied");

    const applied = (await client.query(
      `SELECT adoption.phase,publication.artifact_id,artifact.origin,
         artifact.source_adoption_id,asset.public_path
       FROM pathless_publication_adoptions adoption
       JOIN asset_publications publication ON publication.public_id=adoption.public_id
       JOIN public_asset_artifacts artifact
         ON artifact.artifact_id=publication.artifact_id
       JOIN assets asset ON asset.id=adoption.source_document_id
       WHERE adoption.id=$1`,
      [adoptionId],
    )).rows[0]!;
    expect(applied).toMatchObject({
      phase: "applied",
      origin: "legacy_adoption",
      source_adoption_id: adoptionId,
      public_path: currentPath,
    });
  });

  test("copies the exact active legacy page artifact through checked roles", async () => {
    const pageId = randomUUID();
    const revisionId = randomUUID();
    const legacyArtifactId = randomUUID();
    const currentPath = `adopt-page-${randomUUID().slice(0, 8)}`;
    await client.query("BEGIN");
    await client.query("SET CONSTRAINTS ALL DEFERRED");
    try {
      await client.query(
        `INSERT INTO knowledge_pages(
           id,current_path,current_version_id,published_version_id,public_path
         ) VALUES ($1,$2,$3,$3,$2)`,
        [pageId, currentPath, revisionId],
      );
      await client.query(
        `INSERT INTO hypermedia_document_revisions(
           id,document_id,revision_number,body_object_key,body_size_bytes,
           body_content_hash,created_at
         ) VALUES ($1,$2,1,$3,31,$4,'2026-08-23 02:03:04.123456+00')`,
        [revisionId, pageId, `documents/private/${revisionId}.md`, hash("b")],
      );
      await client.query(
        `INSERT INTO knowledge_page_versions(
           id,page_id,version_number,path,title,summary,commit_message,
           actor_kind,actor_subject,created_at
         ) VALUES (
           $1,$2,1,$3,'Adopted page','Exact legacy page adoption.',
           'Seed adoption fixture','dashboard','context-use-owner',
           '2026-08-23 02:03:04.123456+00'
         )`,
        [revisionId, pageId, currentPath],
      );
      await client.query(
        `INSERT INTO published_page_artifacts(
           page_id,version_id,projection_generation,artifact_id,
           body_object_key,body_size_bytes,body_content_hash
         ) SELECT $1,$2,generation,$3,$4,41,$5
           FROM public_projection_state WHERE singleton`,
        [
          pageId,
          revisionId,
          legacyArtifactId,
          `documents/public/${legacyArtifactId}.md`,
          hash("c"),
        ],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
    fixtureDocumentIds.add(pageId);

    const publicId = (await client.query<{ public_id: string }>(
      "SELECT public_id FROM public_resources WHERE document_id=$1",
      [pageId],
    )).rows[0]!.public_id;
    const adoptionId = randomUUID();
    const planned = await beginAdoption(client, adoptionId, "legacy_page", pageId);
    expect(planned.public_id).toBe(publicId);
    const target = await getAdoptionTarget(client, adoptionId);
    expect(target.public_last_edited_at).toBe("2026-08-23T02:03:04.123456Z");
    expect(target.source_body_content_hash).toBe(hash("c"));
    await stageAdoption(client, adoptionId, target);
    expect(await applyAdoption(client, adoptionId)).toBe("applied");

    const applied = (await client.query(
      `SELECT adoption.phase,artifact.origin,artifact.legacy_source_artifact_id,
         page.published_version_id,page.public_path
       FROM pathless_publication_adoptions adoption
       JOIN page_publications publication ON publication.public_id=adoption.public_id
       JOIN public_page_artifacts artifact
         ON artifact.artifact_id=publication.artifact_id
       JOIN knowledge_pages page ON page.id=adoption.source_document_id
       WHERE adoption.id=$1`,
      [adoptionId],
    )).rows[0]!;
    expect(applied).toMatchObject({
      phase: "applied",
      origin: "legacy_adoption",
      legacy_source_artifact_id: legacyArtifactId,
      published_version_id: revisionId,
      public_path: currentPath,
    });
  });

  test("promotes a linked ready hub and never resurrects it on applied replay", async () => {
    const hub = await seedHubSource(client);
    const adoptionId = randomUUID();
    await beginAdoption(client, adoptionId, "directory_hub", hub.pageId);
    const target = await getAdoptionTarget(client, adoptionId);
    expect(target.target_projection).toEqual([
      {
        target_document_id: hub.childAssetId,
        outcome: "active_public",
        public_id: hub.childPublicId,
        public_target_kind: "asset",
      },
    ]);
    expect(target.projected_target_public_ids).toEqual([hub.childPublicId]);
    await stageAdoption(client, adoptionId, target, {
      bodySize: "67",
      bodyHash: hash("n"),
    });
    expect(await applyAdoption(client, adoptionId)).toBe("applied");
    expect((await client.query(
      `SELECT 1 FROM public_page_artifacts artifact
       JOIN page_publications publication USING (public_id,artifact_id)
       WHERE artifact.source_adoption_id=$1
         AND artifact.origin='directory_hub_promotion'`,
      [adoptionId],
    )).rowCount).toBe(1);

    await expect(
      beginAdoption(client, randomUUID(), "directory_hub", hub.pageId),
    ).rejects.toMatchObject({ code: "23514" });

    await client.query("DELETE FROM page_publications WHERE public_id=$1", [hub.publicId]);
    await client.query(
      `UPDATE corpus_migration_runs
       SET phase='superseded',superseded_at=now(),updated_at=now()
       WHERE id=$1`,
      [hub.runId],
    );
    expect(await applyAdoption(client, adoptionId)).toBe("applied");
    expect((await client.query(
      "SELECT 1 FROM page_publications WHERE public_id=$1",
      [hub.publicId],
    )).rowCount).toBe(0);
  });

  test("replays immutable hub staging after linked drift then supersedes apply", async () => {
    const hub = await seedHubSource(client);
    const adoptionId = randomUUID();
    await beginAdoption(client, adoptionId, "directory_hub", hub.pageId);
    const target = await getAdoptionTarget(client, adoptionId);
    const staged = { bodySize: "71", bodyHash: hash("o") };
    await stageAdoption(client, adoptionId, target, staged);
    await client.query("DELETE FROM asset_publications WHERE public_id=$1", [hub.childPublicId]);

    await stageAdoption(client, adoptionId, target, staged);
    await expect(
      stageAdoption(client, adoptionId, target, {
        ...staged,
        bodyHash: hash("p"),
      }),
    ).rejects.toMatchObject({ code: "23505" });
    expect(await applyAdoption(client, adoptionId)).toBe("superseded");
    expect((await client.query(
      "SELECT phase FROM pathless_publication_adoptions WHERE id=$1",
      [adoptionId],
    )).rows[0]!.phase).toBe("superseded");
    expect((await client.query(
      "SELECT 1 FROM public_page_artifacts WHERE source_adoption_id=$1",
      [adoptionId],
    )).rowCount).toBe(0);
    expect((await client.query(
      "SELECT 1 FROM page_publications WHERE public_id=$1",
      [hub.publicId],
    )).rowCount).toBe(0);
    await client.query(
      `UPDATE corpus_migration_runs
       SET phase='superseded',superseded_at=now(),updated_at=now()
       WHERE id=$1`,
      [hub.runId],
    );
  });

  test("holds the ready run and public projection proof through hub apply", async () => {
    const hub = await seedHubSource(client);
    const adoptionId = randomUUID();
    await beginAdoption(client, adoptionId, "directory_hub", hub.pageId);
    const target = await getAdoptionTarget(client, adoptionId);
    await stageAdoption(client, adoptionId, target, {
      bodySize: "73",
      bodyHash: hash("hub-race"),
    });

    const applier = new Client({ connectionString: databaseUrl });
    const mutator = new Client({ connectionString: databaseUrl });
    await applier.connect();
    await mutator.connect();
    try {
      await applier.query("BEGIN");
      await applier.query("SET ROLE context_use_corpus");
      expect((await applier.query<{ phase: string }>(
        "SELECT apply_pathless_publication_adoption($1) AS phase",
        [adoptionId],
      )).rows[0]!.phase).toBe("applied");

      await mutator.query("SET ROLE context_use_corpus");
      await mutator.query("SET statement_timeout='150ms'");
      await expect(mutator.query(
        `UPDATE corpus_migration_runs
         SET phase='superseded',superseded_at=now(),updated_at=now()
         WHERE id=$1`,
        [hub.runId],
      )).rejects.toMatchObject({ code: "57014" });
      await expect(mutator.query(
        "SELECT replace_knowledge_revision_projections($1,'{}'::uuid[])",
        [hub.publicRevisionId],
      )).rejects.toMatchObject({ code: "57014" });
      await applier.query("COMMIT");
      await mutator.query("SET statement_timeout=0");
      await mutator.query("RESET ROLE");
    } finally {
      await applier.query("ROLLBACK").catch(() => undefined);
      await applier.end();
      await mutator.query("RESET ROLE").catch(() => undefined);
      await mutator.end();
    }
    expect((await client.query(
      "SELECT 1 FROM page_publications WHERE public_id=$1",
      [hub.publicId],
    )).rowCount).toBe(1);
    await client.query(
      `UPDATE corpus_migration_runs
       SET phase='superseded',superseded_at=now(),updated_at=now()
       WHERE id=$1`,
      [hub.runId],
    );
  });

  test("replays an immutable plan after its private source is deleted", async () => {
    const source = await seedLegacyAssetSource(client);
    const adoptionId = randomUUID();
    const first = await beginAdoption(
      client,
      adoptionId,
      "legacy_asset",
      source.assetId,
    );
    await client.query("DELETE FROM assets WHERE id=$1", [source.assetId]);
    const replay = await beginAdoption(
      client,
      adoptionId,
      "legacy_asset",
      source.assetId,
    );
    expect(replay).toEqual(first);
    await expect(
      beginAdoption(client, randomUUID(), "legacy_asset", source.assetId),
    ).rejects.toMatchObject({ code: "P0002" });
  });

  test("preserves one current plan when different IDs race for a source", async () => {
    const source = await seedLegacyAssetSource(client);
    const ids = [randomUUID(), randomUUID()];
    const callers = await Promise.all(ids.map(async (id) => {
      const caller = new Client({ connectionString: databaseUrl });
      await caller.connect();
      try {
        return await beginAdoption(caller, id, "legacy_asset", source.assetId);
      } finally {
        await caller.end();
      }
    }).map(async (call) => {
      try {
        return { status: "fulfilled" as const, value: await call };
      } catch (error) {
        return { status: "rejected" as const, error: error as { code?: string } };
      }
    }));
    expect(callers.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(callers.filter(({ status }) => status === "rejected")).toHaveLength(1);
    expect(callers.find(({ status }) => status === "rejected"))
      .toMatchObject({ error: { code: "23505" } });
    const winner = callers.find(({ status }) => status === "fulfilled")!;
    if (winner.status !== "fulfilled") throw new Error("missing winner");
    expect(await beginAdoption(
      client,
      winner.value.id as string,
      "legacy_asset",
      source.assetId,
    )).toEqual(winner.value);
  });

  test("persists supersession when a planned page becomes operational", async () => {
    const source = await seedLegacyPageSource(client);
    const adoptionId = randomUUID();
    await beginAdoption(client, adoptionId, "legacy_page", source.pageId);
    const target = await getAdoptionTarget(client, adoptionId);
    await stageAdoption(client, adoptionId, target);

    const runId = randomUUID();
    await client.query(
      `INSERT INTO corpus_migration_runs(
         id,inventory_token,plan_token,settings_snapshot,readable_document_ids,
         phase,actor_subject,ready_at
       ) VALUES ($1,$2,$3,'{}'::jsonb,$4::uuid[],'ready','fixture',now())`,
      [runId, hash("q"), hash("r"), [source.pageId]],
    );
    await client.query("SET session_replication_role=replica");
    try {
      await client.query(
        `INSERT INTO corpus_migration_automation_plans(
           run_id,key,name,instructions_document_id
         ) VALUES ($1,$2,'Adoption retarget',$3)`,
        [runId, `adoption-${randomUUID().slice(0, 8)}`, source.pageId],
      );
    } finally {
      await client.query("SET session_replication_role=origin");
    }
    expect(await applyAdoption(client, adoptionId)).toBe("superseded");
    expect((await client.query(
      "SELECT 1 FROM page_publications WHERE public_id=$1",
      [source.publicId],
    )).rowCount).toBe(0);
    await client.query(
      `UPDATE corpus_migration_runs
       SET phase='superseded',superseded_at=now(),updated_at=now()
       WHERE id=$1`,
      [runId],
    );
  });

  test("keeps key-bearing adoption state inaccessible to service roles", async () => {
    for (const role of ["context_use_storage", "context_use_corpus"]) {
      await asRole(client, role, async () => {
        await expect(
          client.query("SELECT source_snapshot FROM pathless_publication_adoptions LIMIT 1"),
        ).rejects.toMatchObject({ code: "42501" });
        await expect(
          client.query("SELECT * FROM pathless_publication_adoption_staging LIMIT 1"),
        ).rejects.toMatchObject({ code: "42501" });
        await expect(
          client.query(
            "SELECT pathless_publication_adoption_source_fingerprint('legacy_asset',$1,$2)",
            [randomUUID(), randomUUID()],
          ),
        ).rejects.toMatchObject({ code: "42501" });
        await expect(
          client.query(
            "SELECT pathless_publication_adoption_projection_plan($1,$2,'{}'::uuid[])",
            [randomUUID(), randomUUID()],
          ),
        ).rejects.toMatchObject({ code: "42501" });
      });
    }
    await asRole(client, "context_use_corpus", async () => {
      await expect(
        client.query("SELECT * FROM claim_pathless_publication_adoption_artifact($1,$2)", [randomUUID(), randomUUID()]),
      ).rejects.toMatchObject({ code: "42501" });
    });
    await asRole(client, "context_use_storage", async () => {
      await expect(
        client.query("SELECT * FROM begin_pathless_publication_adoption($1,'legacy_asset',$2)", [randomUUID(), randomUUID()]),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        client.query("SELECT apply_pathless_publication_adoption($1)", [randomUUID()]),
      ).rejects.toMatchObject({ code: "42501" });
    });
  });
});
