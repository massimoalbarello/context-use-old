import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Client, type Pool } from "pg";
import { disposableDatabaseUrl } from "../src/disposable-database.ts";
import { PathlessStoragePublicationRepository } from "../src/pathless-publication.ts";
import { cleanupPathlessPublicationFixtures } from "./pathless-publication-fixture-cleanup.ts";

const databaseUrl = await disposableDatabaseUrl();
const describeDatabase = databaseUrl ? describe : describe.skip;
const fixtureDocumentIds = new Set<string>();
const hash = (value: string): string => value.repeat(64).slice(0, 64);

async function errorCode(query: Promise<unknown>): Promise<string | undefined> {
  try {
    await query;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

async function asRole<T>(client: Client, role: string, action: () => Promise<T>): Promise<T> {
  await client.query(`SET ROLE ${role}`);
  try {
    return await action();
  } finally {
    await client.query("RESET ROLE").catch(() => undefined);
  }
}

function storageRepository(client: Client): PathlessStoragePublicationRepository {
  return new PathlessStoragePublicationRepository({
    query: async (sql: string, values?: unknown[]) => asRole(
      client,
      "context_use_storage",
      () => client.query(sql, values),
    ),
  } as unknown as Pool);
}

async function seedPage(client: Client) {
  const pageId = randomUUID();
  const revisionId = randomUUID();
  const path = `claim-page-${randomUUID().slice(0, 8)}`;
  await client.query("BEGIN");
  await client.query("SET CONSTRAINTS ALL DEFERRED");
  try {
    await client.query(
      "INSERT INTO knowledge_pages(id,current_path,current_version_id) VALUES ($1,$2,$3)",
      [pageId, path, revisionId],
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
         id,page_id,version_number,path,title,summary,commit_message,
         actor_kind,actor_subject,created_at
       ) VALUES (
         $1,$2,1,$3,'Claimed page','A claimed publication fixture.',
         'Create claim fixture','dashboard','context-use-owner',
         '2026-08-23 12:34:56.123456+00'
       )`,
      [revisionId, pageId, path],
    );
    await client.query(
      `INSERT INTO knowledge_revision_contracts(
         revision_id,document_id,provenance,body_content_hash,target_document_ids
       ) VALUES ($1,$2,'authored',$3,'{}'::uuid[])`,
      [revisionId, pageId, hash("a")],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
  fixtureDocumentIds.add(pageId);
  return { pageId, revisionId };
}

describeDatabase("pathless publication object claims", () => {
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

  test("repository intent claims quote PostgreSQL authorization fields", async () => {
    const page = await seedPage(client);
    const intentId = randomUUID();
    await client.query(
      `SELECT * FROM begin_pathless_publication_intent(
         $1,'publish','page',$2,$3,'context-use-owner',$4
       )`,
      [intentId, page.pageId, page.revisionId, `repository-${randomUUID()}`],
    );

    const repository = storageRepository(client);
    const intentClaim = await repository.claimIntent(intentId, randomUUID());
    expect(intentClaim.finalized).toBe(false);
    if (intentClaim.finalized) throw new Error("Expected a pending intent claim");
    expect(intentClaim.authorization.intent_id).toBe(intentId);
  }, 15_000);

  test("blocks staging and challenge issuance until the exact claim is finalized", async () => {
    const page = await seedPage(client);
    const intentId = randomUUID();
    const requestedToken = randomUUID();
    await client.query(
      `SELECT * FROM begin_pathless_publication_intent(
         $1,'publish','page',$2,$3,'context-use-owner',$4
       )`,
      [intentId, page.pageId, page.revisionId, `claim-${randomUUID()}`],
    );

    const claim = await asRole(client, "context_use_storage", async () => {
      const stored = (await client.query(
        "SELECT * FROM claim_pathless_publication_artifact($1,$2)",
        [intentId, requestedToken],
      )).rows[0]!;
      expect(stored).toMatchObject({
        claim_token: requestedToken,
        finalized: false,
        body_size_bytes: null,
        body_content_hash: null,
      });
      expect(stored.authorization.intent_id).toBe(intentId);
      expect(await errorCode(client.query(
        `SELECT stage_pathless_publication_artifact(
           $1,'page',29,$2,$3,$4,$5,NULL,NULL,NULL,NULL,NULL,
           '{}'::uuid[],'{}'::uuid[],$6
         )`,
        [
          intentId,
          hash("c"),
          stored.authorization.public_title,
          stored.authorization.public_summary,
          stored.authorization.public_last_edited_at,
          stored.authorization.projection_receipt_hash,
        ],
      ))).toBe("42501");
      return stored;
    });

    expect(await errorCode(client.query(
      "SELECT issue_confirmation_challenge('publication',$1,$2)",
      [intentId, Buffer.from(randomUUID()).toString("base64url")],
    ))).toBe("55000");
    expect(await errorCode(client.query(
      `SELECT stage_pathless_publication_artifact(
         $1,'page',29,$2,$3,$4,$5,NULL,NULL,NULL,NULL,NULL,
         '{}'::uuid[],'{}'::uuid[],$6
       )`,
      [
        intentId,
        hash("c"),
        claim.authorization.public_title,
        claim.authorization.public_summary,
        claim.authorization.public_last_edited_at,
        claim.authorization.projection_receipt_hash,
      ],
    ))).toBe("55000");

    const finalizeValues = [
      requestedToken,
      intentId,
      "page",
      29,
      hash("c"),
      claim.authorization.public_title,
      claim.authorization.public_summary,
      claim.authorization.public_last_edited_at,
      null,
      null,
      null,
      null,
      null,
      [],
      [],
      claim.authorization.projection_receipt_hash,
    ];
    const mismatchedFinalizeValues = [...finalizeValues];
    mismatchedFinalizeValues[15] = "d".repeat(64);
    expect(await asRole(client, "context_use_storage", async () => errorCode(client.query(
      `SELECT finalize_pathless_publication_artifact_claim(
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16
       )`,
      mismatchedFinalizeValues,
    )))).toBe("22023");
    expect((await client.query(
      `SELECT finalized_at FROM pathless_publication_object_claims
       WHERE allocation_kind='pathless_intent' AND allocation_id=$1`,
      [intentId],
    )).rows[0]!.finalized_at).toBeNull();
    const replay = await asRole(client, "context_use_storage", async () => {
      await client.query(
        `SELECT finalize_pathless_publication_artifact_claim(
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16
         )`,
        finalizeValues,
      );
      await client.query(
        `SELECT finalize_pathless_publication_artifact_claim(
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16
         )`,
        finalizeValues,
      );
      return (await client.query(
        "SELECT * FROM claim_pathless_publication_artifact($1,$2)",
        [intentId, randomUUID()],
      )).rows[0]!;
    });

    expect(replay).toMatchObject({
      claim_token: requestedToken,
      finalized: true,
      body_size_bytes: "29",
      body_content_hash: hash("c"),
      authorization: null,
    });
    expect(Number((await client.query(
      "SELECT count(*) AS count FROM pathless_publication_artifact_staging WHERE intent_id=$1",
      [intentId],
    )).rows[0]!.count)).toBe(1);
  }, 15_000);

  test("serializes competing brokers onto one permanent claim token", async () => {
    const page = await seedPage(client);
    const intentId = randomUUID();
    await client.query(
      `SELECT * FROM begin_pathless_publication_intent(
         $1,'publish','page',$2,$3,'context-use-owner',$4
       )`,
      [intentId, page.pageId, page.revisionId, `race-${randomUUID()}`],
    );
    const left = new Client({ connectionString: databaseUrl });
    const right = new Client({ connectionString: databaseUrl });
    await Promise.all([left.connect(), right.connect()]);
    try {
      await Promise.all([
        left.query("SET ROLE context_use_storage"),
        right.query("SET ROLE context_use_storage"),
      ]);
      const [first, second] = await Promise.all([
        left.query("SELECT * FROM claim_pathless_publication_artifact($1,$2)", [intentId, randomUUID()]),
        right.query("SELECT * FROM claim_pathless_publication_artifact($1,$2)", [intentId, randomUUID()]),
      ]);
      expect(first.rows[0]!.claim_token).toBe(second.rows[0]!.claim_token);
      expect(first.rows[0]!.artifact_id).toBe(second.rows[0]!.artifact_id);
      expect(Number((await client.query(
        `SELECT count(*) AS count FROM pathless_publication_object_claims
         WHERE allocation_kind='pathless_intent' AND allocation_id=$1`,
        [intentId],
      )).rows[0]!.count)).toBe(1);
    } finally {
      await Promise.all([
        left.end().catch(() => undefined),
        right.end().catch(() => undefined),
      ]);
    }
  }, 15_000);
});
