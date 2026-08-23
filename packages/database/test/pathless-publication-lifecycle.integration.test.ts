import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { Client } from "pg";
import { disposableDatabaseUrl } from "../src/disposable-database.ts";

const databaseUrl = await disposableDatabaseUrl();
const describeDatabase = databaseUrl ? describe : describe.skip;
const hash = (value: string): string => value.repeat(64).slice(0, 64);
const token = (): string => randomBytes(32).toString("hex");

type PageFixture = {
  pageId: string;
  revisionId: string;
  publicId: string;
  artifactId: string;
  adoptionId: string;
  path: string;
  hubRunId?: string | undefined;
};

type AssetFixture = {
  assetId: string;
  publicId: string;
  artifactId: string;
};

async function sqlState(client: Client, query: () => Promise<unknown>): Promise<string | undefined> {
  await client.query("SAVEPOINT expected_failure");
  try {
    await query();
    await client.query("RELEASE SAVEPOINT expected_failure");
    return undefined;
  } catch (error) {
    await client.query("ROLLBACK TO SAVEPOINT expected_failure");
    await client.query("RELEASE SAVEPOINT expected_failure");
    return (error as { code?: string }).code;
  }
}

async function insertPageRevision(
  client: Client,
  pageId: string,
  revisionId: string,
  revisionNumber: number,
  path: string,
): Promise<void> {
  await client.query(
    `INSERT INTO hypermedia_document_revisions(
       id,document_id,revision_number,body_object_key,body_size_bytes,
       body_content_hash
     ) VALUES ($1,$2,$3,$4,4,$5)`,
    [revisionId, pageId, revisionNumber, `documents/private/${revisionId}.md`, hash("a")],
  );
  await client.query(
    `INSERT INTO knowledge_page_versions(
       id,page_id,version_number,path,title,summary,commit_message,
       actor_kind,actor_subject
     ) VALUES (
       $1,$2,$3,$4,'Pathless lifecycle','A v2 lifecycle fixture.',
       'Create lifecycle fixture','dashboard','context-use-owner'
     )`,
    [revisionId, pageId, revisionNumber, path],
  );
}

async function seedPagePublication(
  client: Client,
  kind: "legacy_page" | "directory_hub" = "legacy_page",
): Promise<PageFixture> {
  const pageId = randomUUID();
  const revisionId = randomUUID();
  const publicId = randomUUID();
  const artifactId = randomUUID();
  const adoptionId = randomUUID();
  const suffix = randomUUID().slice(0, 8);
  const path = `v2-lifecycle-${suffix}`;
  const objectKey = `documents/public/${artifactId}.md`;
  let hubRunId: string | undefined;

  await client.query(
    `INSERT INTO knowledge_pages(id,current_path,current_version_id,search_vector)
     VALUES ($1,$2,$3,page_search_vector($2,'Pathless lifecycle','A v2 lifecycle fixture.','body'))`,
    [pageId, path, revisionId],
  );
  await insertPageRevision(client, pageId, revisionId, 1, path);
  await client.query(
    `INSERT INTO public_resources(public_id,document_id,resource_kind)
     VALUES ($1,$2,'page')`,
    [publicId, pageId],
  );
  await client.query(
    `INSERT INTO public_artifact_id_reservations(
       artifact_id,body_object_key,allocation_kind,allocation_id
     ) VALUES ($1,$2,'pathless_adoption',$3)`,
    [artifactId, objectKey, adoptionId],
  );
  await client.query(
    `INSERT INTO pathless_publication_adoptions(
       id,adoption_kind,source_document_id,source_revision_id,public_id,
       candidate_artifact_id,candidate_object_key,reservation_allocation_id,
       source_snapshot,source_fingerprint,expected_visibility_generation,
       expected_visibility_state_hash,expected_target_generation,
       phase,applied_at
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$1,'{}'::jsonb,$8,0,repeat('0',64),1,
       'applied',now()
     )`,
    [adoptionId, kind, pageId, revisionId, publicId, artifactId, objectKey, hash("b")],
  );
  if (kind === "directory_hub") {
    const runId = randomUUID();
    hubRunId = runId;
    await client.query(
      `INSERT INTO corpus_migration_runs(
         id,inventory_token,plan_token,settings_snapshot,readable_document_ids,
         phase,actor_subject,superseded_at
       ) VALUES ($1,$2,$3,'{}'::jsonb,'{}'::uuid[],'superseded',
         'context-use-template/test',now())`,
      [runId, token(), token()],
    );
    await client.query(
      `INSERT INTO directory_hub_migrations(
         directory_id,document_id,migration_run_id,legacy_path,temporary_path,
         private_revision_id,public_revision_id,public_id,
         private_projection_fingerprint,public_projection_fingerprint
       ) VALUES ($1,$1,$2,$3,$4,$5,$5,$6,$7,$8)`,
      [
        pageId,
        runId,
        `legacy-${randomUUID().slice(0, 8)}`,
        `temporary-${randomUUID().slice(0, 8)}`,
        revisionId,
        publicId,
        token(),
        token(),
      ],
    );
  }
  await client.query(
    `INSERT INTO public_page_artifacts(
       artifact_id,public_id,source_document_id,source_revision_id,
       source_body_size_bytes,source_body_content_hash,body_object_key,
       body_size_bytes,body_content_hash,public_title,public_summary,
       public_last_edited_at,projection_receipt_hash,origin,
       source_adoption_id,source_adoption_kind,legacy_source_artifact_id,
       legacy_projection_generation,representation_token,
       reservation_allocation_kind,reservation_allocation_id
     ) VALUES (
       $1,$2,$3,$4,4,$5,$6,4,$7,'Pathless lifecycle',
       'A v2 lifecycle fixture.',now(),$8,$9,$10,$11,$12,$13,$14,
       'pathless_adoption',$10
     )`,
    [
      artifactId,
      publicId,
      pageId,
      revisionId,
      hash("a"),
      objectKey,
      hash("c"),
      hash("d"),
      kind === "legacy_page" ? "legacy_adoption" : "directory_hub_promotion",
      adoptionId,
      kind,
      kind === "legacy_page" ? randomUUID() : null,
      kind === "legacy_page" ? 1 : null,
      token(),
    ],
  );
  await client.query(
    "INSERT INTO page_publications(public_id,artifact_id) VALUES ($1,$2)",
    [publicId, artifactId],
  );
  return { pageId, revisionId, publicId, artifactId, adoptionId, path, hubRunId };
}

async function seedAssetPublication(client: Client): Promise<AssetFixture> {
  const assetId = randomUUID();
  const publicId = randomUUID();
  const artifactId = randomUUID();
  const adoptionId = randomUUID();
  const suffix = randomUUID().slice(0, 8);
  const objectKey = `artifacts/public/${artifactId}`;
  await client.query(
    `INSERT INTO assets(
       id,current_path,filename,content_type,size_bytes,content_hash,s3_object_key
     ) VALUES ($1,$2,'fixture.png','image/png',4,$3,$4)`,
    [assetId, `v2-asset-${suffix}`, hash("e"), `objects/${assetId}`],
  );
  await client.query(
    `INSERT INTO public_resources(public_id,document_id,resource_kind)
     VALUES ($1,$2,'asset')`,
    [publicId, assetId],
  );
  await client.query(
    `INSERT INTO public_artifact_id_reservations(
       artifact_id,body_object_key,allocation_kind,allocation_id
     ) VALUES ($1,$2,'pathless_adoption',$3)`,
    [artifactId, objectKey, adoptionId],
  );
  await client.query(
    `INSERT INTO pathless_publication_adoptions(
       id,adoption_kind,source_document_id,public_id,candidate_artifact_id,
       candidate_object_key,reservation_allocation_id,source_snapshot,
       source_fingerprint,expected_visibility_generation,
       expected_visibility_state_hash,expected_target_generation,
       phase,applied_at
     ) VALUES (
       $1,'legacy_asset',$2,$3,$4,$5,$1,'{}'::jsonb,$6,0,
       repeat('0',64),1,'applied',now()
     )`,
    [adoptionId, assetId, publicId, artifactId, objectKey, hash("f")],
  );
  await client.query(
    `INSERT INTO public_asset_artifacts(
       artifact_id,public_id,source_document_id,body_object_key,
       body_size_bytes,body_content_hash,public_filename,public_content_type,
       origin,source_adoption_id,source_adoption_kind,representation_token,
       reservation_allocation_kind,reservation_allocation_id
     ) VALUES (
       $1,$2,$3,$4,4,$5,'fixture.png','image/png','legacy_adoption',
       $6,'legacy_asset',$7,'pathless_adoption',$6
     )`,
    [artifactId, publicId, assetId, objectKey, hash("e"), adoptionId, token()],
  );
  await client.query(
    "INSERT INTO asset_publications(public_id,artifact_id) VALUES ($1,$2)",
    [publicId, artifactId],
  );
  return { assetId, publicId, artifactId };
}

async function removeCommittedPageFixture(client: Client, fixture: PageFixture): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL session_replication_role=replica");
    await client.query("DELETE FROM page_publications WHERE public_id=$1", [fixture.publicId]);
    await client.query("DELETE FROM directory_hub_migrations WHERE document_id=$1", [fixture.pageId]);
    await client.query("DELETE FROM public_page_artifacts WHERE artifact_id=$1", [fixture.artifactId]);
    await client.query(
      "DELETE FROM public_representation_token_reservations WHERE artifact_id=$1",
      [fixture.artifactId],
    );
    await client.query("DELETE FROM pathless_publication_adoptions WHERE id=$1", [fixture.adoptionId]);
    await client.query("DELETE FROM public_artifact_id_reservations WHERE artifact_id=$1", [fixture.artifactId]);
    await client.query("DELETE FROM public_visibility_generations WHERE public_id=$1", [fixture.publicId]);
    await client.query("DELETE FROM public_resources WHERE public_id=$1", [fixture.publicId]);
    await client.query(
      `DELETE FROM publication_target_generations
       WHERE target_kind='page' AND target_document_id=$1`,
      [fixture.pageId],
    );
    await client.query("DELETE FROM knowledge_page_changes WHERE page_id=$1", [fixture.pageId]);
    await client.query("DELETE FROM knowledge_page_versions WHERE page_id=$1", [fixture.pageId]);
    await client.query("DELETE FROM knowledge_pages WHERE id=$1", [fixture.pageId]);
    await client.query("DELETE FROM hypermedia_document_revisions WHERE document_id=$1", [fixture.pageId]);
    await client.query("DELETE FROM hypermedia_documents WHERE id=$1", [fixture.pageId]);
    if (fixture.hubRunId) {
      await client.query("DELETE FROM corpus_migration_runs WHERE id=$1", [fixture.hubRunId]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

describeDatabase("pathless publication lifecycle coexistence", () => {
  const client = new Client({ connectionString: databaseUrl });

  beforeAll(async () => {
    await client.connect();
  });

  afterAll(async () => {
    await client.end().catch(() => undefined);
  });

  test("page pins survive private edits but block retirement and follow legacy revision visibility", async () => {
    await client.query("BEGIN");
    await client.query("SET CONSTRAINTS ALL DEFERRED");
    try {
      const fixture = await seedPagePublication(client);
      await client.query(
        "UPDATE knowledge_pages SET updated_at=now() WHERE id=$1",
        [fixture.pageId],
      );
      await client.query(
        "UPDATE public_projection_state SET generation=generation+1 WHERE singleton",
      );
      expect((await client.query(
        "SELECT 1 FROM page_publications WHERE public_id=$1",
        [fixture.publicId],
      )).rowCount).toBe(1);
      expect(await sqlState(client, () => client.query(
        "UPDATE page_publications SET published_at=now() WHERE public_id=$1",
        [fixture.publicId],
      ))).toBe("23514");

      await client.query(
        `UPDATE knowledge_pages
         SET published_version_id=$2,public_path=$3,updated_at=now()
         WHERE id=$1`,
        [fixture.pageId, fixture.revisionId, fixture.path],
      );
      await client.query(
        `UPDATE knowledge_pages SET public_path=$2,updated_at=now() WHERE id=$1`,
        [fixture.pageId, `${fixture.path}-renamed`],
      );
      expect((await client.query(
        "SELECT 1 FROM page_publications WHERE public_id=$1",
        [fixture.publicId],
      )).rowCount).toBe(1);
      expect(await sqlState(client, () => client.query(
        "UPDATE knowledge_pages SET archived_at=now() WHERE id=$1",
        [fixture.pageId],
      ))).toBe("23514");
      expect(await sqlState(client, () => client.query(
        "DELETE FROM knowledge_pages WHERE id=$1",
        [fixture.pageId],
      ))).toBe("23514");

      const replacementRevisionId = randomUUID();
      await insertPageRevision(client, fixture.pageId, replacementRevisionId, 2, fixture.path);
      await client.query(
        `UPDATE knowledge_pages
         SET published_version_id=$2,public_path=$3,updated_at=now()
         WHERE id=$1`,
        [fixture.pageId, replacementRevisionId, fixture.path],
      );
      expect((await client.query(
        "SELECT 1 FROM page_publications WHERE public_id=$1",
        [fixture.publicId],
      )).rowCount).toBe(0);
      expect((await client.query(
        "SELECT 1 FROM public_page_artifacts WHERE artifact_id=$1",
        [fixture.artifactId],
      )).rowCount).toBe(1);

      await client.query(
        `UPDATE knowledge_pages
         SET published_version_id=NULL,public_path=NULL,archived_at=now(),updated_at=now()
         WHERE id=$1`,
        [fixture.pageId],
      );
      expect(await sqlState(client, () => client.query(
        "INSERT INTO page_publications(public_id,artifact_id) VALUES ($1,$2)",
        [fixture.publicId, fixture.artifactId],
      ))).toBe("23514");
    } finally {
      await client.query("ROLLBACK");
    }
  });

  test("asset pins block deletion and legacy unpublish removes only the pin", async () => {
    await client.query("BEGIN");
    try {
      const fixture = await seedAssetPublication(client);
      expect(await sqlState(client, () => client.query(
        "UPDATE assets SET deleted_at=now() WHERE id=$1",
        [fixture.assetId],
      ))).toBe("23514");
      expect(await sqlState(client, () => client.query(
        "DELETE FROM assets WHERE id=$1",
        [fixture.assetId],
      ))).toBe("23514");
      expect(await sqlState(client, () => client.query(
        "UPDATE asset_publications SET published_at=now() WHERE public_id=$1",
        [fixture.publicId],
      ))).toBe("23514");

      await client.query(
        "UPDATE assets SET public_path=current_path WHERE id=$1",
        [fixture.assetId],
      );
      expect((await client.query(
        "SELECT 1 FROM asset_publications WHERE public_id=$1",
        [fixture.publicId],
      )).rowCount).toBe(1);
      await client.query("UPDATE assets SET public_path=NULL WHERE id=$1", [fixture.assetId]);
      expect((await client.query(
        "SELECT 1 FROM asset_publications WHERE public_id=$1",
        [fixture.publicId],
      )).rowCount).toBe(0);
      expect((await client.query(
        "SELECT 1 FROM public_asset_artifacts WHERE artifact_id=$1",
        [fixture.artifactId],
      )).rowCount).toBe(1);
      await client.query("UPDATE assets SET deleted_at=now() WHERE id=$1", [fixture.assetId]);
    } finally {
      await client.query("ROLLBACK");
    }
  });

  test("page artifact staging requires an explicit projection receipt", async () => {
    await client.query("BEGIN");
    try {
      const intentId = randomUUID();
      const documentId = randomUUID();
      const revisionId = randomUUID();
      const publicId = randomUUID();
      const artifactId = randomUUID();
      const objectKey = `documents/public/${artifactId}.md`;
      await client.query(
        `INSERT INTO public_artifact_id_reservations(
           artifact_id,body_object_key,allocation_kind,allocation_id
         ) VALUES ($1,$2,'pathless_intent',$3)`,
        [artifactId, objectKey, intentId],
      );
      await client.query(
        `INSERT INTO pathless_publication_intents(
           id,action,target_kind,target_document_id,expected_revision_id,
           candidate_public_id,candidate_artifact_id,candidate_object_key,
           artifact_allocation_kind,artifact_allocation_id,
           projection_receipt_hash,owner_user_id,session_id,expires_at,
           expected_visibility_generation,expected_visibility_state_hash,
           expected_target_generation,expected_source_fingerprint
         ) VALUES (
           $1,'publish','page',$2,$3,$4,$5,$6,'pathless_intent',$1,$7,
           'context-use-owner','projection-receipt-test',now()+interval '5 minutes',
           0,$8,0,$9
         )`,
        [
          intentId,
          documentId,
          revisionId,
          publicId,
          artifactId,
          objectKey,
          hash("a"),
          hash("f"),
          hash("e"),
        ],
      );
      const representationToken = token();
      await client.query(
        "SELECT reserve_public_representation_token($1,$2,'page')",
        [representationToken, artifactId],
      );
      expect(await sqlState(client, () => client.query(
        `INSERT INTO pathless_publication_artifact_staging(
           intent_id,target_kind,candidate_public_id,artifact_id,
           body_object_key,body_size_bytes,body_content_hash,public_title,
           public_summary,public_last_edited_at,projection_receipt_hash,
           allocation_id,representation_token
         ) VALUES (
           $1,'page',$2,$3,$4,4,$5,'Public page','A safe public summary.',
           now(),NULL,$1,$6
         )`,
        [intentId, publicId, artifactId, objectKey, hash("b"), representationToken],
      ))).toBe("23514");
    } finally {
      await client.query("ROLLBACK");
    }
  });

  test("directory hub proof drift unpins the promoted artifact without deleting history", async () => {
    await client.query("BEGIN");
    await client.query("SET CONSTRAINTS ALL DEFERRED");
    try {
      const fixture = await seedPagePublication(client, "directory_hub");
      const replacementRevisionId = randomUUID();
      await insertPageRevision(client, fixture.pageId, replacementRevisionId, 2, fixture.path);
      await client.query(
        "UPDATE directory_hub_migrations SET public_revision_id=$2 WHERE directory_id=$1",
        [fixture.pageId, replacementRevisionId],
      );
      expect((await client.query(
        "SELECT 1 FROM page_publications WHERE public_id=$1",
        [fixture.publicId],
      )).rowCount).toBe(0);
      expect((await client.query(
        "SELECT 1 FROM public_page_artifacts WHERE artifact_id=$1",
        [fixture.artifactId],
      )).rowCount).toBe(1);
      await client.query(
        "DELETE FROM directory_hub_migrations WHERE directory_id=$1",
        [fixture.pageId],
      );
      expect(await sqlState(client, () => client.query(
        "INSERT INTO page_publications(public_id,artifact_id) VALUES ($1,$2)",
        [fixture.publicId, fixture.artifactId],
      ))).toBe("23514");
    } finally {
      await client.query("ROLLBACK");
    }
  });

  test("artifacts cannot bind another document's bytes to an existing public identity", async () => {
    await client.query("BEGIN");
    try {
      const page = await seedPagePublication(client);
      const otherPageId = randomUUID();
      const otherRevisionId = randomUUID();
      const otherPath = `v2-cross-page-${randomUUID().slice(0, 8)}`;
      await client.query(
        `INSERT INTO knowledge_pages(id,current_path,current_version_id)
         VALUES ($1,$2,$3)`,
        [otherPageId, otherPath, otherRevisionId],
      );
      await insertPageRevision(client, otherPageId, otherRevisionId, 1, otherPath);
      const pageArtifactId = randomUUID();
      const pageAdoptionId = randomUUID();
      const pageObjectKey = `documents/public/${pageArtifactId}.md`;
      await client.query(
        `INSERT INTO public_artifact_id_reservations(
           artifact_id,body_object_key,allocation_kind,allocation_id
         ) VALUES ($1,$2,'pathless_adoption',$3)`,
        [pageArtifactId, pageObjectKey, pageAdoptionId],
      );
      await client.query(
        `INSERT INTO pathless_publication_adoptions(
           id,adoption_kind,source_document_id,source_revision_id,public_id,
           candidate_artifact_id,candidate_object_key,reservation_allocation_id,
           source_snapshot,source_fingerprint,expected_visibility_generation,
           expected_visibility_state_hash,expected_target_generation,
           phase,applied_at
         ) VALUES (
           $1,'legacy_page',$2,$3,$4,$5,$6,$1,'{}'::jsonb,$7,0,
           repeat('0',64),1,'applied',now()
         )`,
        [
          pageAdoptionId,
          otherPageId,
          otherRevisionId,
          page.publicId,
          pageArtifactId,
          pageObjectKey,
          token(),
        ],
      );
      expect(await sqlState(client, () => client.query(
        `INSERT INTO public_page_artifacts(
           artifact_id,public_id,source_document_id,source_revision_id,
           source_body_size_bytes,source_body_content_hash,body_object_key,
           body_size_bytes,body_content_hash,public_title,public_summary,
           public_last_edited_at,projection_receipt_hash,origin,
           source_adoption_id,source_adoption_kind,legacy_source_artifact_id,
           legacy_projection_generation,representation_token,
           reservation_allocation_kind,reservation_allocation_id
         ) VALUES (
           $1,$2,$3,$4,4,$5,$6,4,$7,'Cross-bound page',
           'Must not bind to another resource.',now(),$8,'legacy_adoption',
           $9,'legacy_page',$10,1,$11,'pathless_adoption',$9
         )`,
        [
          pageArtifactId,
          page.publicId,
          otherPageId,
          otherRevisionId,
          hash("a"),
          pageObjectKey,
          hash("c"),
          hash("d"),
          pageAdoptionId,
          randomUUID(),
          token(),
        ],
      ))).toBe("23503");

      const asset = await seedAssetPublication(client);
      const otherAssetId = randomUUID();
      await client.query(
        `INSERT INTO assets(
           id,current_path,filename,content_type,size_bytes,content_hash,s3_object_key
         ) VALUES ($1,$2,'other.png','image/png',4,$3,$4)`,
        [
          otherAssetId,
          `v2-cross-asset-${randomUUID().slice(0, 8)}`,
          hash("e"),
          `objects/${otherAssetId}`,
        ],
      );
      const assetArtifactId = randomUUID();
      const assetAdoptionId = randomUUID();
      const assetObjectKey = `artifacts/public/${assetArtifactId}`;
      await client.query(
        `INSERT INTO public_artifact_id_reservations(
           artifact_id,body_object_key,allocation_kind,allocation_id
         ) VALUES ($1,$2,'pathless_adoption',$3)`,
        [assetArtifactId, assetObjectKey, assetAdoptionId],
      );
      await client.query(
        `INSERT INTO pathless_publication_adoptions(
           id,adoption_kind,source_document_id,public_id,candidate_artifact_id,
           candidate_object_key,reservation_allocation_id,source_snapshot,
           source_fingerprint,expected_visibility_generation,
           expected_visibility_state_hash,expected_target_generation,
           phase,applied_at
         ) VALUES (
           $1,'legacy_asset',$2,$3,$4,$5,$1,'{}'::jsonb,$6,0,
           repeat('0',64),1,'applied',now()
         )`,
        [assetAdoptionId, otherAssetId, asset.publicId, assetArtifactId, assetObjectKey, token()],
      );
      expect(await sqlState(client, () => client.query(
        `INSERT INTO public_asset_artifacts(
           artifact_id,public_id,source_document_id,body_object_key,
           body_size_bytes,body_content_hash,public_filename,public_content_type,
           origin,source_adoption_id,source_adoption_kind,representation_token,
           reservation_allocation_kind,reservation_allocation_id
         ) VALUES (
           $1,$2,$3,$4,4,$5,'other.png','image/png','legacy_adoption',
           $6,'legacy_asset',$7,'pathless_adoption',$6
         )`,
        [
          assetArtifactId,
          asset.publicId,
          otherAssetId,
          assetObjectKey,
          hash("e"),
          assetAdoptionId,
          token(),
        ],
      ))).toBe("23503");
    } finally {
      await client.query("ROLLBACK");
    }
  });

  test("audits both directions of grandfathered active-plan public mapping drift", async () => {
    await client.query("BEGIN");
    try {
      const runId = randomUUID();
      const samePublicDifferentDocument = {
        publicId: randomUUID(),
        resourceDocumentId: randomUUID(),
        plannedDirectoryId: randomUUID(),
        resourceKind: "page",
      } as const;
      const samePublicWrongKindDocumentId = randomUUID();
      const samePublicWrongKind = {
        publicId: randomUUID(),
        resourceDocumentId: samePublicWrongKindDocumentId,
        plannedDirectoryId: samePublicWrongKindDocumentId,
        resourceKind: "asset",
      } as const;
      const sameDocumentDifferentPublicDocumentId = randomUUID();
      const sameDocumentDifferentPublic = {
        resourcePublicId: randomUUID(),
        plannedPublicId: randomUUID(),
        resourceDocumentId: sameDocumentDifferentPublicDocumentId,
        plannedDirectoryId: sameDocumentDifferentPublicDocumentId,
        resourceKind: "page",
      } as const;

      // These tuples model a legal pre-028 database. Forward guards reject all
      // three today; the additive upgrade must audit rather than abort on them.
      await client.query("SET LOCAL session_replication_role=replica");
      await client.query(
        `INSERT INTO corpus_migration_runs(
           id,inventory_token,plan_token,settings_snapshot,readable_document_ids,
           phase,actor_subject
         ) VALUES ($1,$2,$3,'{}'::jsonb,'{}'::uuid[],'applying',
           'context-use-template/namespace-audit')`,
        [runId, token(), token()],
      );
      for (const resource of [
        samePublicDifferentDocument,
        samePublicWrongKind,
        {
          publicId: sameDocumentDifferentPublic.resourcePublicId,
          resourceDocumentId: sameDocumentDifferentPublic.resourceDocumentId,
          resourceKind: sameDocumentDifferentPublic.resourceKind,
        },
      ]) {
        await client.query(
          `INSERT INTO public_resources(
             public_id,document_id,original_document_id,resource_kind
           ) VALUES ($1,$2,$2,$3)`,
          [resource.publicId, resource.resourceDocumentId, resource.resourceKind],
        );
      }
      const plans = [
        {
          directoryId: samePublicDifferentDocument.plannedDirectoryId,
          publicId: samePublicDifferentDocument.publicId,
        },
        {
          directoryId: samePublicWrongKind.plannedDirectoryId,
          publicId: samePublicWrongKind.publicId,
        },
        {
          directoryId: sameDocumentDifferentPublic.plannedDirectoryId,
          publicId: sameDocumentDifferentPublic.plannedPublicId,
        },
      ];
      for (const [index, plan] of plans.entries()) {
        await client.query(
          `INSERT INTO corpus_directory_migration_plans(
             run_id,directory_id,disposition,private_revision_mode,
             temporary_path,private_revision_id,private_revision_number,
             public_id,private_projection_fingerprint
           ) VALUES (
             $1,$2,'public_compatibility','render',$3,$4,1,$5,$6
           )`,
          [
            runId,
            plan.directoryId,
            `namespace-audit-${index}-${randomUUID().slice(0, 8)}`,
            randomUUID(),
            plan.publicId,
            hash(String(index + 1)),
          ],
        );
      }
      await client.query("SET LOCAL session_replication_role=origin");

      const expected = [
        {
          conflict_key:
            `planned-public-id-mapping:${runId}:${samePublicDifferentDocument.plannedDirectoryId}`,
          namespace_uuid: samePublicDifferentDocument.publicId,
          conflicting_identity_kind: "public_resource_mapping",
          conflict_lifecycle: "planned",
        },
        {
          conflict_key:
            `planned-public-id-mapping:${runId}:${samePublicWrongKind.plannedDirectoryId}`,
          namespace_uuid: samePublicWrongKind.publicId,
          conflicting_identity_kind: "public_resource_mapping",
          conflict_lifecycle: "planned",
        },
        {
          conflict_key:
            `planned-public-mapping:${runId}:${sameDocumentDifferentPublic.plannedDirectoryId}`,
          namespace_uuid: sameDocumentDifferentPublic.plannedPublicId,
          conflicting_identity_kind: "planned_public_mapping",
          conflict_lifecycle: "planned",
        },
      ].sort((left, right) => left.conflict_key.localeCompare(right.conflict_key));
      const live = await client.query<{
        conflict_key: string;
        namespace_uuid: string;
        conflicting_identity_kind: string;
        conflict_lifecycle: string;
      }>(
        `SELECT conflict_key,namespace_uuid,conflicting_identity_kind,
           conflict_lifecycle
         FROM live_public_namespace_conflicts
         WHERE conflict_kind='planned_public_id_public_mapping'
           AND conflict_key LIKE $1
         ORDER BY conflict_key`,
        [`%${runId}%`],
      );
      expect(live.rows).toEqual(expected);

      // Exercise the migration's exact durable backfill projection, then prove
      // the runtime blocker stays live only while the plan remains active.
      await client.query(
        `INSERT INTO public_namespace_conflicts(
           conflict_key,namespace_uuid,conflict_kind,public_id,alias_path,
           conflicting_identity_kind,conflict_lifecycle
         )
         SELECT conflict_key,namespace_uuid,conflict_kind,public_id,alias_path,
           conflicting_identity_kind,conflict_lifecycle
         FROM live_public_namespace_conflicts
         WHERE conflict_kind='planned_public_id_public_mapping'
           AND conflict_key LIKE $1
         ON CONFLICT (conflict_key) DO NOTHING`,
        [`%${runId}%`],
      );
      const conflictKeys = expected.map(({ conflict_key }) => conflict_key);
      expect((await client.query(
        `SELECT 1 FROM blocking_public_namespace_conflicts
         WHERE conflict_key=ANY($1::text[])`,
        [conflictKeys],
      )).rowCount).toBe(3);
      await client.query(
        `UPDATE corpus_migration_runs
         SET phase='superseded',superseded_at=now(),updated_at=now()
         WHERE id=$1`,
        [runId],
      );
      expect((await client.query(
        `SELECT 1 FROM public_namespace_conflicts
         WHERE conflict_key=ANY($1::text[]) AND resolved_at IS NOT NULL`,
        [conflictKeys],
      )).rowCount).toBe(3);
    } finally {
      await client.query("ROLLBACK");
    }
  });

  test("finishing an operational replacement reconciles stale planned namespace blockers", async () => {
    await client.query("BEGIN");
    try {
      const replacementId = randomUUID();
      const replacementDocumentId = randomUUID();
      const replacementRevisionId = randomUUID();
      const conflictId = randomUUID();
      const conflictKey = `planned-test:${randomUUID()}`;
      await client.query(
        `INSERT INTO operational_document_replacements(
           id,target_kind,source_document_id,source_revision_id,
           replacement_document_id,replacement_revision_id,replacement_path,
           replacement_title,replacement_summary,body_object_key,
           body_size_bytes,body_content_hash,actor_subject
         ) VALUES (
           $1,'global_guide',$2,$3,$4,$5,$6,'Managed guide',
           'A managed guide replacement.',$7,4,$8,'context-use-template/test'
         )`,
        [
          replacementId,
          randomUUID(),
          randomUUID(),
          replacementDocumentId,
          replacementRevisionId,
          `managed-operational-${replacementDocumentId}`,
          `documents/private/${replacementRevisionId}.md`,
          hash("9"),
        ],
      );
      await client.query(
        `INSERT INTO public_namespace_conflicts(
           conflict_key,namespace_uuid,conflict_kind,conflicting_identity_kind,
           conflict_lifecycle
         ) VALUES ($1,$2,'planned_public_id_private_id','planned_test','planned')`,
        [conflictKey, conflictId],
      );
      await client.query(
        `UPDATE operational_document_replacements
         SET phase='superseded',superseded_at=now(),updated_at=now()
         WHERE id=$1`,
        [replacementId],
      );
      expect((await client.query<{ resolved: boolean }>(
        `SELECT resolved_at IS NOT NULL AS resolved
         FROM public_namespace_conflicts WHERE conflict_key=$1`,
        [conflictKey],
      )).rows[0]?.resolved).toBe(true);
    } finally {
      await client.query("ROLLBACK");
    }
  });

  test("a hard delete holding the page row makes a concurrent pin fail without deadlock", async () => {
    const setup = new Client({ connectionString: databaseUrl });
    const deleter = new Client({ connectionString: databaseUrl });
    const publisher = new Client({ connectionString: databaseUrl });
    await Promise.all([setup.connect(), deleter.connect(), publisher.connect()]);
    let fixture: PageFixture | undefined;
    try {
      await setup.query("BEGIN");
      await setup.query("SET CONSTRAINTS ALL DEFERRED");
      fixture = await seedPagePublication(setup);
      await setup.query("DELETE FROM page_publications WHERE public_id=$1", [fixture.publicId]);
      await setup.query("COMMIT");

      await deleter.query("BEGIN");
      await publisher.query("BEGIN");
      await deleter.query("SET CONSTRAINTS ALL DEFERRED");
      await deleter.query("SET LOCAL lock_timeout='3s'");
      await publisher.query("SET LOCAL lock_timeout='3s'");
      await deleter.query(
        "SELECT id FROM knowledge_pages WHERE id=$1 FOR UPDATE",
        [fixture.pageId],
      );
      const pinResult = publisher.query(
        "INSERT INTO page_publications(public_id,artifact_id) VALUES ($1,$2)",
        [fixture.publicId, fixture.artifactId],
      ).then(() => undefined).catch((error: { code?: string }) => error.code);
      await new Promise((resolve) => setTimeout(resolve, 50));
      await deleter.query("DELETE FROM knowledge_page_versions WHERE page_id=$1", [fixture.pageId]);
      await deleter.query("DELETE FROM knowledge_pages WHERE id=$1", [fixture.pageId]);
      await deleter.query("COMMIT");
      expect(await pinResult).toBe("23514");
      await publisher.query("ROLLBACK");

      expect((await setup.query(
        "SELECT 1 FROM page_publications WHERE public_id=$1",
        [fixture.publicId],
      )).rowCount).toBe(0);
      expect((await setup.query(
        "SELECT document_id FROM public_resources WHERE public_id=$1",
        [fixture.publicId],
      )).rows[0]?.document_id).toBeNull();
      expect((await setup.query(
        "SELECT 1 FROM public_page_artifacts WHERE artifact_id=$1",
        [fixture.artifactId],
      )).rowCount).toBe(1);
    } finally {
      await deleter.query("ROLLBACK").catch(() => undefined);
      await publisher.query("ROLLBACK").catch(() => undefined);
      if (fixture) await removeCommittedPageFixture(setup, fixture);
      await Promise.all([
        setup.end().catch(() => undefined),
        deleter.end().catch(() => undefined),
        publisher.end().catch(() => undefined),
      ]);
    }
  });

  test("hub proof update serializes with a concurrent old-proof pin", async () => {
    const setup = new Client({ connectionString: databaseUrl });
    const updater = new Client({ connectionString: databaseUrl });
    const publisher = new Client({ connectionString: databaseUrl });
    await Promise.all([setup.connect(), updater.connect(), publisher.connect()]);
    let fixture: PageFixture | undefined;
    try {
      await setup.query("BEGIN");
      await setup.query("SET CONSTRAINTS ALL DEFERRED");
      fixture = await seedPagePublication(setup, "directory_hub");
      await setup.query("DELETE FROM page_publications WHERE public_id=$1", [fixture.publicId]);
      const replacementRevisionId = randomUUID();
      await insertPageRevision(setup, fixture.pageId, replacementRevisionId, 2, fixture.path);
      await setup.query("COMMIT");

      await updater.query("BEGIN");
      await publisher.query("BEGIN");
      await updater.query("SET LOCAL lock_timeout='3s'");
      await publisher.query("SET LOCAL lock_timeout='3s'");
      await updater.query(
        "UPDATE directory_hub_migrations SET public_revision_id=$2 WHERE document_id=$1",
        [fixture.pageId, replacementRevisionId],
      );
      const pinResult = publisher.query(
        "INSERT INTO page_publications(public_id,artifact_id) VALUES ($1,$2)",
        [fixture.publicId, fixture.artifactId],
      ).then(() => undefined).catch((error: { code?: string }) => error.code);
      await new Promise((resolve) => setTimeout(resolve, 50));
      await updater.query("COMMIT");
      expect(await pinResult).toBe("23514");
      await publisher.query("ROLLBACK");
      expect((await setup.query(
        "SELECT 1 FROM page_publications WHERE public_id=$1",
        [fixture.publicId],
      )).rowCount).toBe(0);
      expect((await setup.query(
        "SELECT 1 FROM public_page_artifacts WHERE artifact_id=$1",
        [fixture.artifactId],
      )).rowCount).toBe(1);
    } finally {
      await updater.query("ROLLBACK").catch(() => undefined);
      await publisher.query("ROLLBACK").catch(() => undefined);
      if (fixture) await removeCommittedPageFixture(setup, fixture);
      await Promise.all([
        setup.end().catch(() => undefined),
        updater.end().catch(() => undefined),
        publisher.end().catch(() => undefined),
      ]);
    }
  });

  test("a pin committed first makes a waiting archive recheck and fail", async () => {
    const setup = new Client({ connectionString: databaseUrl });
    const publisher = new Client({ connectionString: databaseUrl });
    const archiver = new Client({ connectionString: databaseUrl });
    await Promise.all([setup.connect(), publisher.connect(), archiver.connect()]);
    let fixture: PageFixture | undefined;
    try {
      await setup.query("BEGIN");
      await setup.query("SET CONSTRAINTS ALL DEFERRED");
      fixture = await seedPagePublication(setup);
      await setup.query("DELETE FROM page_publications WHERE public_id=$1", [fixture.publicId]);
      await setup.query("COMMIT");

      await publisher.query("BEGIN");
      await archiver.query("BEGIN");
      await publisher.query("SET LOCAL lock_timeout='3s'");
      await archiver.query("SET LOCAL lock_timeout='3s'");
      await publisher.query(
        "INSERT INTO page_publications(public_id,artifact_id) VALUES ($1,$2)",
        [fixture.publicId, fixture.artifactId],
      );
      const archiveResult = archiver.query(
        "UPDATE knowledge_pages SET archived_at=now() WHERE id=$1",
        [fixture.pageId],
      ).then(() => undefined).catch((error: { code?: string }) => error.code);
      await new Promise((resolve) => setTimeout(resolve, 50));
      await publisher.query("COMMIT");
      expect(await archiveResult).toBe("23514");
      await archiver.query("ROLLBACK");

      expect((await setup.query<{ archived_at: Date | null }>(
        "SELECT archived_at FROM knowledge_pages WHERE id=$1",
        [fixture.pageId],
      )).rows[0]?.archived_at).toBeNull();
      expect((await setup.query(
        "SELECT 1 FROM page_publications WHERE public_id=$1",
        [fixture.publicId],
      )).rowCount).toBe(1);
    } finally {
      await publisher.query("ROLLBACK").catch(() => undefined);
      await archiver.query("ROLLBACK").catch(() => undefined);
      if (fixture) await removeCommittedPageFixture(setup, fixture);
      await Promise.all([
        setup.end().catch(() => undefined),
        publisher.end().catch(() => undefined),
        archiver.end().catch(() => undefined),
      ]);
    }
  });

  test("a hub pin committed first makes waiting proof drift unpin it", async () => {
    const setup = new Client({ connectionString: databaseUrl });
    const publisher = new Client({ connectionString: databaseUrl });
    const updater = new Client({ connectionString: databaseUrl });
    await Promise.all([setup.connect(), publisher.connect(), updater.connect()]);
    let fixture: PageFixture | undefined;
    try {
      await setup.query("BEGIN");
      await setup.query("SET CONSTRAINTS ALL DEFERRED");
      fixture = await seedPagePublication(setup, "directory_hub");
      await setup.query("DELETE FROM page_publications WHERE public_id=$1", [fixture.publicId]);
      const replacementRevisionId = randomUUID();
      await insertPageRevision(setup, fixture.pageId, replacementRevisionId, 2, fixture.path);
      await setup.query("COMMIT");

      await publisher.query("BEGIN");
      await updater.query("BEGIN");
      await publisher.query("SET LOCAL lock_timeout='3s'");
      await updater.query("SET LOCAL lock_timeout='3s'");
      await publisher.query(
        "INSERT INTO page_publications(public_id,artifact_id) VALUES ($1,$2)",
        [fixture.publicId, fixture.artifactId],
      );
      const updateResult = updater.query(
        "UPDATE directory_hub_migrations SET public_revision_id=$2 WHERE document_id=$1",
        [fixture.pageId, replacementRevisionId],
      ).then(() => undefined).catch((error: { code?: string }) => error.code);
      await new Promise((resolve) => setTimeout(resolve, 50));
      await publisher.query("COMMIT");
      expect(await updateResult).toBeUndefined();
      await updater.query("COMMIT");

      expect((await setup.query(
        "SELECT 1 FROM page_publications WHERE public_id=$1",
        [fixture.publicId],
      )).rowCount).toBe(0);
      expect((await setup.query(
        "SELECT 1 FROM public_page_artifacts WHERE artifact_id=$1",
        [fixture.artifactId],
      )).rowCount).toBe(1);
    } finally {
      await publisher.query("ROLLBACK").catch(() => undefined);
      await updater.query("ROLLBACK").catch(() => undefined);
      if (fixture) await removeCommittedPageFixture(setup, fixture);
      await Promise.all([
        setup.end().catch(() => undefined),
        publisher.end().catch(() => undefined),
        updater.end().catch(() => undefined),
      ]);
    }
  });
});
