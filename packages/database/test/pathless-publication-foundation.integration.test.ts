import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { disposableDatabaseUrl } from "../src/disposable-database.ts";

const databaseUrl = await disposableDatabaseUrl();
const describeDatabase = databaseUrl ? describe : describe.skip;
const hash = (value: string): string => value.repeat(64).slice(0, 64);
const randomToken = (): string => randomUUID().replaceAll("-", "").repeat(2);

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

describeDatabase("pathless publication global namespaces", () => {
  const client = new Client({ connectionString: databaseUrl });

  beforeAll(async () => {
    await client.connect();
  });

  afterAll(async () => {
    await client.end().catch(() => undefined);
  });

  test("representation tokens and artifact UUIDs are globally permanent", async () => {
    await client.query("BEGIN");
    try {
      const token = hash("a");
      const artifactId = randomUUID();
      await client.query(
        `INSERT INTO public_representation_token_reservations(
           representation_token,artifact_id,resource_kind
         ) VALUES ($1,$2,'page')`,
        [token, artifactId],
      );
      expect(await sqlState(client, () => client.query(
        `INSERT INTO public_representation_token_reservations(
           representation_token,artifact_id,resource_kind
         ) VALUES ($1,$2,'asset')`,
        [token, randomUUID()],
      ))).toBe("23505");
      expect(await sqlState(client, () => client.query(
        `INSERT INTO public_representation_token_reservations(
           representation_token,artifact_id,resource_kind
         ) VALUES ($1,$2,'asset')`,
        [hash("b"), artifactId],
      ))).toBe("23505");
      expect(await sqlState(client, () => client.query(
        `UPDATE public_representation_token_reservations
         SET representation_token=$2 WHERE representation_token=$1`,
        [token, hash("c")],
      ))).toBe("23514");
      expect(await sqlState(client, () => client.query(
        "DELETE FROM public_representation_token_reservations WHERE representation_token=$1",
        [token],
      ))).toBe("23514");
    } finally {
      await client.query("ROLLBACK");
    }
  });

  test("publication intent UUIDs cannot cross families or be reused", async () => {
    await client.query("BEGIN");
    try {
      const legacyId = randomUUID();
      await client.query(
        `INSERT INTO publication_intents(
           id,action,target_kind,target_id,owner_user_id,session_id,expires_at
         ) VALUES (
           $1,'unpublish','page',$2,'context-use-owner','foundation-test',
           now()+interval '5 minutes'
         )`,
        [legacyId, randomUUID()],
      );
      await client.query("DELETE FROM publication_intents WHERE id=$1", [legacyId]);
      expect(await sqlState(client, () => client.query(
        `INSERT INTO publication_intents(
           id,action,target_kind,target_id,owner_user_id,session_id,expires_at
         ) VALUES (
           $1,'unpublish','page',$2,'context-use-owner','foundation-test',
           now()+interval '5 minutes'
         )`,
        [legacyId, randomUUID()],
      ))).toBe("23505");
      expect(await sqlState(client, () => client.query(
        `INSERT INTO pathless_publication_intents(
           id,action,target_kind,target_document_id,owner_user_id,session_id,
           expires_at,expected_visibility_generation,
           expected_visibility_state_hash,expected_target_generation
         ) VALUES (
           $1,'unpublish','page',$2,'context-use-owner','foundation-test',
           now()+interval '5 minutes',0,$3,0
         )`,
        [legacyId, randomUUID(), hash("d")],
      ))).toBe("23505");

      const pathlessId = randomUUID();
      await client.query(
        `INSERT INTO pathless_publication_intents(
           id,action,target_kind,target_document_id,owner_user_id,session_id,
           expires_at,expected_visibility_generation,
           expected_visibility_state_hash,expected_target_generation
         ) VALUES (
           $1,'unpublish','asset',$2,'context-use-owner','foundation-test',
           now()+interval '5 minutes',0,$3,0
         )`,
        [pathlessId, randomUUID(), hash("e")],
      );
      expect(await sqlState(client, () => client.query(
        `INSERT INTO publication_intents(
           id,action,target_kind,target_id,owner_user_id,session_id,expires_at
         ) VALUES (
           $1,'unpublish','asset',$2,'context-use-owner','foundation-test',
           now()+interval '5 minutes'
         )`,
        [pathlessId, randomUUID()],
      ))).toBe("23505");
    } finally {
      await client.query("ROLLBACK");
    }
  });

  test("serializes cross-kind representation token and artifact UUID races", async () => {
    const contender = new Client({ connectionString: databaseUrl });
    const firstToken = randomToken();
    const firstArtifact = randomUUID();
    const secondArtifact = randomUUID();
    const secondToken = randomToken();
    const competingToken = randomToken();
    const sharedArtifact = randomUUID();
    await contender.connect();
    try {
      await client.query("BEGIN");
      await contender.query("BEGIN");
      await contender.query("SET LOCAL lock_timeout='3s'");
      await client.query(
        `INSERT INTO public_representation_token_reservations(
           representation_token,artifact_id,resource_kind
         ) VALUES ($1,$2,'page')`,
        [firstToken, firstArtifact],
      );
      const tokenLoser = contender.query(
        `INSERT INTO public_representation_token_reservations(
           representation_token,artifact_id,resource_kind
         ) VALUES ($1,$2,'asset')`,
        [firstToken, secondArtifact],
      ).then(() => undefined, (error: { code?: string }) => error.code);
      await new Promise((resolve) => setTimeout(resolve, 50));
      await client.query("COMMIT");
      expect(await tokenLoser).toBe("23505");
      await contender.query("ROLLBACK");
      expect((await client.query<{ count: string }>(
        `SELECT count(*)::text AS count
         FROM public_representation_token_reservations
         WHERE representation_token=$1`,
        [firstToken],
      )).rows[0]!.count).toBe("1");

      await client.query("BEGIN");
      await contender.query("BEGIN");
      await contender.query("SET LOCAL lock_timeout='3s'");
      await client.query(
        `INSERT INTO public_representation_token_reservations(
           representation_token,artifact_id,resource_kind
         ) VALUES ($1,$2,'page')`,
        [secondToken, sharedArtifact],
      );
      const artifactLoser = contender.query(
        `INSERT INTO public_representation_token_reservations(
           representation_token,artifact_id,resource_kind
         ) VALUES ($1,$2,'asset')`,
        [competingToken, sharedArtifact],
      ).then(() => undefined, (error: { code?: string }) => error.code);
      await new Promise((resolve) => setTimeout(resolve, 50));
      await client.query("COMMIT");
      expect(await artifactLoser).toBe("23505");
      await contender.query("ROLLBACK");
      expect((await client.query<{ count: string }>(
        `SELECT count(*)::text AS count
         FROM public_representation_token_reservations
         WHERE artifact_id=$1`,
        [sharedArtifact],
      )).rows[0]!.count).toBe("1");
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      await contender.query("ROLLBACK").catch(() => undefined);
      await contender.end().catch(() => undefined);
      await client.query("BEGIN");
      try {
        await client.query("SET LOCAL session_replication_role=replica");
        await client.query(
          `DELETE FROM public_representation_token_reservations
           WHERE representation_token=ANY($1::text[])`,
          [[firstToken, secondToken, competingToken]],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  }, 15_000);

  test("serializes a concurrent legacy and pathless intent UUID claim", async () => {
    const contender = new Client({ connectionString: databaseUrl });
    const intentId = randomUUID();
    await contender.connect();
    try {
      await client.query("BEGIN");
      await contender.query("BEGIN");
      await contender.query("SET LOCAL lock_timeout='3s'");
      await client.query(
        `INSERT INTO publication_intents(
           id,action,target_kind,target_id,owner_user_id,session_id,expires_at
         ) VALUES (
           $1,'unpublish','page',$2,'context-use-owner',$3,
           now()+interval '5 minutes'
         )`,
        [intentId, randomUUID(), `legacy-race-${randomUUID()}`],
      );
      const pathlessLoser = contender.query(
        `INSERT INTO pathless_publication_intents(
           id,action,target_kind,target_document_id,owner_user_id,session_id,
           expires_at,expected_visibility_generation,
           expected_visibility_state_hash,expected_target_generation
         ) VALUES (
           $1,'unpublish','asset',$2,'context-use-owner',$3,
           now()+interval '5 minutes',0,$4,0
         )`,
        [intentId, randomUUID(), `pathless-race-${randomUUID()}`, hash("a")],
      ).then(() => undefined, (error: { code?: string }) => error.code);
      await new Promise((resolve) => setTimeout(resolve, 50));
      await client.query("COMMIT");
      expect(await pathlessLoser).toBe("23505");
      await contender.query("ROLLBACK");
      expect((await client.query<{ intent_store: string }>(
        `SELECT intent_store FROM publication_intent_id_reservations
         WHERE intent_id=$1`,
        [intentId],
      )).rows[0]!.intent_store).toBe("legacy");
      expect((await client.query(
        "SELECT 1 FROM pathless_publication_intents WHERE id=$1",
        [intentId],
      )).rowCount).toBe(0);
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      await contender.query("ROLLBACK").catch(() => undefined);
      await contender.end().catch(() => undefined);
      await client.query("BEGIN");
      try {
        await client.query("SET LOCAL session_replication_role=replica");
        await client.query("DELETE FROM publication_intents WHERE id=$1", [intentId]);
        await client.query(
          "DELETE FROM publication_intent_id_reservations WHERE intent_id=$1",
          [intentId],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  }, 15_000);

  test("legacy visibility changes advance a fresh resource generation through ABA", async () => {
    await client.query("BEGIN");
    await client.query("SET CONSTRAINTS ALL DEFERRED");
    try {
      const pageId = randomUUID();
      const revisionId = randomUUID();
      const pagePath = `generation-page-${randomUUID().slice(0, 8)}`;
      await client.query(
        `INSERT INTO knowledge_pages(id,current_path,current_version_id)
         VALUES ($1,$2,$3)`,
        [pageId, pagePath, revisionId],
      );
      await client.query(
        `INSERT INTO hypermedia_document_revisions(
           id,document_id,revision_number,body_object_key,body_size_bytes,
           body_content_hash
         ) VALUES ($1,$2,1,$3,4,$4)`,
        [revisionId, pageId, `documents/private/${revisionId}.md`, hash("f")],
      );
      await client.query(
        `INSERT INTO knowledge_page_versions(
           id,page_id,version_number,path,title,summary,commit_message,
           actor_kind,actor_subject
         ) VALUES (
           $1,$2,1,$3,'Visibility generation','A generation test page.',
           'Create generation fixture','dashboard','context-use-owner'
         )`,
        [revisionId, pageId, pagePath],
      );
      await client.query(
        `UPDATE knowledge_pages
         SET published_version_id=$2,public_path=$3 WHERE id=$1`,
        [pageId, revisionId, pagePath],
      );
      const pageInitial = Number((await client.query<{ generation: string }>(
        `SELECT generation.generation::text
         FROM public_resources resource
         JOIN public_visibility_generations generation
           ON generation.public_id=resource.public_id
         WHERE resource.original_document_id=$1`,
        [pageId],
      )).rows[0]?.generation);
      expect(pageInitial).toBeGreaterThan(1);
      await client.query(
        "UPDATE knowledge_pages SET published_version_id=NULL,public_path=NULL WHERE id=$1",
        [pageId],
      );
      await client.query(
        `UPDATE knowledge_pages
         SET published_version_id=$2,public_path=$3 WHERE id=$1`,
        [pageId, revisionId, pagePath],
      );
      const pageAfterAba = Number((await client.query<{ generation: string }>(
        `SELECT generation.generation::text
         FROM public_resources resource
         JOIN public_visibility_generations generation
           ON generation.public_id=resource.public_id
         WHERE resource.original_document_id=$1`,
        [pageId],
      )).rows[0]?.generation);
      expect(pageAfterAba).toBeGreaterThanOrEqual(pageInitial + 2);
      await client.query(
        "UPDATE knowledge_pages SET published_version_id=NULL,public_path=NULL WHERE id=$1",
        [pageId],
      );
      const pageBeforeLifecycleAba = Number((await client.query<{ generation: string }>(
        `SELECT generation.generation::text
         FROM public_resources resource
         JOIN public_visibility_generations generation
           ON generation.public_id=resource.public_id
         WHERE resource.original_document_id=$1`,
        [pageId],
      )).rows[0]?.generation);
      const pageTargetBeforeLifecycleAba = Number((await client.query<{ generation: string }>(
        `SELECT generation::text FROM publication_target_generations
         WHERE target_kind='page' AND target_document_id=$1`,
        [pageId],
      )).rows[0]?.generation);
      await client.query("UPDATE knowledge_pages SET archived_at=now() WHERE id=$1", [pageId]);
      await client.query("UPDATE knowledge_pages SET archived_at=NULL WHERE id=$1", [pageId]);
      const pageAfterLifecycleAba = Number((await client.query<{ generation: string }>(
        `SELECT generation.generation::text
         FROM public_resources resource
         JOIN public_visibility_generations generation
           ON generation.public_id=resource.public_id
         WHERE resource.original_document_id=$1`,
        [pageId],
      )).rows[0]?.generation);
      expect(pageAfterLifecycleAba).toBeGreaterThanOrEqual(pageBeforeLifecycleAba + 2);
      const pageTargetAfterLifecycleAba = Number((await client.query<{ generation: string }>(
        `SELECT generation::text FROM publication_target_generations
         WHERE target_kind='page' AND target_document_id=$1`,
        [pageId],
      )).rows[0]?.generation);
      expect(pageTargetAfterLifecycleAba).toBeGreaterThanOrEqual(pageTargetBeforeLifecycleAba + 2);

      const assetId = randomUUID();
      const assetPath = `generation-asset-${randomUUID().slice(0, 8)}`;
      await client.query(
        `INSERT INTO assets(
           id,current_path,filename,content_type,size_bytes,content_hash,
           s3_object_key
         ) VALUES ($1,$2,'fixture.png','image/png',4,$3,$4)`,
        [assetId, assetPath, hash("1"), `objects/${assetId}`],
      );
      await client.query("UPDATE assets SET public_path=$2 WHERE id=$1", [assetId, assetPath]);
      const assetInitial = Number((await client.query<{ generation: string }>(
        `SELECT generation.generation::text
         FROM public_resources resource
         JOIN public_visibility_generations generation
           ON generation.public_id=resource.public_id
         WHERE resource.original_document_id=$1`,
        [assetId],
      )).rows[0]?.generation);
      expect(assetInitial).toBeGreaterThan(1);
      await client.query("UPDATE assets SET public_path=NULL WHERE id=$1", [assetId]);
      await client.query("UPDATE assets SET public_path=$2 WHERE id=$1", [assetId, assetPath]);
      const assetAfterAba = Number((await client.query<{ generation: string }>(
        `SELECT generation.generation::text
         FROM public_resources resource
         JOIN public_visibility_generations generation
           ON generation.public_id=resource.public_id
         WHERE resource.original_document_id=$1`,
        [assetId],
      )).rows[0]?.generation);
      expect(assetAfterAba).toBeGreaterThanOrEqual(assetInitial + 2);
      await client.query("UPDATE assets SET public_path=NULL WHERE id=$1", [assetId]);
      const assetBeforeLifecycleAba = Number((await client.query<{ generation: string }>(
        `SELECT generation.generation::text
         FROM public_resources resource
         JOIN public_visibility_generations generation
           ON generation.public_id=resource.public_id
         WHERE resource.original_document_id=$1`,
        [assetId],
      )).rows[0]?.generation);
      const assetTargetBeforeLifecycleAba = Number((await client.query<{ generation: string }>(
        `SELECT generation::text FROM publication_target_generations
         WHERE target_kind='asset' AND target_document_id=$1`,
        [assetId],
      )).rows[0]?.generation);
      await client.query("UPDATE assets SET deleted_at=now() WHERE id=$1", [assetId]);
      await client.query("UPDATE assets SET deleted_at=NULL WHERE id=$1", [assetId]);
      const assetAfterLifecycleAba = Number((await client.query<{ generation: string }>(
        `SELECT generation.generation::text
         FROM public_resources resource
         JOIN public_visibility_generations generation
           ON generation.public_id=resource.public_id
         WHERE resource.original_document_id=$1`,
        [assetId],
      )).rows[0]?.generation);
      expect(assetAfterLifecycleAba).toBeGreaterThanOrEqual(assetBeforeLifecycleAba + 2);
      const assetTargetAfterLifecycleAba = Number((await client.query<{ generation: string }>(
        `SELECT generation::text FROM publication_target_generations
         WHERE target_kind='asset' AND target_document_id=$1`,
        [assetId],
      )).rows[0]?.generation);
      expect(assetTargetAfterLifecycleAba).toBeGreaterThanOrEqual(assetTargetBeforeLifecycleAba + 2);
    } finally {
      await client.query("ROLLBACK");
    }
  });

  test("unassigned targets retain lifecycle and UUID-reuse generations", async () => {
    await client.query("BEGIN");
    await client.query("SET CONSTRAINTS ALL DEFERRED");
    try {
      const pageId = randomUUID();
      const revisionId = randomUUID();
      const pagePath = `unassigned-generation-page-${randomUUID().slice(0, 8)}`;
      await client.query(
        "INSERT INTO knowledge_pages(id,current_path,current_version_id) VALUES ($1,$2,$3)",
        [pageId, pagePath, revisionId],
      );
      await client.query(
        `INSERT INTO hypermedia_document_revisions(
           id,document_id,revision_number,body_object_key,body_size_bytes,
           body_content_hash
         ) VALUES ($1,$2,1,$3,4,$4)`,
        [revisionId, pageId, `documents/private/${revisionId}.md`, hash("2")],
      );
      await client.query(
        `INSERT INTO knowledge_page_versions(
           id,page_id,version_number,path,title,summary,commit_message,
           actor_kind,actor_subject
         ) VALUES (
           $1,$2,1,$3,'Unassigned generation',
           'An unassigned target generation fixture.',
           'Create unassigned fixture','dashboard','context-use-owner'
         )`,
        [revisionId, pageId, pagePath],
      );
      const pageBefore = Number((await client.query<{ generation: string }>(
        `SELECT generation::text FROM publication_target_generations
         WHERE target_kind='page' AND target_document_id=$1`,
        [pageId],
      )).rows[0]?.generation);
      await client.query("UPDATE knowledge_pages SET archived_at=now() WHERE id=$1", [pageId]);
      await client.query("UPDATE knowledge_pages SET archived_at=NULL WHERE id=$1", [pageId]);
      const pageAfter = Number((await client.query<{ generation: string }>(
        `SELECT generation::text FROM publication_target_generations
         WHERE target_kind='page' AND target_document_id=$1`,
        [pageId],
      )).rows[0]?.generation);
      expect(pageAfter).toBeGreaterThanOrEqual(pageBefore + 2);
      expect((await client.query(
        "SELECT 1 FROM public_resources WHERE original_document_id=$1",
        [pageId],
      )).rowCount).toBe(0);

      const assetId = randomUUID();
      const assetPath = `unassigned-generation-asset-${randomUUID().slice(0, 8)}`;
      const insertAsset = () => client.query(
        `INSERT INTO assets(
           id,current_path,filename,content_type,size_bytes,content_hash,
           s3_object_key
         ) VALUES ($1,$2,'fixture.png','image/png',4,$3,$4)`,
        [assetId, assetPath, hash("3"), `objects/${assetId}`],
      );
      await insertAsset();
      const assetBefore = Number((await client.query<{ generation: string }>(
        `SELECT generation::text FROM publication_target_generations
         WHERE target_kind='asset' AND target_document_id=$1`,
        [assetId],
      )).rows[0]?.generation);
      await client.query("UPDATE assets SET deleted_at=now() WHERE id=$1", [assetId]);
      await client.query("UPDATE assets SET deleted_at=NULL WHERE id=$1", [assetId]);
      const assetAfter = Number((await client.query<{ generation: string }>(
        `SELECT generation::text FROM publication_target_generations
         WHERE target_kind='asset' AND target_document_id=$1`,
        [assetId],
      )).rows[0]?.generation);
      expect(assetAfter).toBeGreaterThanOrEqual(assetBefore + 2);
      expect((await client.query(
        "SELECT 1 FROM public_resources WHERE original_document_id=$1",
        [assetId],
      )).rowCount).toBe(0);

      const beforeReuse = assetAfter;
      await client.query("DELETE FROM assets WHERE id=$1", [assetId]);
      expect((await client.query<{ reserved: boolean }>(
        "SELECT public_uuid_has_private_identity($1) AS reserved",
        [assetId],
      )).rows[0]?.reserved).toBe(true);
      expect(await sqlState(client, () => client.query(
        "SELECT assert_public_uuid_available($1,NULL,'asset')",
        [assetId],
      ))).toBe("23505");
      expect(await sqlState(client, () => client.query(
        `INSERT INTO public_artifact_id_reservations(
           artifact_id,body_object_key,allocation_kind,allocation_id
         ) VALUES ($1,$2,'pathless_adoption',$3)`,
        [assetId, `artifacts/public/${assetId}`, randomUUID()],
      ))).toBe("23505");
      expect(await sqlState(client, () => client.query(
        `INSERT INTO public_route_aliases(alias_path,route_kind,public_id)
         VALUES ($1,'asset',$2)`,
        [`/a/${assetId}`, assetId],
      ))).toBe("23505");
      await insertAsset();
      const afterReuse = Number((await client.query<{ generation: string }>(
        `SELECT generation::text FROM publication_target_generations
         WHERE target_kind='asset' AND target_document_id=$1`,
        [assetId],
      )).rows[0]?.generation);
      expect(afterReuse).toBeGreaterThanOrEqual(beforeReuse + 2);
    } finally {
      await client.query("ROLLBACK");
    }
  });

  test("foundation tables are backup-readable and not service-writable", async () => {
    const tables = [
      "public_representation_token_reservations",
      "publication_intent_id_reservations",
      "public_visibility_generations",
      "publication_target_generations",
    ];
    for (const table of tables) {
      expect((await client.query<{ allowed: boolean }>(
        "SELECT has_table_privilege('context_use_backup',$1,'SELECT') AS allowed",
        [table],
      )).rows[0]?.allowed).toBe(true);
      for (const role of [
        "context_use_auth",
        "context_use_confirmation",
        "context_use_corpus",
        "context_use_dashboard",
        "context_use_mcp",
        "context_use_public",
        "context_use_storage",
      ]) {
        expect((await client.query<{ allowed: boolean }>(
          "SELECT has_table_privilege($1,$2,'INSERT') AS allowed",
          [role, table],
        )).rows[0]?.allowed).toBe(false);
      }
    }
  });
});
