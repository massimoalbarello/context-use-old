import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { disposableDatabaseUrl } from "../src/disposable-database.ts";
import { cleanupPublicationFixtures } from "./publication-fixture-cleanup.ts";

const databaseUrl = await disposableDatabaseUrl();
const describeDatabase = databaseUrl ? describe : describe.skip;
const hash = (value: string): string => value.repeat(64).slice(0, 64);
const fixtureDocumentIds = new Set<string>();
const fixtureCredentialIds = new Set<string>();
const fixtureExtraIntentIds = new Set<string>();
const fixtureUserIds = new Set<string>();

type PageFixture = { pageId: string; revisionId: string };
type AssetFixture = { assetId: string };

async function errorCode(query: Promise<unknown>): Promise<string | undefined> {
  try {
    await query;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

async function seedPage(
  client: Client,
  targetDocumentIds: string[] = [],
): Promise<PageFixture> {
  const pageId = randomUUID();
  const revisionId = randomUUID();
  await client.query("BEGIN");
  await client.query("SET CONSTRAINTS ALL DEFERRED");
  try {
    await client.query(
      "INSERT INTO knowledge_pages(id,current_version_id) VALUES ($1,$2)",
      [pageId, revisionId],
    );
    await client.query(
      `INSERT INTO hypermedia_document_revisions(
         id,document_id,revision_number,body_object_key,body_size_bytes,
         body_content_hash,created_at
       ) VALUES ($1,$2,1,$3,7,$4,'2026-08-23 12:34:56.123456+00')`,
      [revisionId, pageId, `documents/private/${revisionId}.md`, hash("a")],
    );
    await client.query(
      `INSERT INTO knowledge_page_versions(
         id,page_id,version_number,title,summary,commit_message,
         actor_kind,actor_subject,created_at
       ) VALUES (
         $1,$2,1,'Canonical API','A checked publication fixture.',
         'Create publication fixture','dashboard','context-use-owner',
         '2026-08-23 12:34:56.123456+00'
       )`,
      [revisionId, pageId],
    );
    await client.query(
      `INSERT INTO knowledge_revision_contracts(
         revision_id,document_id,provenance,body_content_hash,target_document_ids
       ) VALUES ($1,$2,'authored',$3,$4::uuid[])`,
      [revisionId, pageId, hash("a"), targetDocumentIds],
    );
    await client.query("COMMIT");
    fixtureDocumentIds.add(pageId);
    return { pageId, revisionId };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function seedAsset(
  client: Client,
  overrides: {
    filename?: string;
    contentType?: string;
    sizeBytes?: string | number;
    durationSeconds?: string | null;
  } = {},
): Promise<AssetFixture> {
  const assetId = randomUUID();
  await client.query(
    `INSERT INTO assets(
       id,filename,content_type,size_bytes,content_hash,s3_object_key,
       width,height,duration_seconds
     ) VALUES ($1,$2,$3,$4,$5,$6,NULL,NULL,$7::numeric)`,
    [
      assetId,
      overrides.filename ?? "fixture.png",
      overrides.contentType ?? "image/png",
      overrides.sizeBytes ?? 11,
      hash("b"),
      `objects/${assetId}`,
      overrides.durationSeconds ?? null,
    ],
  );
  fixtureDocumentIds.add(assetId);
  return { assetId };
}

async function advancePage(client: Client, page: PageFixture): Promise<void> {
  const revisionId = randomUUID();
  await client.query("BEGIN");
  await client.query("SET CONSTRAINTS ALL DEFERRED");
  try {
    await client.query(
      `INSERT INTO hypermedia_document_revisions(
         id,document_id,revision_number,body_object_key,body_size_bytes,
         body_content_hash
       ) VALUES ($1,$2,2,$3,8,$4)`,
      [revisionId, page.pageId, `documents/private/${revisionId}.md`, hash("e")],
    );
    await client.query(
      `INSERT INTO knowledge_page_versions(
         id,page_id,version_number,title,summary,commit_message,
         actor_kind,actor_subject
       ) VALUES (
         $1,$2,2,'Advanced page','A newer checked page revision.',
         'Advance publication fixture','dashboard','context-use-owner'
       )`,
      [revisionId, page.pageId],
    );
    await client.query(
      `INSERT INTO knowledge_revision_contracts(
         revision_id,document_id,provenance,body_content_hash,target_document_ids
       ) VALUES ($1,$2,'authored',$3,'{}'::uuid[])`,
      [revisionId, page.pageId, hash("e")],
    );
    await client.query(
      `UPDATE knowledge_pages
       SET current_version_id=$2,updated_at=now()
       WHERE id=$1`,
      [page.pageId, revisionId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function seedActiveAssetPublication(
  client: Client,
  assetId: string,
): Promise<string> {
  const publicId = randomUUID();
  const artifactId = randomUUID();
  const retainedSourceId = randomUUID();
  const objectKey = `artifacts/public/${artifactId}`;
  const representationToken = randomUUID().replaceAll("-", "").repeat(2);
  await client.query(
    `INSERT INTO public_resources(public_id,document_id,resource_kind)
     VALUES ($1,$2,'asset')`,
    [publicId, assetId],
  );
  await client.query(
    `INSERT INTO public_artifact_id_reservations(
       artifact_id,body_object_key,allocation_kind,allocation_id
     ) VALUES ($1,$2,'retained_publication',$3)`,
    [artifactId, objectKey, retainedSourceId],
  );
  await client.query(
    `INSERT INTO public_asset_artifacts(
       artifact_id,public_id,source_document_id,body_object_key,
       body_size_bytes,body_content_hash,public_filename,public_content_type,
       origin,retained_source_id,retained_source_kind,representation_token,
       reservation_allocation_kind,reservation_allocation_id
     ) VALUES (
       $1,$2,$3,$4,11,$5,'fixture.png','image/png','retained',
       $6,'asset',$7,'retained_publication',$6
     )`,
    [artifactId, publicId, assetId, objectKey, hash("b"), retainedSourceId, representationToken],
  );
  await client.query(
    "INSERT INTO asset_publications(public_id,artifact_id) VALUES ($1,$2)",
    [publicId, artifactId],
  );
  return publicId;
}

async function ensureFixtureOwner(client: Client): Promise<void> {
  const insertedOwner = await client.query<{ id: string }>(
    `INSERT INTO auth."user"(id,name,email,"emailVerified")
     VALUES ('context-use-owner','Canonical owner',$1,true)
     ON CONFLICT (id) DO NOTHING
     RETURNING id`,
    [`canonical-${randomUUID()}@example.test`],
  );
  for (const { id } of insertedOwner.rows) fixtureUserIds.add(id);
}

async function seedOwnerPasskey(
  client: Client,
  counter = 0,
): Promise<string> {
  const credentialId = `credential-${randomUUID()}`;
  await ensureFixtureOwner(client);
  await client.query(
    `INSERT INTO auth.passkey(
       id,"publicKey","userId","credentialID",counter,"deviceType","backedUp"
     ) VALUES ($1,'public-key','context-use-owner',$2,$3,'singleDevice',false)`,
    [randomUUID(), credentialId, counter],
  );
  fixtureCredentialIds.add(credentialId);
  return credentialId;
}

async function stageAssetPublication(
  client: Client,
  assetId: string,
  sessionId: string,
): Promise<{ intentId: string; publicId: string; artifactId: string }> {
  const intentId = randomUUID();
  const planned = (await client.query(
    `SELECT * FROM begin_publication_intent(
       $1,'publish','asset',$2,NULL,'context-use-owner',$3
     )`,
    [intentId, assetId, sessionId],
  )).rows[0]!;
  const claim = (await client.query(
    "SELECT * FROM claim_publication_artifact($1,$2)",
    [intentId, randomUUID()],
  )).rows[0]!;
  const target = claim.authorization;
  await client.query(
    `SELECT finalize_publication_artifact_claim(
       $1,$2,'asset',$3,$4,NULL,NULL,NULL,$5,$6,$7,$8,$9,
       '{}'::uuid[],'{}'::uuid[],NULL
     )`,
    [
      claim.claim_token,
      intentId,
      target.source_body_size_bytes,
      target.source_body_content_hash,
      target.public_filename,
      target.public_content_type,
      target.public_width,
      target.public_height,
      target.public_duration_seconds,
    ],
  );
  return {
    intentId,
    publicId: planned.candidate_public_id as string,
    artifactId: claim.artifact_id as string,
  };
}

async function stagePagePublication(
  client: Client,
  page: PageFixture,
  sessionId: string,
): Promise<{ intentId: string; publicId: string; artifactId: string }> {
  const intentId = randomUUID();
  const planned = (await client.query(
    `SELECT * FROM begin_publication_intent(
       $1,'publish','page',$2,$3,'context-use-owner',$4
     )`,
    [intentId, page.pageId, page.revisionId, sessionId],
  )).rows[0]!;
  const claim = (await client.query(
    "SELECT * FROM claim_publication_artifact($1,$2)",
    [intentId, randomUUID()],
  )).rows[0]!;
  const target = claim.authorization;
  await client.query(
    `SELECT finalize_publication_artifact_claim(
       $1,$2,'page',29,$3,$4,$5,$6,NULL,NULL,NULL,NULL,NULL,$7,$8,$9
     )`,
    [
      claim.claim_token,
      intentId,
      hash("c"),
      target.public_title,
      target.public_summary,
      target.public_last_edited_at,
      target.projected_target_public_ids,
      target.projected_target_public_ids,
      target.projection_receipt_hash,
    ],
  );
  return {
    intentId,
    publicId: planned.candidate_public_id as string,
    artifactId: claim.artifact_id as string,
  };
}

async function confirmPublicationAsRole(
  intentId: string,
  sessionId: string,
  credentialId: string,
  expectedCounter: number,
  newCounter: number,
): Promise<void> {
  const confirmation = new Client({ connectionString: databaseUrl });
  await confirmation.connect();
  try {
    await confirmation.query("SET ROLE context_use_confirmation");
    await confirmation.query(
      `SELECT confirm_publication_intent(
         $1,'context-use-owner',$2,$3,$4,$5
       )`,
      [intentId, sessionId, credentialId, expectedCounter, newCounter],
    );
  } finally {
    await confirmation.query("RESET ROLE").catch(() => undefined);
    await confirmation.end().catch(() => undefined);
  }
}

describeDatabase("checked publication planning and staging", () => {
  const client = new Client({ connectionString: databaseUrl });

  beforeAll(async () => {
    await client.connect();
  });

  afterAll(async () => {
    try {
      await cleanupPublicationFixtures(client, fixtureDocumentIds, {
        extraIntentIds: fixtureExtraIntentIds,
        credentialIds: fixtureCredentialIds,
        userIds: fixtureUserIds,
      });
    } finally {
      await client.end().catch(() => undefined);
    }
  });

  test("round-trips a microsecond page receipt and freezes a DB-derived token", async () => {
    const page = await seedPage(client);
    const intentId = randomUUID();
    const sessionId = `canonical-api-${randomUUID()}`;
    const planned = (await client.query(
      `SELECT * FROM begin_publication_intent(
         $1,'publish','page',$2,$3,'context-use-owner',$4
       )`,
      [intentId, page.pageId, page.revisionId, sessionId],
    )).rows[0]!;
    expect(planned.candidate_public_id).toMatch(/^[0-9a-f-]{36}$/);

    const claim = (await client.query(
      "SELECT * FROM claim_publication_artifact($1,$2)",
      [intentId, randomUUID()],
    )).rows[0]!;
    const target = claim.authorization;
    expect(target.public_last_edited_at).toBe("2026-08-23T12:34:56.123456Z");
    expect(target.target_projection).toEqual([]);

    const finalizeArguments = [
      claim.claim_token,
      intentId,
      "page",
      29,
      hash("c"),
      target.public_title,
      target.public_summary,
      target.public_last_edited_at,
      null,
      null,
      null,
      null,
      null,
      target.projected_target_public_ids,
      target.projected_target_public_ids,
      target.projection_receipt_hash,
    ];
    await client.query(
      `SELECT finalize_publication_artifact_claim(
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16
       )`,
      finalizeArguments,
    );
    const staged = (await client.query<{
      representation_token: string;
      reserved: boolean;
    }>(
      `SELECT staging.representation_token,
         EXISTS (
           SELECT 1 FROM public_representation_token_reservations reservation
           WHERE reservation.representation_token=staging.representation_token
             AND reservation.artifact_id=staging.artifact_id
             AND reservation.resource_kind=staging.target_kind
         ) AS reserved
       FROM publication_artifact_staging staging
       WHERE staging.intent_id=$1`,
      [intentId],
    )).rows[0]!;
    expect(staged.representation_token).toMatch(/^[a-f0-9]{64}$/);
    expect(staged.reserved).toBe(true);
    expect(await errorCode(client.query(
      "SELECT * FROM get_publication_write_target($1)",
      [intentId],
    ))).toBe("55000");

    await client.query(
      "SELECT issue_confirmation_challenge('publication',$1,$2)",
      [intentId, Buffer.from(randomUUID()).toString("base64url")],
    );
    await client.query("UPDATE knowledge_pages SET archived_at=now() WHERE id=$1", [page.pageId]);
    await client.query(
      `SELECT finalize_publication_artifact_claim(
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16
       )`,
      finalizeArguments,
    );
    const mismatched = [...finalizeArguments];
    mismatched[3] = 30;
    expect(await errorCode(client.query(
      `SELECT finalize_publication_artifact_claim(
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16
       )`,
      mismatched,
    ))).toBe("23505");
  }, 15_000);

  test("serializes concurrent exact begin retries into one allocation", async () => {
    const asset = await seedAsset(client);
    const intentId = randomUUID();
    const sessionId = `concurrent-${randomUUID()}`;
    const first = new Client({ connectionString: databaseUrl });
    const second = new Client({ connectionString: databaseUrl });
    await Promise.all([first.connect(), second.connect()]);
    try {
      const query = `SELECT * FROM begin_publication_intent(
        $1,'publish','asset',$2,NULL,'context-use-owner',$3
      )`;
      const [left, right] = await Promise.all([
        first.query(query, [intentId, asset.assetId, sessionId]),
        second.query(query, [intentId, asset.assetId, sessionId]),
      ]);
      expect(left.rows[0]?.candidate_public_id).toBe(right.rows[0]?.candidate_public_id);
      expect(Number((await client.query(
        `SELECT count(*) AS count FROM public_artifact_id_reservations
         WHERE allocation_kind='publication_intent' AND allocation_id=$1`,
        [intentId],
      )).rows[0]?.count)).toBe(1);
    } finally {
      await Promise.all([
        first.end().catch(() => undefined),
        second.end().catch(() => undefined),
      ]);
    }
  }, 15_000);

  test("projects the canonical route kind for an active linked asset", async () => {
    const asset = await seedAsset(client);
    const linkedPublicId = await seedActiveAssetPublication(client, asset.assetId);
    const page = await seedPage(client, [asset.assetId]);
    const intentId = randomUUID();
    const planned = (await client.query(
      `SELECT * FROM begin_publication_intent(
         $1,'publish','page',$2,$3,'context-use-owner',$4
       )`,
      [intentId, page.pageId, page.revisionId, `projection-${randomUUID()}`],
    )).rows[0]!;
    const target = (await client.query(
      "SELECT * FROM claim_publication_artifact($1,$2)",
      [intentId, randomUUID()],
    )).rows[0]!.authorization;
    expect(target.target_projection).toEqual([{
      target_document_id: asset.assetId,
      outcome: "active_public",
      public_id: linkedPublicId,
      public_target_kind: "asset",
    }]);
    expect(target.projected_target_public_ids).toEqual([linkedPublicId]);
    expect(planned.candidate_public_id).not.toBe(linkedPublicId);
  });

  test("round-trips high-precision asset duration as canonical decimal text", async () => {
    const duration = "1234567890.12345678901234567890";
    const asset = await seedAsset(client, { durationSeconds: duration });
    const intentId = randomUUID();
    await client.query(
      `SELECT * FROM begin_publication_intent(
         $1,'publish','asset',$2,NULL,'context-use-owner',$3
       )`,
      [intentId, asset.assetId, `duration-${randomUUID()}`],
    );
    const storage = new Client({ connectionString: databaseUrl });
    await storage.connect();
    try {
      await storage.query("SET ROLE context_use_storage");
      const claim = (await storage.query(
        "SELECT * FROM claim_publication_artifact($1,$2)",
        [intentId, randomUUID()],
      )).rows[0]!;
      const target = claim.authorization;
      expect(target.public_duration_seconds).toBe(duration);
      expect(await errorCode(storage.query(
        "SELECT id FROM publication_intents WHERE id=$1",
        [intentId],
      ))).toBe("42501");
      expect(await errorCode(storage.query(
        "SELECT intent_id FROM publication_artifact_staging WHERE intent_id=$1",
        [intentId],
      ))).toBe("42501");
      expect(await errorCode(storage.query(
        "SELECT publication_source_fingerprint('asset',$1,NULL)",
        [asset.assetId],
      ))).toBe("42501");
      expect(await errorCode(storage.query(
        "SELECT publication_projection_plan($1,NULL,$2)",
        [asset.assetId, target.candidate_public_id],
      ))).toBe("42501");
      expect((await storage.query(
        "SELECT s3_object_key FROM assets WHERE id=$1",
        [asset.assetId],
      )).rows[0]?.s3_object_key).toBe(`objects/${asset.assetId}`);
      await storage.query(
        `SELECT finalize_publication_artifact_claim(
           $1,$2,'asset',$3,$4,NULL,NULL,NULL,$5,$6,NULL,NULL,$7,
           '{}'::uuid[],'{}'::uuid[],NULL
         )`,
        [
          claim.claim_token,
          intentId,
          target.source_body_size_bytes,
          target.source_body_content_hash,
          target.public_filename,
          target.public_content_type,
          target.public_duration_seconds,
        ],
      );
    } finally {
      await storage.query("RESET ROLE").catch(() => undefined);
      await storage.end().catch(() => undefined);
    }
    expect((await client.query(
      "SELECT 1 FROM publication_artifact_staging WHERE intent_id=$1",
      [intentId],
    )).rowCount).toBe(1);
    const owner = (await client.query(
      `SELECT rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,
         rolreplication,rolbypassrls
       FROM pg_roles WHERE rolname='context_use_storage_owner'`,
    )).rows[0]!;
    expect(owner).toEqual({
      rolsuper: false,
      rolinherit: false,
      rolcreaterole: false,
      rolcreatedb: false,
      rolcanlogin: false,
      rolreplication: false,
      rolbypassrls: false,
    });
    expect(Number((await client.query(
      `SELECT count(*) AS count FROM pg_auth_members membership
       JOIN pg_roles member_role ON member_role.oid=membership.member
       JOIN pg_roles granted_role ON granted_role.oid=membership.roleid
       WHERE member_role.rolname='context_use_storage_owner'
          OR granted_role.rolname='context_use_storage_owner'`,
    )).rows[0]?.count)).toBe(0);
    expect((await client.query(
      `SELECT has_column_privilege(
         'context_use_boundary_owner','assets','s3_object_key','SELECT'
       ) AS allowed`,
    )).rows[0]?.allowed).toBe(false);

    const oversized = await seedAsset(client, { sizeBytes: "5000000001" });
    expect(await errorCode(client.query(
      `SELECT * FROM begin_publication_intent(
         $1,'publish','asset',$2,NULL,'context-use-owner',$3
       )`,
      [randomUUID(), oversized.assetId, `oversized-${randomUUID()}`],
    ))).toBe("22023");
  });

  test("rejects challenge-before-stage, detached mappings, and unsafe asset metadata", async () => {
    const unstaged = await seedAsset(client);
    const unstagedIntent = randomUUID();
    await client.query(
      `SELECT * FROM begin_publication_intent(
         $1,'publish','asset',$2,NULL,'context-use-owner',$3
       )`,
      [unstagedIntent, unstaged.assetId, `unstaged-${randomUUID()}`],
    );
    expect(await errorCode(client.query(
      "SELECT issue_confirmation_challenge('publication',$1,$2)",
      [unstagedIntent, "B".repeat(43)],
    ))).toBe("55000");

    const detached = await seedAsset(client);
    const detachedPublicId = randomUUID();
    await client.query(
      `INSERT INTO public_resources(public_id,document_id,resource_kind)
       VALUES ($1,$2,'asset')`,
      [detachedPublicId, detached.assetId],
    );
    await client.query(
      "UPDATE public_resources SET document_id=NULL WHERE public_id=$1",
      [detachedPublicId],
    );
    expect(await errorCode(client.query(
      `SELECT * FROM begin_publication_intent(
         $1,'publish','asset',$2,NULL,'context-use-owner',$3
       )`,
      [randomUUID(), detached.assetId, `detached-${randomUUID()}`],
    ))).toBe("23514");

    const unsafeFilename = await seedAsset(client, { filename: "../private.png" });
    expect(await errorCode(client.query(
      `SELECT * FROM begin_publication_intent(
         $1,'publish','asset',$2,NULL,'context-use-owner',$3
       )`,
      [randomUUID(), unsafeFilename.assetId, `unsafe-${randomUUID()}`],
    ))).toBe("22023");
    const leakedId = randomUUID();
    const unsafeContentType = await seedAsset(client, {
      contentType: `application/x-${leakedId}`,
    });
    expect(await errorCode(client.query(
      `SELECT * FROM begin_publication_intent(
         $1,'publish','asset',$2,NULL,'context-use-owner',$3
       )`,
      [randomUUID(), unsafeContentType.assetId, `unsafe-${randomUUID()}`],
    ))).toBe("22023");
  });

  test("confirms, republishes, replays, and symmetrically unpublishes an asset", async () => {
    const asset = await seedAsset(client);
    const credentialId = await seedOwnerPasskey(client);
    const firstSession = `confirm-first-${randomUUID()}`;
    const first = await stageAssetPublication(client, asset.assetId, firstSession);
    await client.query(
      "SELECT issue_confirmation_challenge('publication',$1,$2)",
      [first.intentId, Buffer.from(randomUUID()).toString("base64url")],
    );
    await confirmPublicationAsRole(
      first.intentId, firstSession, credentialId, 0, 1,
    );
    expect((await client.query(
      "SELECT count(*) AS count FROM public_route_aliases WHERE public_id=$1",
      [first.publicId],
    )).rows[0]?.count).toBe("0");
    expect((await client.query(
      "SELECT artifact_id FROM asset_publications WHERE public_id=$1",
      [first.publicId],
    )).rows[0]?.artifact_id).toBe(first.artifactId);

    await client.query("SET session_replication_role=replica");
    try {
      await client.query(
        `UPDATE publication_intents
         SET created_at=created_at-interval '10 minutes',
           expires_at=expires_at-interval '10 minutes'
         WHERE id=$1`,
        [first.intentId],
      );
    } finally {
      await client.query("SET session_replication_role=origin");
    }
    await client.query(
      `UPDATE auth.passkey SET counter=9
       WHERE "userId"='context-use-owner' AND "credentialID"=$1`,
      [credentialId],
    );
    await confirmPublicationAsRole(
      first.intentId, firstSession, credentialId, 0, 1,
    );
    expect((await client.query(
      `SELECT counter FROM auth.passkey
       WHERE "userId"='context-use-owner' AND "credentialID"=$1`,
      [credentialId],
    )).rows[0]?.counter).toBe(9);

    const aliasCount = (await client.query(
      "SELECT count(*) AS count FROM public_route_aliases WHERE public_id=$1",
      [first.publicId],
    )).rows[0]?.count;
    const secondSession = `confirm-second-${randomUUID()}`;
    const second = await stageAssetPublication(client, asset.assetId, secondSession);
    expect(second.publicId).toBe(first.publicId);
    await client.query(
      "SELECT issue_confirmation_challenge('publication',$1,$2)",
      [second.intentId, Buffer.from(randomUUID()).toString("base64url")],
    );
    await confirmPublicationAsRole(
      second.intentId, secondSession, credentialId, 9, 10,
    );
    expect((await client.query(
      "SELECT count(*) AS count FROM public_route_aliases WHERE public_id=$1",
      [first.publicId],
    )).rows[0]?.count).toBe(aliasCount);
    expect((await client.query(
      "SELECT count(*) AS count FROM public_asset_artifacts WHERE public_id=$1",
      [first.publicId],
    )).rows[0]?.count).toBe("2");
    expect((await client.query(
      "SELECT artifact_id FROM asset_publications WHERE public_id=$1",
      [first.publicId],
    )).rows[0]?.artifact_id).toBe(second.artifactId);

    const unpublishIntentId = randomUUID();
    const unpublishSession = `unpublish-${randomUUID()}`;
    await client.query(
      `SELECT * FROM begin_publication_intent(
         $1,'unpublish','asset',$2,NULL,'context-use-owner',$3
       )`,
      [unpublishIntentId, asset.assetId, unpublishSession],
    );
    await client.query(
      "SELECT issue_confirmation_challenge('publication',$1,$2)",
      [unpublishIntentId, Buffer.from(randomUUID()).toString("base64url")],
    );
    await confirmPublicationAsRole(
      unpublishIntentId, unpublishSession, credentialId, 10, 11,
    );
    expect((await client.query(
      "SELECT 1 FROM asset_publications WHERE public_id=$1",
      [first.publicId],
    )).rowCount).toBe(0);
    expect((await client.query(
      "SELECT count(*) AS count FROM public_asset_artifacts WHERE public_id=$1",
      [first.publicId],
    )).rows[0]?.count).toBe("2");
  }, 15_000);

  test("publishes, republishes, and symmetrically unpublishes a page as confirmation", async () => {
    const page = await seedPage(client);
    const credentialId = await seedOwnerPasskey(client);
    const firstSession = `page-first-${randomUUID()}`;
    await client.query("SET TIME ZONE 'Pacific/Kiritimati'");
    const first = await stagePagePublication(client, page, firstSession)
      .finally(() => client.query("SET TIME ZONE 'UTC'"));
    await client.query(
      "SELECT issue_confirmation_challenge('publication',$1,$2)",
      [first.intentId, Buffer.from(randomUUID()).toString("base64url")],
    );
    await confirmPublicationAsRole(
      first.intentId, firstSession, credentialId, 0, 1,
    );
    expect((await client.query(
      "SELECT artifact_id FROM page_publications WHERE public_id=$1",
      [first.publicId],
    )).rows[0]?.artifact_id).toBe(first.artifactId);
    expect((await client.query(
      "SELECT count(*) AS count FROM public_route_aliases WHERE public_id=$1",
      [first.publicId],
    )).rows[0]?.count).toBe("0");

    const aliasCount = (await client.query(
      "SELECT count(*) AS count FROM public_route_aliases WHERE public_id=$1",
      [first.publicId],
    )).rows[0]?.count;
    const secondSession = `page-second-${randomUUID()}`;
    const second = await stagePagePublication(client, page, secondSession);
    expect(second.publicId).toBe(first.publicId);
    await client.query(
      "SELECT issue_confirmation_challenge('publication',$1,$2)",
      [second.intentId, Buffer.from(randomUUID()).toString("base64url")],
    );
    await confirmPublicationAsRole(
      second.intentId, secondSession, credentialId, 1, 2,
    );
    expect((await client.query(
      "SELECT count(*) AS count FROM public_route_aliases WHERE public_id=$1",
      [first.publicId],
    )).rows[0]?.count).toBe(aliasCount);
    expect((await client.query(
      "SELECT count(*) AS count FROM public_page_artifacts WHERE public_id=$1",
      [first.publicId],
    )).rows[0]?.count).toBe("2");

    const unpublishIntentId = randomUUID();
    const unpublishSession = `page-unpublish-${randomUUID()}`;
    await client.query(
      `SELECT * FROM begin_publication_intent(
         $1,'unpublish','page',$2,NULL,'context-use-owner',$3
       )`,
      [unpublishIntentId, page.pageId, unpublishSession],
    );
    await client.query(
      "SELECT issue_confirmation_challenge('publication',$1,$2)",
      [unpublishIntentId, Buffer.from(randomUUID()).toString("base64url")],
    );
    await confirmPublicationAsRole(
      unpublishIntentId, unpublishSession, credentialId, 2, 3,
    );
    expect((await client.query(
      "SELECT 1 FROM page_publications WHERE public_id=$1",
      [first.publicId],
    )).rowCount).toBe(0);
    expect((await client.query(
      "SELECT count(*) AS count FROM public_page_artifacts WHERE public_id=$1",
      [first.publicId],
    )).rows[0]?.count).toBe("2");
  }, 15_000);

  test("rolls back challenge and passkey consumption on a late namespace failure", async () => {
    const asset = await seedAsset(client);
    const credentialId = await seedOwnerPasskey(client);
    const sessionId = `confirm-rollback-${randomUUID()}`;
    const staged = await stageAssetPublication(client, asset.assetId, sessionId);
    await client.query(
      "SELECT issue_confirmation_challenge('publication',$1,$2)",
      [staged.intentId, Buffer.from(randomUUID()).toString("base64url")],
    );
    await client.query(
      `INSERT INTO assets(
         id,filename,content_type,size_bytes,content_hash,s3_object_key
       ) VALUES ($1,'collision.bin','application/octet-stream',1,$2,$3)`,
      [
        staged.publicId,
        hash("d"),
        `objects/${staged.publicId}`,
      ],
    );
    fixtureDocumentIds.add(staged.publicId);
    expect(await errorCode(confirmPublicationAsRole(
      staged.intentId, sessionId, credentialId, 0, 1,
    ))).toBe("23505");
    expect((await client.query(
      `SELECT counter FROM auth.passkey
       WHERE "userId"='context-use-owner' AND "credentialID"=$1`,
      [credentialId],
    )).rows[0]?.counter).toBe(0);
    expect((await client.query(
      `SELECT 1 FROM confirmation_challenges
       WHERE intent_kind='publication' AND intent_id=$1`,
      [staged.intentId],
    )).rowCount).toBe(1);
    expect((await client.query(
      "SELECT confirmed_at FROM publication_intents WHERE id=$1",
      [staged.intentId],
    )).rows[0]?.confirmed_at).toBeNull();
  });

  test("orders page deletion confirmation before a competing canonical target lock", async () => {
    const page = await seedPage(client);
    await client.query("UPDATE knowledge_pages SET archived_at=now() WHERE id=$1", [page.pageId]);
    const deletionIntentId = randomUUID();
    const sessionId = `delete-race-${randomUUID()}`;
    const credentialId = `credential-${randomUUID()}`;
    await ensureFixtureOwner(client);
    await client.query(
      `INSERT INTO auth.passkey(
         id,"publicKey","userId","credentialID",counter,"deviceType","backedUp"
       ) VALUES ($1,'public-key','context-use-owner',$2,0,'singleDevice',false)`,
      [randomUUID(), credentialId],
    );
    fixtureCredentialIds.add(credentialId);
    await client.query(
      `INSERT INTO page_deletion_intents(
         id,page_id,expected_version_id,owner_user_id,session_id,expires_at
       ) VALUES (
         $1,$2,$3,'context-use-owner',$4,now()+interval '5 minutes'
       )`,
      [deletionIntentId, page.pageId, page.revisionId, sessionId],
    );
    await client.query(
      `INSERT INTO confirmation_challenges(intent_kind,intent_id,challenge)
       VALUES ('page_deletion',$1,$2)`,
      [deletionIntentId, Buffer.from(randomUUID()).toString("base64url")],
    );

    const locker = new Client({ connectionString: databaseUrl });
    const confirmer = new Client({ connectionString: databaseUrl });
    await Promise.all([locker.connect(), confirmer.connect()]);
    try {
      await locker.query("BEGIN");
      await locker.query("SET LOCAL lock_timeout='2s'");
      await confirmer.query("SET lock_timeout='2s'");
      await locker.query("SELECT lock_operational_document($1)", [page.pageId]);
      const confirmation = confirmer.query(
        `SELECT confirm_page_deletion_intent(
           $1,'context-use-owner',$2,$3,0,1
         )`,
        [deletionIntentId, sessionId, credentialId],
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(await errorCode(locker.query(
        `SELECT * FROM begin_publication_intent(
           $1,'publish','page',$2,$3,'context-use-owner',$4
         )`,
        [randomUUID(), page.pageId, page.revisionId, `racer-${randomUUID()}`],
      ))).toBe("23514");
      await locker.query("ROLLBACK");
      await confirmation;
      expect(Number((await client.query(
        "SELECT count(*) AS count FROM knowledge_pages WHERE id=$1",
        [page.pageId],
      )).rows[0]?.count)).toBe(0);
    } finally {
      await locker.query("ROLLBACK").catch(() => undefined);
      await Promise.all([
        locker.end().catch(() => undefined),
        confirmer.end().catch(() => undefined),
      ]);
    }
  }, 15_000);
});
