import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { unlink } from "node:fs/promises";
import { chmod } from "node:fs/promises";
import {
  DocumentAssetRepository,
  DocumentMaintenanceRepository,
  MAX_MARKDOWN_DOCUMENT_BYTES,
  PathlessStoragePublicationRepository,
  createPool,
  extractDocumentLinks,
  type PathlessPublicationObjectClaim,
  type PathlessPublicationWriteAuthorization,
} from "@context-use/database";
import type { PathlessPublicationArtifactReceipt } from "@context-use/shared";
import { Elysia } from "elysia";
import { z } from "zod";
import { config } from "./config.ts";
import {
  ObjectAlreadyExistsError,
  S3Storage,
  type ByteRange,
  type ObjectStorageBackend,
  type StoredAsset,
} from "./storage.ts";
import { disableStreamingRequestIdleTimeout } from "./streaming-timeout.ts";
import { projectPublicMarkdown } from "./public-markdown-projection.ts";
import { projectPathlessPublicMarkdown } from "./pathless-public-markdown.ts";

const objectKeySchema = z.string().regex(/^objects\/[a-f0-9-]{36}$/);
const privateDocumentKeySchema = z.string().regex(/^documents\/private\/[a-f0-9-]{36}\.md$/);
const publicDocumentKeySchema = z.string().regex(/^documents\/public\/[a-f0-9-]{36}\.md$/);
const publicAssetArtifactKeySchema = z.string().regex(/^artifacts\/public\/[a-f0-9-]{36}$/);
const generatedObjectKeySchema = z.string().regex(/^exports\/[a-f0-9-]{36}\.zip$/);
const verificationSchema = z.object({
  // Public projection artifacts are verify-only through this privileged
  // integrity endpoint. Accepting their exact key shape here does not expose
  // either the private or public read routes to the dashboard caller.
  object_key: z.union([objectKeySchema, publicDocumentKeySchema, publicAssetArtifactKeySchema]),
  size_bytes: z.number().int().nonnegative().max(5_000_000_000),
  content_hash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

function sameSecret(left: string, right: string): boolean {
  if (!left || !right) return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function bearer(request: Request): string {
  return request.headers.get("authorization")?.match(/^Bearer ([A-Za-z0-9_-]{32,256})$/)?.[1] ?? "";
}

type StorageBrokerTokens = { dashboard: string; mcp: string; public: string };

type PrivateAssetLookup = {
  getForStorage(id: string): Promise<{
    document_id: string;
    object_key: string;
    filename: string;
    content_type: string;
    size_bytes: number | string;
    content_hash: string;
  } | null>;
  getDeletedForStorage(id: string): Promise<{
    document_id: string;
    object_key: string;
  } | null>;
};

function privateCapability(
  request: Request,
  tokens: StorageBrokerTokens,
): "dashboard" | "mcp" | null {
  const supplied = bearer(request);
  if (sameSecret(supplied, tokens.dashboard)) return "dashboard";
  if (sameSecret(supplied, tokens.mcp)) return "mcp";
  return null;
}

function publicAuthorized(request: Request, tokens: StorageBrokerTokens): boolean {
  const supplied = bearer(request);
  return sameSecret(supplied, tokens.public);
}

function parseRange(value: string | null): ByteRange | undefined {
  const match = value?.match(/^bytes=(\d+)-(\d+)$/);
  if (!match) return undefined;
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start<0 || end<start) return undefined;
  return { start, end };
}

function filenameHeader(request: Request): string {
  const encoded = z.string().min(1).max(16_000).parse(request.headers.get("x-filename"));
  return z.string().min(1).max(1_024).parse(decodeURIComponent(encoded));
}

const defaultStorage: ObjectStorageBackend = new S3Storage(undefined, {
  region: config.AWS_REGION,
  bucket: config.ASSET_BUCKET,
  kmsKeyId: config.KMS_KEY_ID || null,
});

const storagePool = createPool(config.STORAGE_DATABASE_URL, { application_name: "context-use-storage-boundary" });
const defaultPrivateAssets = new DocumentAssetRepository(storagePool);
const defaultPathlessPublications = new PathlessStoragePublicationRepository(storagePool);
const documentMaintenance = new DocumentMaintenanceRepository(storagePool);
const defaultTokens: StorageBrokerTokens = {
  dashboard: config.STORAGE_DASHBOARD_TOKEN,
  mcp: config.STORAGE_MCP_TOKEN,
  public: config.STORAGE_PUBLIC_TOKEN,
};

function denied(): Response {
  return new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });
}

async function readObject(
  storage: ObjectStorageBackend,
  objectKey: string,
  range: ByteRange | undefined,
): Promise<Response> {
  try {
    const body = await storage.read(objectKey, range);
    return new Response(body, { status: range ? 206 : 200, headers: { "cache-control": "no-store" } });
  } catch {
    return denied();
  }
}

async function generatedObjectResponse(
  request: Request,
  storage: ObjectStorageBackend,
  objectKey: string,
): Promise<Response> {
  const metadata = await storage.inspectGenerated(objectKey);
  if (!metadata) return denied();
  const range = parseRange(request.headers.get("range"));
  if (request.headers.has("range") && !range) return denied();
  if (range && (range.start >= metadata.sizeBytes || range.end >= metadata.sizeBytes)) return denied();
  const body = request.method === "HEAD" ? null : await storage.read(objectKey, range);
  const contentLength = range ? range.end - range.start + 1 : metadata.sizeBytes;
  return new Response(body, {
    status: range ? 206 : 200,
    headers: {
      "accept-ranges": "bytes",
      "cache-control": "no-store",
      "content-length": String(contentLength),
      "content-type": "application/zip",
      "x-content-sha256": metadata.contentHash,
      ...(range ? { "content-range": `bytes ${range.start}-${range.end}/${metadata.sizeBytes}` } : {}),
    },
  });
}

type PathlessPublicationClaims = Pick<PathlessStoragePublicationRepository,
  "claimIntent" | "finalizeIntent">
  & Partial<Pick<PathlessStoragePublicationRepository, "resolve">>;

function exactNumber(value: number | string, maximum: number): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0 || result > maximum) {
    throw new Error("Publication artifact size is not safely representable");
  }
  return result;
}

async function verifiedSourceBody(
  storage: ObjectStorageBackend,
  authorization: PathlessPublicationWriteAuthorization,
): Promise<BodyInit> {
  const size = exactNumber(authorization.source_body_size_bytes, 5_000_000_000);
  if (!await storage.verify(
    authorization.source_body_object_key,
    size,
    authorization.source_body_content_hash,
  )) throw new Error("Publication source bytes are unavailable or corrupt");
  return storage.read(authorization.source_body_object_key);
}

function sameUuidSet(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

async function writeClaimedArtifact(input: {
  storage: ObjectStorageBackend;
  claim: PathlessPublicationObjectClaim<PathlessPublicationWriteAuthorization>;
}): Promise<{
  claimToken: string;
  receipt: PathlessPublicationArtifactReceipt | null;
}> {
  const { storage, claim } = input;
  if (claim.finalized) {
    const size = exactNumber(claim.body_size_bytes, 5_000_000_000);
    if (!await storage.verify(claim.body_object_key, size, claim.body_content_hash)) {
      throw new Error("Finalized publication artifact is unavailable or corrupt");
    }
    return { claimToken: claim.claim_token, receipt: null };
  }

  const authorization = claim.authorization;
  const page = authorization.target_kind === "page";
  const project = page;
  let body: ReadableStream<Uint8Array> | null;
  let sizeBytes: number;
  let contentHash: string;
  let observedPublicIds: string[];
  if (project) {
    const source = await new Response(await verifiedSourceBody(storage, authorization)).text();
    const projected = projectPathlessPublicMarkdown(source, authorization.target_projection);
    observedPublicIds = projected.observedPublicIds;
    if (!sameUuidSet(observedPublicIds, authorization.projected_target_public_ids)) {
      throw new Error("Public projection did not observe the exact frozen UUID set");
    }
    const bytes = Buffer.from(projected.bodyMarkdown, "utf8");
    sizeBytes = bytes.byteLength;
    contentHash = createHash("sha256").update(bytes).digest("hex");
    body = new Blob([bytes]).stream();
  } else {
    sizeBytes = exactNumber(authorization.source_body_size_bytes, 5_000_000_000);
    contentHash = authorization.source_body_content_hash;
    observedPublicIds = authorization.projected_target_public_ids;
    const source = await verifiedSourceBody(storage, authorization);
    body = new Response(source).body;
  }
  const maximum = exactNumber(authorization.max_body_size_bytes, 5_000_000_000);
  if (sizeBytes > maximum) throw new Error("Publication artifact exceeds its frozen size limit");
  const stored: StoredAsset = {
    id: authorization.artifact_id,
    objectKey: authorization.body_object_key,
    filename: page
      ? `${authorization.artifact_id}.md`
      : authorization.public_filename!,
    contentType: page
      ? "text/markdown; charset=utf-8"
      : authorization.public_content_type!,
    sizeBytes,
    contentHash,
  };
  try {
    await storage.writeOnce(stored, body);
  } catch (error) {
    if (!(error instanceof ObjectAlreadyExistsError)) throw error;
  }
  if (!await storage.verify(stored.objectKey, sizeBytes, contentHash)) {
    throw new Error("Conditional publication artifact write did not retain the exact bytes");
  }

  const target = authorization;
  const receipt: PathlessPublicationArtifactReceipt = target.target_kind === "page"
      ? {
        intent_id: target.intent_id,
        target_kind: "page",
        body_size_bytes: sizeBytes,
        body_content_hash: contentHash,
        public_title: target.public_title,
        public_summary: target.public_summary,
        public_last_edited_at: target.public_last_edited_at,
        projected_target_public_ids: target.projected_target_public_ids,
        observed_public_uuid_tokens: observedPublicIds,
        projection_receipt_hash: target.projection_receipt_hash,
      }
      : {
        intent_id: target.intent_id,
        target_kind: "asset",
        body_size_bytes: sizeBytes,
        body_content_hash: contentHash,
        public_filename: target.public_filename,
        public_content_type: target.public_content_type,
        ...(target.public_width === null ? {} : { public_width: target.public_width }),
        ...(target.public_height === null ? {} : { public_height: target.public_height }),
        ...(target.public_duration_seconds === null
          ? {}
          : { public_duration_seconds: target.public_duration_seconds }),
      };
  return { claimToken: claim.claim_token, receipt };
}

export async function materializePathlessPublicationArtifact(input: {
  storage: ObjectStorageBackend;
  claims: PathlessPublicationClaims;
  allocationId: string;
}): Promise<void> {
  const claim = await input.claims.claimIntent(input.allocationId);
  const written = await writeClaimedArtifact({
    storage: input.storage,
    claim,
  });
  if (!written.receipt) return;
  await input.claims.finalizeIntent(written.claimToken, written.receipt);
}

export function createStorageBrokerApp(input: {
  storage: ObjectStorageBackend;
  privateAssets: PrivateAssetLookup;
  /** Ignored source-compatibility input for in-flight test/application callers. */
  publicAssets?: unknown;
  pathlessPublications?: PathlessPublicationClaims;
  tokens: StorageBrokerTokens;
}) {
  const { storage, privateAssets, pathlessPublications, tokens } = input;
  const activeWrites = new Set<string>();
  return new Elysia({ serve: { maxRequestBodySize: 5_500_000_000 } })
  .onError(() => denied())
  .get("/health", () => ({ status: "ok" }))
  .put("/private/object", async ({ request }) => {
    if (!privateCapability(request, tokens)) return denied();
    const sizeBytes = Number(request.headers.get("content-length"));
    const asset = {
      id: z.string().uuid().parse(request.headers.get("x-asset-id")),
      objectKey: objectKeySchema.parse(request.headers.get("x-object-key")),
      filename: filenameHeader(request),
      contentType: z.string().min(1).max(255).parse(request.headers.get("x-content-type")),
      sizeBytes: z.number().int().nonnegative().max(5_000_000_000).parse(sizeBytes),
      contentHash: z.string().regex(/^[a-f0-9]{64}$/).parse(request.headers.get("x-content-sha256")),
    };
    if (asset.objectKey !== `objects/${asset.id}`) return denied();
    const expected = await privateAssets.getForStorage(asset.id);
    if (!expected
        || expected.object_key !== asset.objectKey
        || expected.filename !== asset.filename
        || expected.content_type !== asset.contentType
        || Number(expected.size_bytes) !== asset.sizeBytes
        || expected.content_hash !== asset.contentHash) return denied();
    if (activeWrites.has(asset.objectKey)) return denied();
    activeWrites.add(asset.objectKey);
    try {
      // Asset bytes are immutable. This blocks a compromised MCP process from
      // replacing a private or published object whose key it can read.
      if (await storage.exists(asset.objectKey)) return denied();
      await storage.write(asset, request.body);
      return new Response(null, { status: 204 });
    } finally {
      activeWrites.delete(asset.objectKey);
    }
  }, { parse: "none" })
  .put("/private/document", async ({ request }) => {
    if (!privateCapability(request, tokens)) return denied();
    const revisionId = z.string().uuid().parse(request.headers.get("x-document-revision-id"));
    const objectKey = privateDocumentKeySchema.parse(request.headers.get("x-object-key"));
    const sizeBytes = z.number().int().nonnegative().max(MAX_MARKDOWN_DOCUMENT_BYTES)
      .parse(Number(request.headers.get("content-length")));
    const contentHash = z.string().regex(/^[a-f0-9]{64}$/)
      .parse(request.headers.get("x-content-sha256"));
    if (objectKey !== `documents/private/${revisionId}.md`) return denied();
    if (activeWrites.has(objectKey)) return denied();
    const document = {
      id: revisionId,
      objectKey,
      filename: `${revisionId}.md`,
      contentType: "text/markdown; charset=utf-8",
      sizeBytes,
      contentHash,
    };
    if (await storage.exists(objectKey)) {
      return await storage.verify(objectKey, sizeBytes, contentHash)
        ? new Response(null, { status: 204 })
        : denied();
    }
    activeWrites.add(objectKey);
    try {
      await storage.write(document, request.body);
      return new Response(null, { status: 204 });
    } finally {
      activeWrites.delete(objectKey);
    }
  }, { parse: "none" })
  .get("/private/object", async ({ request, query }) => {
    if (!privateCapability(request, tokens)) return denied();
    return readObject(storage, objectKeySchema.parse(query.key), parseRange(request.headers.get("range")));
  })
  .get("/private/document", async ({ request, query }) => {
    if (!privateCapability(request, tokens)) return denied();
    return readObject(
      storage,
      privateDocumentKeySchema.parse(query.key),
      parseRange(request.headers.get("range")),
    );
  })
  .put("/private/export", async ({ request, query }) => {
    if (privateCapability(request, tokens) !== "dashboard") return denied();
    const objectKey = generatedObjectKeySchema.parse(query.key);
    const existing = await storage.inspectGenerated(objectKey);
    if (existing) {
      return Response.json({
        size_bytes: existing.sizeBytes,
        content_hash: existing.contentHash,
      }, { headers: { "cache-control": "no-store" } });
    }
    if (activeWrites.has(objectKey)) {
      return new Response("Export already exists", { status: 409, headers: { "cache-control": "no-store" } });
    }
    activeWrites.add(objectKey);
    try {
      const metadata = await storage.writeGenerated(objectKey, request.body);
      return Response.json({
        size_bytes: metadata.sizeBytes,
        content_hash: metadata.contentHash,
      }, { status: 201, headers: { "cache-control": "no-store" } });
    } finally {
      activeWrites.delete(objectKey);
    }
  }, { parse: "none" })
  .put("/private/publication-artifact", async ({ request, query }) => {
    if (privateCapability(request, tokens) !== "dashboard" || !pathlessPublications) {
      return denied();
    }
    const allocationId = z.string().uuid().parse(query.id);
    await materializePathlessPublicationArtifact({
      storage,
      claims: pathlessPublications,
      allocationId,
    });
    return new Response(null, { status: 204 });
  }, { parse: "none" })
  .head("/private/export", async ({ request, query }) => {
    if (privateCapability(request, tokens) !== "dashboard") return denied();
    return generatedObjectResponse(request, storage, generatedObjectKeySchema.parse(query.key));
  })
  .get("/private/export", async ({ request, query }) => {
    if (privateCapability(request, tokens) !== "dashboard") return denied();
    return generatedObjectResponse(request, storage, generatedObjectKeySchema.parse(query.key));
  })
  .delete("/private/export", async ({ request, query }) => {
    if (privateCapability(request, tokens) !== "dashboard") return denied();
    await storage.deleteGenerated(generatedObjectKeySchema.parse(query.key));
    return new Response(null, { status: 204 });
  })
  .delete("/private/object", async ({ request, query }) => {
    if (privateCapability(request, tokens) !== "dashboard") return denied();
    const objectKey = objectKeySchema.parse(query.key);
    const id = z.string().uuid().parse(objectKey.slice("objects/".length));
    const deleted = await privateAssets.getDeletedForStorage(id);
    // Metadata is the lifecycle authority. A published row cannot become
    // deleted until passkey-confirmed unpublication clears its visibility, so
    // a bare dashboard storage capability cannot hide public bytes.
    if (!deleted || deleted.object_key !== objectKey) return denied();
    await storage.delete(objectKey);
    return new Response(null, { status: 204 });
  })
  .post("/private/verify", async ({ request }) => {
    if (privateCapability(request, tokens) !== "dashboard") return denied();
    const input = verificationSchema.parse(await request.json());
    return Response.json({
      verified: await storage.verify(input.object_key, input.size_bytes, input.content_hash),
    }, { headers: { "cache-control": "no-store" } });
  })
  .head("/public/representation", async ({ request, query }) => {
    if (!publicAuthorized(request, tokens) || !pathlessPublications?.resolve) return denied();
    const { token: representationToken } = z.object({
      token: z.string().regex(/^[a-f0-9]{64}$/),
    }).strict().parse(query);
    const route = await pathlessPublications.resolve(representationToken);
    if (!route || route.representation_token !== representationToken) return denied();
    const sizeBytes = exactNumber(route.body_size_bytes, 5_000_000_000);
    const objectKey = route.resource_kind === "page"
      ? publicDocumentKeySchema.parse(route.body_object_key)
      : publicAssetArtifactKeySchema.parse(route.body_object_key);
    if (!await storage.verify(objectKey, sizeBytes, route.body_content_hash)) return denied();
    return new Response(null, {
      headers: {
        "cache-control": "no-store",
        "content-length": String(sizeBytes),
        "x-content-sha256": route.body_content_hash,
      },
    });
  })
  .get("/public/representation", async ({ request, query }) => {
    if (!publicAuthorized(request, tokens) || !pathlessPublications?.resolve) return denied();
    const { token: representationToken } = z.object({
      token: z.string().regex(/^[a-f0-9]{64}$/),
    }).strict().parse(query);
    const route = await pathlessPublications.resolve(representationToken);
    if (!route || route.representation_token !== representationToken) return denied();
    const sizeBytes = exactNumber(route.body_size_bytes, 5_000_000_000);
    const objectKey = route.resource_kind === "page"
      ? publicDocumentKeySchema.parse(route.body_object_key)
      : publicAssetArtifactKeySchema.parse(route.body_object_key);
    if (!await storage.verify(objectKey, sizeBytes, route.body_content_hash)) return denied();
    const range = parseRange(request.headers.get("range"));
    if (request.headers.has("range") && !range) return denied();
    if (range && (range.start >= sizeBytes || range.end >= sizeBytes)) return denied();
    return readObject(storage, objectKey, range);
  });
}

export const storageApp = createStorageBrokerApp({
  storage: defaultStorage,
  privateAssets: defaultPrivateAssets,
  pathlessPublications: defaultPathlessPublications,
  tokens: defaultTokens,
});

let maintenanceRunning = false;

export async function reconcileDocumentObjects(input: {
  storage: ObjectStorageBackend;
  maintenance: Pick<DocumentMaintenanceRepository,
    "projectionSnapshot" | "recordPublishedArtifact">;
}): Promise<void> {
  const { storage, maintenance } = input;
  const snapshot = await maintenance.projectionSnapshot();
  for (const page of snapshot.pages) {
    if (!await storage.verify(
      page.body_object_key,
      Number(page.body_size_bytes),
      page.body_content_hash,
    )) throw new Error(`Published revision ${page.version_id} is unavailable`);
    const privateMarkdown = await new Response(await storage.read(page.body_object_key)).text();
    const publicMarkdown = projectPublicMarkdown(privateMarkdown, page.source_path, snapshot);
    const bytes = Buffer.from(publicMarkdown, "utf8");
    const artifactId = randomUUID();
    const objectKey = `documents/public/${artifactId}.md`;
    const contentHash = createHash("sha256").update(bytes).digest("hex");
    await storage.write({
      id: artifactId,
      objectKey,
      filename: `${artifactId}.md`,
      contentType: "text/markdown; charset=utf-8",
      sizeBytes: bytes.byteLength,
      contentHash,
    }, new Blob([bytes]).stream());
    await maintenance.recordPublishedArtifact({
      pageId: page.page_id,
      versionId: page.version_id,
      generation: snapshot.generation,
      artifactId,
      objectKey,
      sizeBytes: bytes.byteLength,
      contentHash,
    });
  }
}

export async function reconcileDocumentLinks(input: {
  storage: ObjectStorageBackend;
  maintenance: Pick<DocumentMaintenanceRepository,
    "unindexedLinkRevisions" | "replaceRevisionLinks" | "deferRevisionLinks">;
}): Promise<{
  indexed: number;
  failures: Array<{ revisionId: string; error: unknown }>;
}> {
  const { storage, maintenance } = input;
  // One bounded batch keeps storage startup and the recurring maintenance tick
  // responsive even when a large historical corpus still needs indexing. The
  // filesystem cutover has its own completion gate; this additive release does
  // not pretend an unfinished backfill is complete.
  const revisions = await maintenance.unindexedLinkRevisions();
  let indexed = 0;
  const failures: Array<{ revisionId: string; error: unknown }> = [];
  const maxConcurrency = 8;
  const maxInFlightBytes = 16 * 1024 * 1024;
  for (let offset = 0; offset < revisions.length;) {
    const batch: typeof revisions = [];
    let batchBytes = 0;
    while (offset < revisions.length && batch.length < maxConcurrency) {
      const revision = revisions[offset]!;
      const declaredBytes = Number.isSafeInteger(revision.body_size_bytes)
          && revision.body_size_bytes >= 0
        ? revision.body_size_bytes
        : maxInFlightBytes + 1;
      if (batch.length > 0 && batchBytes + declaredBytes > maxInFlightBytes) break;
      batch.push(revision);
      batchBytes += declaredBytes;
      offset += 1;
      // One large raw record is allowed to exceed the byte budget only when it
      // owns the batch. Never overlap it with another body in memory.
      if (declaredBytes > maxInFlightBytes) break;
    }
    await Promise.all(batch.map(async (revision) => {
      try {
        if (!await storage.verify(
          revision.body_object_key,
          Number(revision.body_size_bytes),
          revision.body_content_hash,
        )) throw new Error("Stored revision bytes are unavailable or corrupt");
        const markdown = await new Response(await storage.read(revision.body_object_key)).text();
        await maintenance.replaceRevisionLinks(
          revision.revision_id,
          extractDocumentLinks(markdown),
        );
        indexed += 1;
      } catch (error) {
        await maintenance.deferRevisionLinks(revision.revision_id);
        failures.push({ revisionId: revision.revision_id, error });
      }
    }));
  }
  return { indexed, failures };
}

export async function maintainDocumentObjects(): Promise<void> {
  if (maintenanceRunning) return;
  maintenanceRunning = true;
  try {
    const linkResult = await reconcileDocumentLinks({
      storage: defaultStorage,
      maintenance: documentMaintenance,
    });
    for (const failure of linkResult.failures) {
      console.error("document_link_index_failed", {
        revisionId: failure.revisionId,
        ...(failure.error instanceof Error
          ? { name: failure.error.name, message: failure.error.message }
          : { type: typeof failure.error }),
      });
    }
    await reconcileDocumentObjects({
      storage: defaultStorage,
      maintenance: documentMaintenance,
    });
  } finally {
    maintenanceRunning = false;
  }
}

export async function listenStorageSocket(): Promise<void> {
  const socketPath = config.STORAGE_SOCKET_PATH;
  await unlink(socketPath).catch(() => undefined);
  Bun.serve({
    unix: socketPath,
    maxRequestBodySize: 5_500_000_000,
    fetch(request, server) {
      if (["GET", "PUT"].includes(request.method)
          && ["/private/object", "/private/document", "/private/export", "/private/publication-artifact"].includes(new URL(request.url).pathname)) {
        disableStreamingRequestIdleTimeout(server, request);
      }
      return storageApp.handle(request);
    },
  });
  await chmod(socketPath, 0o660);
  console.info("context-use storage broker listening on unix socket");
  void maintainDocumentObjects().catch((error: unknown) => {
    console.error("document_object_maintenance_failed", error instanceof Error
      ? { name: error.name, message: error.message }
      : { type: typeof error });
  });
  setInterval(() => {
    void maintainDocumentObjects().catch((error: unknown) => {
      console.error("document_object_maintenance_failed", error instanceof Error
        ? { name: error.name, message: error.message }
        : { type: typeof error });
    });
  }, 1_000).unref();
}
