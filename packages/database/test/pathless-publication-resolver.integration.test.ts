import { describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { Client } from "pg";
import { disposableDatabaseUrl } from "../src/disposable-database.ts";

const databaseUrl = await disposableDatabaseUrl();
const describeDatabase = databaseUrl ? describe : describe.skip;
const hash = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

type PageFixture = {
  pageId: string;
  revisionId: string;
  publicId: string;
  artifactId: string;
  representationToken: string;
  origin: "legacy_adoption" | "directory_hub_promotion";
};

type AssetFixture = {
  assetId: string;
  publicId: string;
  artifactId: string;
  representationToken: string;
};

type PublicRouteRow = {
  state: "unassigned" | "inactive" | "active";
  route_kind: "page" | "directory" | "markdown" | "asset";
  canonical_path: string | null;
  public_id: string | null;
  representation_token: string | null;
  public_title: string | null;
  public_summary: string | null;
  public_last_edited_at: string | null;
  public_filename: string | null;
  public_content_type: string | null;
  public_width: number | null;
  public_height: number | null;
  public_duration_seconds: string | null;
};

async function asRole<T>(
  client: Client,
  role: string,
  action: () => Promise<T>,
): Promise<T> {
  await client.query("SAVEPOINT role_call");
  await client.query(`SET ROLE ${role}`);
  try {
    const result = await action();
    await client.query("RESET ROLE");
    await client.query("RELEASE SAVEPOINT role_call");
    return result;
  } catch (error) {
    await client.query("ROLLBACK TO SAVEPOINT role_call");
    await client.query("RESET ROLE");
    await client.query("RELEASE SAVEPOINT role_call");
    throw error;
  }
}

async function sqlStateAsRole(
  client: Client,
  role: string,
  action: () => Promise<unknown>,
): Promise<string | undefined> {
  await client.query("SAVEPOINT expected_failure");
  await client.query(`SET ROLE ${role}`);
  try {
    await action();
    await client.query("RESET ROLE");
    await client.query("RELEASE SAVEPOINT expected_failure");
    return undefined;
  } catch (error) {
    await client.query("ROLLBACK TO SAVEPOINT expected_failure");
    await client.query("RESET ROLE");
    await client.query("RELEASE SAVEPOINT expected_failure");
    return (error as { code?: string }).code;
  }
}

async function beginTestTransaction(client: Client): Promise<void> {
  await client.query("BEGIN");
  await client.query("SET LOCAL statement_timeout='10s'");
}

async function resolvePublic(client: Client, route: string): Promise<PublicRouteRow> {
  return await asRole(client, "context_use_public", async () =>
    (await client.query<PublicRouteRow>(
      "SELECT * FROM resolve_pathless_public_route($1)",
      [route],
    )).rows[0]!,
  );
}

function expectRedacted(row: PublicRouteRow): void {
  expect(row.canonical_path).toBeNull();
  expect(row.public_id).toBeNull();
  expect(row.representation_token).toBeNull();
  expect(row.public_title).toBeNull();
  expect(row.public_summary).toBeNull();
  expect(row.public_last_edited_at).toBeNull();
  expect(row.public_filename).toBeNull();
  expect(row.public_content_type).toBeNull();
  expect(row.public_width).toBeNull();
  expect(row.public_height).toBeNull();
  expect(row.public_duration_seconds).toBeNull();
}

async function seedActivePage(
  client: Client,
  origin: PageFixture["origin"] = "legacy_adoption",
): Promise<PageFixture> {
  const pageId = randomUUID();
  const revisionId = randomUUID();
  const publicId = randomUUID();
  const artifactId = randomUUID();
  const adoptionId = randomUUID();
  const legacyArtifactId = randomUUID();
  const representationToken = hash(`page-token:${artifactId}`);
  const contentHash = hash(`page-body:${artifactId}`);
  const objectKey = `documents/public/${artifactId}.md`;

  await client.query("SET LOCAL session_replication_role=replica");
  await client.query(
    `INSERT INTO knowledge_pages(id,current_version_id)
     VALUES ($1,$2)`,
    [pageId, revisionId],
  );
  await client.query(
    `INSERT INTO knowledge_page_versions(
       id,page_id,version_number,title,summary,
       commit_message,actor_kind,actor_subject
     ) VALUES ($1,$2,1,'Resolver page','A safe resolver fixture.',
       'Create resolver fixture','dashboard','context-use-owner')`,
    [revisionId, pageId],
  );
  await client.query(
    `INSERT INTO public_resources(
       public_id,document_id,original_document_id,resource_kind
     ) VALUES ($1,$2,$2,'page')`,
    [publicId, pageId],
  );
  await client.query(
    `INSERT INTO public_visibility_generations(public_id,generation)
     VALUES ($1,1)`,
    [publicId],
  );
  await client.query(
    `INSERT INTO publication_target_generations(
       target_kind,target_document_id,generation
     ) VALUES ('page',$1,1)`,
    [pageId],
  );
  await client.query(
    `INSERT INTO public_artifact_id_reservations(
       artifact_id,body_object_key,allocation_kind,allocation_id
     ) VALUES ($1,$2,'pathless_adoption',$3)`,
    [artifactId, objectKey, adoptionId],
  );
  await client.query(
    `INSERT INTO public_representation_token_reservations(
       representation_token,artifact_id,resource_kind
     ) VALUES ($1,$2,'page')`,
    [representationToken, artifactId],
  );
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
       $1,$2,$3,$4,23,$5,$6,29,$7,'Resolver page',
       'A safe resolver fixture.','2026-08-23 03:04:05.654321+00',$8,$9,
       $10,$11,$12,$13,$14,'pathless_adoption',$10
     )`,
    [
      artifactId,
      publicId,
      pageId,
      revisionId,
      contentHash,
      objectKey,
      hash(`public:${artifactId}`),
      hash(`receipt:${artifactId}`),
      origin,
      adoptionId,
      origin === "legacy_adoption" ? "legacy_page" : "directory_hub",
      origin === "legacy_adoption" ? legacyArtifactId : null,
      origin === "legacy_adoption" ? "1" : null,
      representationToken,
    ],
  );
  await client.query(
    "INSERT INTO page_publications(public_id,artifact_id) VALUES ($1,$2)",
    [publicId, artifactId],
  );
  await client.query("SET LOCAL session_replication_role=origin");
  return { pageId, revisionId, publicId, artifactId, representationToken, origin };
}

async function addAssetArtifact(
  client: Client,
  assetId: string,
  publicId: string,
  pin: boolean,
): Promise<Pick<AssetFixture, "artifactId" | "representationToken">> {
  const artifactId = randomUUID();
  const adoptionId = randomUUID();
  const representationToken = hash(`asset-token:${artifactId}`);
  const objectKey = `artifacts/public/${artifactId}`;
  await client.query("SET LOCAL session_replication_role=replica");
  await client.query(
    `INSERT INTO public_artifact_id_reservations(
       artifact_id,body_object_key,allocation_kind,allocation_id
     ) VALUES ($1,$2,'pathless_adoption',$3)`,
    [artifactId, objectKey, adoptionId],
  );
  await client.query(
    `INSERT INTO public_representation_token_reservations(
       representation_token,artifact_id,resource_kind
     ) VALUES ($1,$2,'asset')`,
    [representationToken, artifactId],
  );
  await client.query(
    `INSERT INTO public_asset_artifacts(
       artifact_id,public_id,source_document_id,body_object_key,
       body_size_bytes,body_content_hash,public_filename,public_content_type,
       public_width,public_height,public_duration_seconds,origin,
       source_adoption_id,source_adoption_kind,representation_token,
       reservation_allocation_kind,reservation_allocation_id
     ) VALUES (
       $1,$2,$3,$4,31,$5,'resolver.png','image/png',11,13,1.2300,
       'legacy_adoption',$6,'legacy_asset',$7,'pathless_adoption',$6
     )`,
    [
      artifactId,
      publicId,
      assetId,
      objectKey,
      hash(`asset-body:${artifactId}`),
      adoptionId,
      representationToken,
    ],
  );
  if (pin) {
    await client.query(
      "INSERT INTO asset_publications(public_id,artifact_id) VALUES ($1,$2)",
      [publicId, artifactId],
    );
  }
  await client.query("SET LOCAL session_replication_role=origin");
  return { artifactId, representationToken };
}

async function seedActiveAsset(client: Client): Promise<AssetFixture> {
  const assetId = randomUUID();
  const publicId = randomUUID();
  await client.query("SET LOCAL session_replication_role=replica");
  await client.query(
    `INSERT INTO assets(
       id,filename,content_type,size_bytes,content_hash,s3_object_key
     ) VALUES ($1,'resolver.png','image/png',31,$2,$3)`,
    [assetId, hash(`source:${assetId}`), `objects/${assetId}`],
  );
  await client.query(
    `INSERT INTO public_resources(
       public_id,document_id,original_document_id,resource_kind
     ) VALUES ($1,$2,$2,'asset')`,
    [publicId, assetId],
  );
  await client.query(
    `INSERT INTO public_visibility_generations(public_id,generation)
     VALUES ($1,1)`,
    [publicId],
  );
  await client.query(
    `INSERT INTO publication_target_generations(
       target_kind,target_document_id,generation
     ) VALUES ('asset',$1,1)`,
    [assetId],
  );
  await client.query("SET LOCAL session_replication_role=origin");
  const artifact = await addAssetArtifact(client, assetId, publicId, true);
  return { assetId, publicId, ...artifact };
}

async function cleanupPageFixtures(
  client: Client,
  pages: PageFixture[],
): Promise<void> {
  const publicIds = pages.map((page) => page.publicId);
  const artifactIds = pages.map((page) => page.artifactId);
  const pageIds = pages.map((page) => page.pageId);
  const revisionIds = pages.map((page) => page.revisionId);
  await beginTestTransaction(client);
  try {
    await client.query("SET LOCAL session_replication_role=replica");
    await client.query(
      `UPDATE pathless_publication_settings
       SET entrypoint_public_id=NULL,updated_at=NULL WHERE singleton`,
    );
    await client.query(
      `UPDATE public_knowledge_settings
       SET entrypoint_page_id=NULL,updated_at=clock_timestamp()
       WHERE singleton`,
    );
    await client.query("DELETE FROM page_publications WHERE public_id=ANY($1::uuid[])", [publicIds]);
    await client.query("DELETE FROM public_page_artifacts WHERE artifact_id=ANY($1::uuid[])", [artifactIds]);
    await client.query(
      "DELETE FROM public_representation_token_reservations WHERE artifact_id=ANY($1::uuid[])",
      [artifactIds],
    );
    await client.query("DELETE FROM public_artifact_id_reservations WHERE artifact_id=ANY($1::uuid[])", [artifactIds]);
    await client.query("DELETE FROM public_visibility_generations WHERE public_id=ANY($1::uuid[])", [publicIds]);
    await client.query("DELETE FROM public_resources WHERE public_id=ANY($1::uuid[])", [publicIds]);
    await client.query(
      `DELETE FROM publication_target_generations
       WHERE target_kind='page' AND target_document_id=ANY($1::uuid[])`,
      [pageIds],
    );
    await client.query("DELETE FROM knowledge_page_versions WHERE id=ANY($1::uuid[])", [revisionIds]);
    await client.query("DELETE FROM knowledge_pages WHERE id=ANY($1::uuid[])", [pageIds]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

describeDatabase("pathless public entrypoint and resolvers", () => {
  test("resolves exact active routes without exposing private namespace misses", async () => {
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    await beginTestTransaction(client);
    try {
      const page = await seedActivePage(client);
      const asset = await seedActiveAsset(client);
      const pageAlias = `/p/legacy-${randomUUID().slice(0, 8)}`;
      const directoryAlias = `/p/legacy-${randomUUID().slice(0, 8)}/`;
      const markdownAlias = `/p/legacy-${randomUUID().slice(0, 8)}.md`;
      const assetAlias = `/a/legacy-${randomUUID().slice(0, 8)}`;
      await client.query(
        `INSERT INTO public_route_aliases(alias_path,route_kind,public_id)
         VALUES ($1,'page',$5),($2,'directory',$5),($3,'markdown',$5),
           ($4,'asset',$6),($7,'page',$5)`,
        [
          pageAlias,
          directoryAlias,
          markdownAlias,
          assetAlias,
          page.publicId,
          asset.publicId,
          `/p/${page.publicId}`,
        ],
      );

      const canonicalPage = await resolvePublic(client, `/p/${page.publicId}`);
      expect(canonicalPage).toMatchObject({
        state: "active",
        route_kind: "page",
        canonical_path: `/p/${page.publicId}`,
        public_id: page.publicId,
        representation_token: page.representationToken,
        public_title: "Resolver page",
      });
      const markdownPage = await resolvePublic(client, `/p/${page.publicId}.md`);
      expect(markdownPage).toMatchObject({
        state: "active",
        route_kind: "markdown",
        canonical_path: `/p/${page.publicId}.md`,
        public_id: page.publicId,
      });
      expect(await resolvePublic(client, pageAlias)).toMatchObject({
        state: "active",
        route_kind: "page",
        canonical_path: `/p/${page.publicId}`,
        public_id: page.publicId,
      });
      expect(await resolvePublic(client, directoryAlias)).toMatchObject({
        state: "active",
        route_kind: "directory",
        canonical_path: `/p/${page.publicId}`,
        public_id: page.publicId,
      });
      expect(await resolvePublic(client, markdownAlias)).toMatchObject({
        state: "active",
        route_kind: "markdown",
        canonical_path: `/p/${page.publicId}.md`,
        public_id: page.publicId,
      });
      expect(await resolvePublic(client, assetAlias)).toMatchObject({
        state: "active",
        route_kind: "asset",
        canonical_path: `/a/${asset.publicId}`,
        public_id: asset.publicId,
      });
      expect(await resolvePublic(client, `/a/${asset.publicId}`)).toMatchObject({
        state: "active",
        route_kind: "asset",
        canonical_path: `/a/${asset.publicId}`,
        public_id: asset.publicId,
        representation_token: asset.representationToken,
        public_duration_seconds: "1.2300",
      });
      expect(await asRole(client, "context_use_dashboard", async () =>
        (await client.query(
          "SELECT * FROM get_pathless_dashboard_publication_status('page',$1)",
          [page.pageId],
        )).rows[0],
      )).toEqual({
        public_id: page.publicId,
        published_revision_id: page.revisionId,
        published_revision_number: 1,
        active: true,
      });
      expect(await asRole(client, "context_use_dashboard", async () =>
        (await client.query(
          "SELECT * FROM get_pathless_dashboard_publication_status('asset',$1)",
          [asset.assetId],
        )).rows[0],
      )).toEqual({
        public_id: asset.publicId,
        published_revision_id: null,
        published_revision_number: null,
        active: true,
      });
      expect(await asRole(client, "context_use_dashboard", async () =>
        (await client.query(
          "SELECT * FROM get_pathless_dashboard_publication_status('page',$1)",
          [randomUUID()],
        )).rows[0],
      )).toEqual({
        public_id: null,
        published_revision_id: null,
        published_revision_number: null,
        active: false,
      });
      expect(await asRole(client, "context_use_public", async () =>
        (await client.query<{ public_id: string }>(
          `SELECT public_id FROM pathless_public_pages
           WHERE public_id=$1`,
          [page.publicId],
        )).rows[0]!.public_id,
      )).toBe(page.publicId);
      expect(await asRole(client, "context_use_public", async () =>
        (await client.query<{ public_id: string }>(
          `SELECT public_id FROM pathless_public_assets
           WHERE public_id=$1`,
          [asset.publicId],
        )).rows[0]!.public_id,
      )).toBe(asset.publicId);
      expect(await sqlStateAsRole(
        client,
        "context_use_public",
        () => client.query("SELECT * FROM public_page_artifacts LIMIT 1"),
      )).toBe("42501");
      expect(await sqlStateAsRole(
        client,
        "context_use_public",
        () => client.query("SELECT * FROM public_resources LIMIT 1"),
      )).toBe("42501");
      for (const role of ["context_use_public", "context_use_backup"]) {
        for (const helper of [
          "canonical_legacy_alias_uuid(text)",
          "canonical_legacy_alias_kind(text)",
        ]) {
          expect((await client.query<{ allowed: boolean }>(
            "SELECT has_function_privilege($1,$2,'EXECUTE') AS allowed",
            [role, helper],
          )).rows[0]!.allowed).toBe(true);
        }
        for (const helper of [
          "public_uuid_has_private_identity(uuid)",
          "public_uuid_has_artifact_identity(uuid)",
          "public_uuid_has_reserved_public_identity(uuid)",
        ]) {
          expect((await client.query<{ allowed: boolean }>(
            "SELECT has_function_privilege($1,$2,'EXECUTE') AS allowed",
            [role, helper],
          )).rows[0]!.allowed).toBe(false);
        }
      }

      await client.query("SET LOCAL session_replication_role=replica");
      await client.query(
        "UPDATE public_route_aliases SET public_id=$2 WHERE alias_path=$1",
        [`/p/${page.publicId}`, asset.publicId],
      );
      await client.query("SET LOCAL session_replication_role=origin");
      const ambiguousCanonical = await resolvePublic(client, `/p/${page.publicId}`);
      expect(ambiguousCanonical.state).toBe("inactive");
      expectRedacted(ambiguousCanonical);
      await client.query("SET LOCAL session_replication_role=replica");
      await client.query(
        "UPDATE public_route_aliases SET public_id=$2 WHERE alias_path=$1",
        [`/p/${page.publicId}`, page.publicId],
      );
      await client.query("SET LOCAL session_replication_role=origin");

      await client.query("SET LOCAL session_replication_role=replica");
      await client.query(
        "UPDATE public_resources SET document_id=NULL WHERE public_id=$1",
        [page.publicId],
      );
      await client.query("SET LOCAL session_replication_role=origin");
      const detachedPage = await resolvePublic(client, `/p/${page.publicId}`);
      expect(detachedPage.state).toBe("inactive");
      expectRedacted(detachedPage);
      await client.query("SET LOCAL session_replication_role=replica");
      await client.query(
        "UPDATE public_resources SET document_id=$2 WHERE public_id=$1",
        [page.publicId, page.pageId],
      );
      await client.query("SET LOCAL session_replication_role=origin");

      const privateMiss = await resolvePublic(client, `/p/${page.pageId}`);
      expect(privateMiss.state).toBe("unassigned");
      expectRedacted(privateMiss);
      const artifactMiss = await resolvePublic(client, `/p/${page.artifactId}`);
      expect(artifactMiss.state).toBe("unassigned");
      expectRedacted(artifactMiss);
      const wrongKind = await resolvePublic(client, `/a/${page.publicId}`);
      expect(wrongKind.state).toBe("inactive");
      expectRedacted(wrongKind);

      const conflictOnlyAlias = `/p/conflict-${randomUUID().slice(0, 8)}`;
      await client.query(
        `INSERT INTO public_namespace_conflicts(
           conflict_key,namespace_uuid,conflict_kind,alias_path,
           conflicting_identity_kind,conflict_lifecycle
         ) VALUES ($1,$2,'alias_token_private_id',$3,'document','permanent')`,
        [`resolver:${randomUUID()}`, page.pageId, conflictOnlyAlias],
      );
      const conflictMiss = await resolvePublic(client, conflictOnlyAlias);
      expect(conflictMiss.state).toBe("unassigned");
      expectRedacted(conflictMiss);

      const conflictOnlyPublicId = randomUUID();
      await client.query(
        `INSERT INTO public_namespace_conflicts(
           conflict_key,namespace_uuid,conflict_kind,public_id,
           conflicting_identity_kind,conflict_lifecycle
         ) VALUES ($1,$2,'public_id_private_id',$2,'document','permanent')`,
        [`resolver-direct:${randomUUID()}`, conflictOnlyPublicId],
      );
      const directConflictMiss = await resolvePublic(client, `/p/${conflictOnlyPublicId}`);
      expect(directConflictMiss.state).toBe("unassigned");
      expectRedacted(directConflictMiss);

      for (const invalidRoute of [
        "/p",
        "/a/",
        "/p/About",
        "/p/a//",
        "/p/a/.md",
        "/p/about?preview=true",
        `/p/${page.publicId.toUpperCase()}`,
      ]) {
        expect(await sqlStateAsRole(
          client,
          "context_use_public",
          () => client.query("SELECT * FROM resolve_pathless_public_route($1)", [invalidRoute]),
        )).toBe("22023");
      }

      await client.query("DELETE FROM asset_publications WHERE public_id=$1", [asset.publicId]);
      const inactiveAlias = await resolvePublic(client, assetAlias);
      expect(inactiveAlias.state).toBe("inactive");
      expectRedacted(inactiveAlias);
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      await client.end().catch(() => undefined);
    }
  }, 15_000);

  test("storage resolves only the exact current pin and keeps raw tables closed", async () => {
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    await beginTestTransaction(client);
    try {
      const asset = await seedActiveAsset(client);
      const replacement = await addAssetArtifact(client, asset.assetId, asset.publicId, false);
      const active = await asRole(client, "context_use_storage", async () =>
        (await client.query<{
          resource_kind: string;
          representation_token: string;
          body_object_key: string;
          body_size_bytes: string;
          body_content_hash: string;
        }>("SELECT * FROM resolve_pathless_storage_route($1)", [asset.representationToken])).rows,
      );
      expect(active).toEqual([{
        resource_kind: "asset",
        representation_token: asset.representationToken,
        body_object_key: `artifacts/public/${asset.artifactId}`,
        body_size_bytes: "31",
        body_content_hash: hash(`asset-body:${asset.artifactId}`),
      }]);
      expect(await asRole(client, "context_use_storage", async () =>
        (await client.query(
          "SELECT * FROM resolve_pathless_storage_route($1)",
          [hash(`unknown:${randomUUID()}`)],
        )).rows,
      )).toEqual([]);

      await client.query("DELETE FROM asset_publications WHERE public_id=$1", [asset.publicId]);
      expect(await asRole(client, "context_use_storage", async () =>
        (await client.query(
          "SELECT * FROM resolve_pathless_storage_route($1)",
          [asset.representationToken],
        )).rows,
      )).toEqual([]);
      await client.query(
        "INSERT INTO asset_publications(public_id,artifact_id) VALUES ($1,$2)",
        [asset.publicId, replacement.artifactId],
      );
      expect(await asRole(client, "context_use_storage", async () =>
        (await client.query<{ representation_token: string }>(
          "SELECT * FROM resolve_pathless_storage_route($1)",
          [replacement.representationToken],
        )).rows[0]!.representation_token,
      )).toBe(replacement.representationToken);
      expect(await resolvePublic(client, `/a/${asset.publicId}`)).toMatchObject({
        state: "active",
        representation_token: replacement.representationToken,
      });

      await client.query(
        `INSERT INTO public_namespace_conflicts(
           conflict_key,namespace_uuid,conflict_kind,public_id,
           conflicting_identity_kind,conflict_lifecycle
         ) VALUES ($1,$2,'public_id_private_id',$2,'document','permanent')`,
        [`resolver-storage:${randomUUID()}`, asset.publicId],
      );
      expect(await asRole(client, "context_use_storage", async () =>
        (await client.query(
          "SELECT * FROM resolve_pathless_storage_route($1)",
          [replacement.representationToken],
        )).rows,
      )).toEqual([]);

      await client.query(
        "DELETE FROM public_namespace_conflicts WHERE public_id=$1",
        [asset.publicId],
      );
      await client.query("SET LOCAL session_replication_role=replica");
      await client.query(
        "UPDATE public_resources SET document_id=NULL WHERE public_id=$1",
        [asset.publicId],
      );
      await client.query("SET LOCAL session_replication_role=origin");
      expect(await asRole(client, "context_use_storage", async () =>
        (await client.query(
          "SELECT * FROM resolve_pathless_storage_route($1)",
          [replacement.representationToken],
        )).rows,
      )).toEqual([]);

      expect(await sqlStateAsRole(
        client,
        "context_use_storage",
        () => client.query("SELECT * FROM public_asset_artifacts LIMIT 1"),
      )).toBe("42501");
      expect(await sqlStateAsRole(
        client,
        "context_use_public",
        () => client.query(
          "SELECT * FROM resolve_pathless_storage_route($1)",
          [replacement.representationToken],
        ),
      )).toBe("42501");
      expect(await sqlStateAsRole(
        client,
        "context_use_public",
        () => client.query("SELECT * FROM public_representation_token_reservations LIMIT 1"),
      )).toBe("42501");
      expect(await sqlStateAsRole(
        client,
        "context_use_storage",
        () => client.query(
          "SELECT * FROM resolve_pathless_storage_route($1)",
          [replacement.representationToken.toUpperCase()],
        ),
      )).toBe("22023");
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      await client.end().catch(() => undefined);
    }
  }, 15_000);

  test("seeds and sets the three-state entrypoint with exact replay semantics", async () => {
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    await beginTestTransaction(client);
    try {
      const ordinary = await seedActivePage(client, "legacy_adoption");
      const hub = await seedActivePage(client, "directory_hub_promotion");
      await client.query(
        `UPDATE pathless_publication_settings
         SET entrypoint_public_id=NULL,updated_at=NULL WHERE singleton`,
      );
      await client.query(
        `UPDATE public_knowledge_settings
         SET entrypoint_page_id=NULL,updated_at=clock_timestamp()
         WHERE singleton`,
      );
      await client.query("SET LOCAL session_replication_role=replica");
      await client.query("DELETE FROM public_route_aliases WHERE alias_path='/p/'");
      await client.query(
        `INSERT INTO public_route_aliases(alias_path,route_kind,public_id)
         VALUES ('/p/','directory',$1)`,
        [ordinary.publicId],
      );
      await client.query("SET LOCAL session_replication_role=origin");

      const unseededRoot = await resolvePublic(client, "/p/");
      expect(unseededRoot.state).toBe("unassigned");
      expectRedacted(unseededRoot);

      const selectedOrdinary = await asRole(client, "context_use_dashboard", async () =>
        (await client.query<{
          public_id: string | null;
          configured: boolean;
          active: boolean;
        }>("SELECT * FROM set_pathless_publication_entrypoint($1)", [ordinary.publicId])).rows[0]!,
      );
      expect(selectedOrdinary).toEqual({
        public_id: ordinary.publicId,
        configured: true,
        active: true,
      });
      const mirrored = (await client.query<{
        entrypoint_page_id: string | null;
        updated_at: Date;
      }>(
        `SELECT entrypoint_page_id,updated_at
         FROM public_knowledge_settings WHERE singleton`,
      )).rows[0]!;
      expect(mirrored.entrypoint_page_id).toBe(ordinary.pageId);

      await client.query("DELETE FROM page_publications WHERE public_id=$1", [ordinary.publicId]);
      const replayedOrdinary = await asRole(client, "context_use_dashboard", async () =>
        (await client.query<{
          public_id: string | null;
          configured: boolean;
          active: boolean;
        }>("SELECT * FROM set_pathless_publication_entrypoint($1)", [ordinary.publicId])).rows[0]!,
      );
      expect(replayedOrdinary).toEqual({
        public_id: ordinary.publicId,
        configured: true,
        active: false,
      });
      const legacyAfterReplay = (await client.query<{
        entrypoint_page_id: string | null;
        updated_at: Date;
      }>(
        `SELECT entrypoint_page_id,updated_at
         FROM public_knowledge_settings WHERE singleton`,
      )).rows[0]!;
      expect(legacyAfterReplay.entrypoint_page_id).toBe(ordinary.pageId);
      expect(legacyAfterReplay.updated_at.toISOString()).toBe(mirrored.updated_at.toISOString());

      await client.query(
        `UPDATE pathless_publication_settings
         SET entrypoint_public_id=NULL,updated_at=NULL WHERE singleton`,
      );
      const seededInactive = await asRole(client, "context_use_corpus", async () =>
        (await client.query<{
          public_id: string | null;
          configured: boolean;
          active: boolean;
        }>("SELECT * FROM seed_pathless_publication_entrypoint()" )).rows[0]!,
      );
      expect(seededInactive).toEqual({
        public_id: ordinary.publicId,
        configured: true,
        active: false,
      });

      const selectedHub = await asRole(client, "context_use_dashboard", async () =>
        (await client.query<{
          public_id: string | null;
          configured: boolean;
          active: boolean;
        }>("SELECT * FROM set_pathless_publication_entrypoint($1)", [hub.publicId])).rows[0]!,
      );
      expect(selectedHub).toEqual({
        public_id: hub.publicId,
        configured: true,
        active: true,
      });
      expect((await client.query<{ entrypoint_page_id: string | null }>(
        "SELECT entrypoint_page_id FROM public_knowledge_settings WHERE singleton",
      )).rows[0]!.entrypoint_page_id).toBeNull();
      expect(await resolvePublic(client, "/p/")).toMatchObject({
        state: "active",
        route_kind: "directory",
        public_id: hub.publicId,
        representation_token: hub.representationToken,
      });

      await client.query("DELETE FROM page_publications WHERE public_id=$1", [hub.publicId]);
      await client.query(
        "INSERT INTO page_publications(public_id,artifact_id) VALUES ($1,$2)",
        [ordinary.publicId, ordinary.artifactId],
      );
      await client.query(
        `UPDATE public_knowledge_settings
         SET entrypoint_page_id=$1,updated_at=clock_timestamp()
         WHERE singleton`,
        [ordinary.pageId],
      );
      const inactiveRoot = await resolvePublic(client, "/p/");
      expect(inactiveRoot.state).toBe("inactive");
      expectRedacted(inactiveRoot);

      const selectedNull = await asRole(client, "context_use_dashboard", async () =>
        (await client.query<{
          public_id: string | null;
          configured: boolean;
          active: boolean;
        }>("SELECT * FROM set_pathless_publication_entrypoint(NULL)")).rows[0]!,
      );
      expect(selectedNull).toEqual({ public_id: null, configured: true, active: false });
      expect((await client.query<{ entrypoint_page_id: string | null }>(
        "SELECT entrypoint_page_id FROM public_knowledge_settings WHERE singleton",
      )).rows[0]!.entrypoint_page_id).toBeNull();
      const explicitNullRoot = await resolvePublic(client, "/p/");
      expect(explicitNullRoot.state).toBe("inactive");
      expectRedacted(explicitNullRoot);

      const barePageId = randomUUID();
      await client.query("SET LOCAL session_replication_role=replica");
      await client.query(
        `INSERT INTO knowledge_pages(id,current_version_id)
         VALUES ($1,$2)`,
        [barePageId, randomUUID()],
      );
      await client.query("SET LOCAL session_replication_role=origin");
      await client.query(
        `UPDATE pathless_publication_settings
         SET entrypoint_public_id=NULL,updated_at=NULL WHERE singleton`,
      );
      await client.query(
        `UPDATE public_knowledge_settings
         SET entrypoint_page_id=$1,updated_at=clock_timestamp()
         WHERE singleton`,
        [barePageId],
      );
      expect(await sqlStateAsRole(
        client,
        "context_use_corpus",
        () => client.query("SELECT * FROM seed_pathless_publication_entrypoint()"),
      )).toBe("23514");
      expect((await client.query<{ updated_at: Date | null }>(
        "SELECT updated_at FROM pathless_publication_settings WHERE singleton",
      )).rows[0]!.updated_at).toBeNull();

      await client.query(
        `UPDATE public_knowledge_settings
         SET entrypoint_page_id=NULL,updated_at=clock_timestamp()
         WHERE singleton`,
      );
      const seededNull = await asRole(client, "context_use_corpus", async () =>
        (await client.query<{
          public_id: string | null;
          configured: boolean;
          active: boolean;
        }>("SELECT * FROM seed_pathless_publication_entrypoint()" )).rows[0]!,
      );
      expect(seededNull).toEqual({ public_id: null, configured: true, active: false });
      const seededAt = (await client.query<{ updated_at: Date }>(
        "SELECT updated_at FROM pathless_publication_settings WHERE singleton",
      )).rows[0]!.updated_at;
      expect(await asRole(client, "context_use_corpus", async () =>
        (await client.query("SELECT * FROM seed_pathless_publication_entrypoint()")).rows[0],
      )).toEqual(seededNull);
      expect((await client.query<{ updated_at: Date }>(
        "SELECT updated_at FROM pathless_publication_settings WHERE singleton",
      )).rows[0]!.updated_at.toISOString()).toBe(seededAt.toISOString());
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      await client.end().catch(() => undefined);
    }
  }, 15_000);

  test("orders entrypoint target locks before settings and rejects a raced replay", async () => {
    const client = new Client({ connectionString: databaseUrl });
    const contender = new Client({ connectionString: databaseUrl });
    const pages: PageFixture[] = [];
    let clientConnected = false;
    let contenderConnected = false;
    try {
      await client.connect();
      clientConnected = true;
      await contender.connect();
      contenderConnected = true;
      await beginTestTransaction(client);
      pages.push(await seedActivePage(client), await seedActivePage(client));
      await client.query(
        `UPDATE pathless_publication_settings
         SET entrypoint_public_id=NULL,updated_at=now() WHERE singleton`,
      );
      await client.query(
        `UPDATE public_knowledge_settings
         SET entrypoint_page_id=NULL,updated_at=clock_timestamp()
         WHERE singleton`,
      );
      await client.query("COMMIT");

      await contender.query("SET statement_timeout='4s'");
      await contender.query("SET ROLE context_use_dashboard");
      await beginTestTransaction(client);
      await client.query("SET LOCAL lock_timeout='750ms'");
      await client.query("SELECT 1 FROM knowledge_pages WHERE id=$1 FOR UPDATE", [pages[0]!.pageId]);
      const setting = contender.query<{
        public_id: string;
        configured: boolean;
        active: boolean;
      }>("SELECT * FROM set_pathless_publication_entrypoint($1)", [pages[0]!.publicId]);
      await new Promise((resolve) => setTimeout(resolve, 75));
      await client.query("SELECT 1 FROM public_knowledge_settings WHERE singleton FOR UPDATE");
      await client.query("SELECT 1 FROM pathless_publication_settings WHERE singleton FOR UPDATE");
      await client.query("ROLLBACK");
      expect((await setting).rows[0]).toEqual({
        public_id: pages[0]!.publicId,
        configured: true,
        active: true,
      });
      await contender.query("RESET ROLE");

      await beginTestTransaction(client);
      await client.query(
        `UPDATE pathless_publication_settings
         SET entrypoint_public_id=NULL,updated_at=NULL WHERE singleton`,
      );
      await client.query(
        `UPDATE public_knowledge_settings
         SET entrypoint_page_id=$1,updated_at=clock_timestamp()
         WHERE singleton`,
        [pages[0]!.pageId],
      );
      await client.query("COMMIT");
      await contender.query("SET ROLE context_use_corpus");
      await beginTestTransaction(client);
      await client.query("SET LOCAL lock_timeout='750ms'");
      await client.query("SELECT 1 FROM knowledge_pages WHERE id=$1 FOR UPDATE", [pages[0]!.pageId]);
      const seeding = contender.query<{
        public_id: string;
        configured: boolean;
        active: boolean;
      }>("SELECT * FROM seed_pathless_publication_entrypoint()");
      await new Promise((resolve) => setTimeout(resolve, 75));
      await client.query("SELECT 1 FROM public_knowledge_settings WHERE singleton FOR UPDATE");
      await client.query("SELECT 1 FROM pathless_publication_settings WHERE singleton FOR UPDATE");
      await client.query("ROLLBACK");
      expect((await seeding).rows[0]).toEqual({
        public_id: pages[0]!.publicId,
        configured: true,
        active: true,
      });
      await contender.query("RESET ROLE");

      await beginTestTransaction(client);
      await client.query("SELECT 1 FROM pathless_publication_settings WHERE singleton FOR UPDATE");
      await client.query(
        `UPDATE pathless_publication_settings
         SET entrypoint_public_id=$1,updated_at=clock_timestamp()
         WHERE singleton`,
        [pages[1]!.publicId],
      );
      await contender.query("SET ROLE context_use_dashboard");
      const replay = contender.query(
        "SELECT * FROM set_pathless_publication_entrypoint($1)",
        [pages[0]!.publicId],
      ).then(() => undefined, (error: { code?: string }) => error.code);
      await new Promise((resolve) => setTimeout(resolve, 75));
      await client.query("COMMIT");
      expect(await replay).toBe("40001");
      await contender.query("RESET ROLE");
    } finally {
      if (clientConnected) await client.query("ROLLBACK").catch(() => undefined);
      if (contenderConnected) {
        await contender.query("RESET ROLE").catch(() => undefined);
        await contender.end().catch(() => undefined);
      }
      try {
        if (clientConnected && pages.length > 0) await cleanupPageFixtures(client, pages);
      } finally {
        if (clientConnected) await client.end().catch(() => undefined);
      }
    }
  }, 15_000);
});
