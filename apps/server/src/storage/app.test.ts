import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_MARKDOWN_BLOB_BYTES } from "@context-use/database";
import { createPrivateStorageBroker } from "#storage/client/storage-broker-client.ts";
import {
  BlobAlreadyExistsError,
  type BlobStorageBackend,
  type ByteRange,
  type StoredBlob,
} from "#storage/object-storage.ts";
import { createStorageBrokerApp } from "./app.ts";

const tokens = {
  private: "private-application-token-that-is-long",
  public: "public-token-that-is-long-and-private",
};
const publishedKey = "objects/11111111-1111-4111-8111-111111111111";
const privateKey = "blobs/22222222-2222-4222-8222-222222222222";
const newKey = "blobs/33333333-3333-4333-8333-333333333333";
const publicDocumentKey = "documents/public/55555555-5555-4555-8555-555555555555.md";
const publicArtifactKey = "artifacts/public/88888888-8888-4888-8888-888888888888";

function privateAssets(
  rows: Record<string, { filename: string; contentType: string; bytes: string | Uint8Array }>,
  deletedIds: string[] = [],
) {
  const deleted = new Set(deletedIds);
  return {
    getForStorage: async (id: string) => {
      const row = rows[id];
      if (!row) {
        return null;
      }
      const bytes = Buffer.from(row.bytes);
      return {
        object_id: id,
        blob_key: `blobs/${id}`,
        filename: row.filename,
        content_type: row.contentType,
        size_bytes: bytes.byteLength,
        content_hash: createHash("sha256").update(bytes).digest("hex"),
      };
    },
    getDeletedForStorage: async (id: string) =>
      deleted.has(id) ? { object_id: id, blob_key: `blobs/${id}` } : null,
  };
}

class MemoryStorage implements BlobStorageBackend {
  readonly objects = new Map<string, Uint8Array>([
    [publishedKey, Buffer.from("published")],
    [privateKey, Buffer.from("private")],
  ]);
  readonly pendingImmutableWrites = new Map<string, Promise<void>>();
  immutableCreates = 0;

  async write(asset: StoredBlob, body: ReadableStream<Uint8Array> | null): Promise<void> {
    this.objects.set(asset.blobKey, new Uint8Array(await new Response(body).arrayBuffer()));
  }

  async writeOnce(asset: StoredBlob, body: ReadableStream<Uint8Array> | null): Promise<void> {
    const pending = this.pendingImmutableWrites.get(asset.blobKey);
    if (pending) {
      await pending;
      throw new BlobAlreadyExistsError();
    }
    if (this.objects.has(asset.blobKey)) {
      throw new BlobAlreadyExistsError();
    }
    let release!: () => void;
    const write = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.pendingImmutableWrites.set(asset.blobKey, write);
    try {
      this.objects.set(asset.blobKey, new Uint8Array(await new Response(body).arrayBuffer()));
      this.immutableCreates += 1;
    } finally {
      this.pendingImmutableWrites.delete(asset.blobKey);
      release();
    }
  }

  async delete(blobKey: string): Promise<void> {
    this.objects.delete(blobKey);
  }

  async exists(blobKey: string): Promise<boolean> {
    return this.objects.has(blobKey);
  }

  async read(blobKey: string, range?: ByteRange): Promise<BodyInit> {
    const bytes = this.objects.get(blobKey);
    if (!bytes) {
      throw new Error("missing");
    }
    const selected = range ? bytes.slice(range.start, range.end + 1) : bytes;
    return new Blob([Buffer.from(selected)]);
  }

  async verify(blobKey: string, sizeBytes: number, contentHash: string): Promise<boolean> {
    const bytes = this.objects.get(blobKey);
    return Boolean(
      bytes &&
        bytes.byteLength === sizeBytes &&
        createHash("sha256").update(bytes!).digest("hex") === contentHash,
    );
  }
}

function authorized(token: string, path: string, init: RequestInit = {}): Request {
  return new Request(`http://storage${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
}

describe("storage broker capabilities", () => {
  test("claims, conditionally writes, verifies and finalizes a canonical page artifact", async () => {
    const storage = new MemoryStorage();
    const intentId = "60606060-6060-4060-8060-606060606060";
    const revisionId = "62626262-6262-4262-8262-626262626262";
    const artifactId = "63636363-6363-4363-8363-636363636363";
    const publicId = "64646464-6464-4464-8464-646464646464";
    const targetId = "65656565-6565-4565-8565-656565656565";
    const linkedPublicId = "66666666-6666-4666-8666-666666666666";
    const sourceKey = `documents/private/${revisionId}.md`;
    const destinationKey = `documents/public/${artifactId}.md`;
    const source = Buffer.from(`See [the linked page](context-use://object/${targetId}).`);
    storage.objects.set(sourceKey, source);
    let finalized: { token: string; receipt: unknown } | null = null;
    const claims = {
      claimIntent: async () => ({
        claim_token: "67676767-6767-4767-8767-676767676767",
        finalized: false as const,
        artifact_id: artifactId,
        body_object_key: destinationKey,
        authorization: {
          intent_id: intentId,
          target_kind: "page" as const,
          candidate_public_id: publicId,
          artifact_id: artifactId,
          source_body_object_key: sourceKey,
          source_body_size_bytes: source.byteLength,
          source_body_content_hash: createHash("sha256").update(source).digest("hex"),
          body_object_key: destinationKey,
          max_body_size_bytes: 4_000_000,
          public_title: "Public page",
          public_summary: "A public canonical page.",
          public_last_edited_at: "2026-08-23T12:34:56.123456Z",
          public_filename: null,
          public_content_type: null,
          public_width: null,
          public_height: null,
          public_duration_seconds: null,
          projected_target_public_ids: [linkedPublicId],
          projection_receipt_hash: "a".repeat(64),
          target_projection: [
            {
              target_object_id: targetId,
              outcome: "active_public" as const,
              public_id: linkedPublicId,
              public_target_kind: "page" as const,
            },
          ],
        },
      }),
      finalizeIntent: async ({
        claimToken: token,
        receipt,
      }: {
        claimToken: string;
        receipt: unknown;
      }) => {
        finalized = { token, receipt };
      },
    };
    const app = createStorageBrokerApp({
      storage,
      privateAssets: privateAssets({}),
      publications: claims,
      tokens,
    });

    const response = await app.handle(
      authorized(tokens.private, `/private/publication-artifact?id=${intentId}`, { method: "PUT" }),
    );

    expect(response.status).toBe(204);
    expect(Buffer.from(storage.objects.get(destinationKey)!).toString()).toBe(
      `See [the linked page](/p/${linkedPublicId}).`,
    );
    expect(finalized).toMatchObject({
      token: "67676767-6767-4767-8767-676767676767",
      receipt: {
        intent_id: intentId,
        target_kind: "page",
        projected_target_public_ids: [linkedPublicId],
        observed_public_uuid_tokens: [linkedPublicId],
      },
    });
    expect(
      (
        await app.handle(
          authorized(tokens.public, `/private/publication-artifact?id=${intentId}`, {
            method: "PUT",
          }),
        )
      ).status,
    ).toBe(404);
  });

  test("serializes independent brokers onto one immutable artifact", async () => {
    const storage = new MemoryStorage();
    const intentId = "70707070-7070-4070-8070-707070707070";
    const assetId = "71717171-7171-4171-8171-717171717171";
    const artifactId = "72727272-7272-4272-8272-727272727272";
    const sourceKey = `objects/${assetId}`;
    const destinationKey = `objects/${artifactId}`;
    const source = Buffer.from("same immutable asset");
    storage.objects.set(sourceKey, source);
    const finalizations: unknown[] = [];
    const claims = {
      claimIntent: async () => ({
        claim_token: "73737373-7373-4373-8373-737373737373",
        finalized: false as const,
        artifact_id: artifactId,
        body_object_key: destinationKey,
        authorization: {
          intent_id: intentId,
          target_kind: "asset" as const,
          candidate_public_id: "74747474-7474-4474-8474-747474747474",
          artifact_id: artifactId,
          source_body_object_key: sourceKey,
          source_body_size_bytes: source.byteLength,
          source_body_content_hash: createHash("sha256").update(source).digest("hex"),
          body_object_key: destinationKey,
          max_body_size_bytes: 5_000_000_000,
          public_title: null,
          public_summary: null,
          public_last_edited_at: null,
          public_filename: "asset.bin",
          public_content_type: "application/octet-stream",
          public_width: null,
          public_height: null,
          public_duration_seconds: null,
          projected_target_public_ids: [] as [],
          projection_receipt_hash: null,
          target_projection: [] as [],
        },
      }),
      finalizeIntent: async ({ receipt }: { receipt: unknown }) => {
        finalizations.push(receipt);
      },
    };
    const left = createStorageBrokerApp({
      storage,
      privateAssets: privateAssets({}),
      publications: claims,
      tokens,
    });
    const right = createStorageBrokerApp({
      storage,
      privateAssets: privateAssets({}),
      publications: claims,
      tokens,
    });
    const request = () =>
      authorized(tokens.private, `/private/publication-artifact?id=${intentId}`, { method: "PUT" });

    const [first, second] = await Promise.all([left.handle(request()), right.handle(request())]);

    expect([first.status, second.status]).toEqual([204, 204]);
    expect(storage.immutableCreates).toBe(1);
    expect(storage.objects.get(destinationKey)).toEqual(source);
    expect(finalizations).toHaveLength(2);
  });

  test("public objects are readable only by representation token", async () => {
    const storage = new MemoryStorage();
    const app = createStorageBrokerApp({
      storage,
      privateAssets: privateAssets({}),
      tokens,
    });

    const published = await app.handle(
      authorized(tokens.public, "/public/object?path=public%2Fasset"),
    );
    expect(published.status).toBe(404);
    expect(
      (await app.handle(authorized(tokens.public, "/public/object?path=private%2Fasset"))).status,
    ).toBe(404);
    expect(
      (await app.handle(authorized(tokens.public, `/public/object?key=${publishedKey}`))).status,
    ).toBe(404);
    expect(
      (await app.handle(authorized(tokens.public, `/private/blob?key=${privateKey}`))).status,
    ).toBe(404);
  });

  test("public capability dereferences only an active exact representation token", async () => {
    const storage = new MemoryStorage();
    const token = "a".repeat(64);
    const staleToken = "b".repeat(64);
    storage.objects.set(publicArtifactKey, Buffer.from("published"));
    const contentHash = createHash("sha256").update("published").digest("hex");
    const claims = {
      claimIntent: async () => {
        throw new Error("unexpected claim");
      },
      finalizeIntent: async () => {
        throw new Error("unexpected finalize");
      },
      resolve: async (candidate: string) =>
        candidate === token
          ? {
              resource_kind: "asset" as const,
              representation_token: token,
              body_object_key: publicArtifactKey,
              body_size_bytes: 9,
              body_content_hash: contentHash,
            }
          : null,
    };
    const app = createStorageBrokerApp({
      storage,
      privateAssets: privateAssets({}),
      publications: claims,
      tokens,
    });

    const published = await app.handle(
      authorized(tokens.public, `/public/representation?token=${token}`),
    );
    expect(published.status).toBe(200);
    expect(await published.text()).toBe("published");
    const inspected = await app.handle(
      authorized(tokens.public, `/public/representation?token=${token}`, { method: "HEAD" }),
    );
    expect(inspected.status).toBe(200);
    expect(inspected.headers.get("content-length")).toBe("9");
    expect(inspected.headers.get("x-content-sha256")).toBe(contentHash);
    expect(await inspected.text()).toBe("");
    const partial = await app.handle(
      authorized(tokens.public, `/public/representation?token=${token}`, {
        headers: { range: "bytes=1-3" },
      }),
    );
    expect(partial.status).toBe(206);
    expect(await partial.text()).toBe("ubl");
    expect(
      (await app.handle(authorized(tokens.public, `/public/representation?token=${staleToken}`)))
        .status,
    ).toBe(404);
    expect(
      (await app.handle(authorized(tokens.private, `/public/representation?token=${token}`)))
        .status,
    ).toBe(404);
    expect(
      (await app.handle(authorized(tokens.private, `/public/representation?token=${token}`)))
        .status,
    ).toBe(404);
    expect(
      (
        await app.handle(
          authorized(tokens.public, `/public/representation?token=${token}&key=${publishedKey}`),
        )
      ).status,
    ).toBe(404);
    expect(
      await (
        await app.handle(authorized(tokens.public, `/public/representation?token=${token}`))
      ).text(),
    ).not.toContain(publishedKey);
  });

  test("knowledge revisions are immutable and legacy public document reads are absent", async () => {
    const storage = new MemoryStorage();
    const revisionId = "66666666-6666-4666-8666-666666666666";
    const privateObjectKey = `blobs/${revisionId}`;
    const legacyPrivateBlobKey = `documents/private/${revisionId}.md`;
    const artifactId = "77777777-7777-4777-8777-777777777777";
    const publicDocumentKey = `documents/public/${artifactId}.md`;
    const publicProjection = Buffer.from("public projection");
    storage.objects.set(publicDocumentKey, publicProjection);
    const app = createStorageBrokerApp({
      storage,
      privateAssets: privateAssets({}),
      tokens,
    });
    const markdown = Buffer.from("# Private knowledge\n");
    const headers = {
      "content-length": String(markdown.byteLength),
      "x-page-revision-id": revisionId,
      "x-blob-key": privateObjectKey,
      "x-content-sha256": createHash("sha256").update(markdown).digest("hex"),
    };

    expect(
      (
        await app.handle(
          authorized(tokens.private, "/private/markdown-blob", {
            method: "PUT",
            headers,
            body: markdown,
          }),
        )
      ).status,
    ).toBe(204);
    expect(
      await (
        await app.handle(
          authorized(
            tokens.private,
            `/private/markdown-blob?key=${encodeURIComponent(privateObjectKey)}`,
          ),
        )
      ).text(),
    ).toBe(markdown.toString());
    storage.objects.set(legacyPrivateBlobKey, markdown);
    expect(
      await (
        await app.handle(
          authorized(
            tokens.private,
            `/private/markdown-blob?key=${encodeURIComponent(legacyPrivateBlobKey)}`,
          ),
        )
      ).text(),
    ).toBe(markdown.toString());
    expect(
      (
        await app.handle(
          authorized(
            tokens.public,
            `/private/markdown-blob?key=${encodeURIComponent(privateObjectKey)}`,
          ),
        )
      ).status,
    ).toBe(404);

    const published = await app.handle(
      authorized(tokens.public, "/public/page?path=public%2Fpage"),
    );
    expect(published.status).toBe(404);
    storage.objects.set(publicDocumentKey, Buffer.from("corrupt projection"));
    expect(
      (await app.handle(authorized(tokens.public, "/public/page?path=public%2Fpage"))).status,
    ).toBe(404);
    expect(
      (await app.handle(authorized(tokens.public, "/public/page?path=private%2Fpage"))).status,
    ).toBe(404);
    expect(
      (
        await app.handle(
          authorized(tokens.public, `/public/page?key=${encodeURIComponent(publicDocumentKey)}`),
        )
      ).status,
    ).toBe(404);
  });

  test("stores raw Markdown records above the authored-page ceiling with a bounded document limit", async () => {
    const storage = new MemoryStorage();
    const revisionId = "67676767-6767-4676-8676-676767676767";
    const blobKey = `blobs/${revisionId}`;
    const markdown = Buffer.alloc(4_000_001, "r");
    expect(markdown.byteLength).toBeLessThan(MAX_MARKDOWN_BLOB_BYTES);
    const app = createStorageBrokerApp({
      storage,
      privateAssets: privateAssets({}),
      tokens,
    });

    const response = await app.handle(
      authorized(tokens.private, "/private/markdown-blob", {
        method: "PUT",
        headers: {
          "content-length": String(markdown.byteLength),
          "x-page-revision-id": revisionId,
          "x-blob-key": blobKey,
          "x-content-sha256": createHash("sha256").update(markdown).digest("hex"),
        },
        body: markdown,
      }),
    );

    expect(response.status).toBe(204);
    expect(storage.objects.get(blobKey)?.byteLength).toBe(markdown.byteLength);
  });

  test("brokered document reads preserve a leading UTF-8 BOM", async () => {
    const storage = new MemoryStorage();
    const revisionId = "88888888-8888-4888-8888-888888888888";
    const blobKey = `documents/private/${revisionId}.md`;
    const markdown = "\uFEFF# BOM-prefixed knowledge\n";
    storage.objects.set(blobKey, Buffer.from(markdown, "utf8"));
    const app = createStorageBrokerApp({
      storage,
      privateAssets: privateAssets({}),
      tokens,
    });
    const directory = await mkdtemp(join(tmpdir(), "context-use-document-bom-"));
    const socketPath = join(directory, "storage.sock");
    const server = Bun.serve({ unix: socketPath, fetch: app.handle });

    try {
      const client = createPrivateStorageBroker({ socketPath, token: tokens.private });
      const decoded = await client.readMarkdownBlob(blobKey);
      expect(decoded).toBe(markdown);
      expect(Buffer.from(decoded, "utf8")).toEqual(Buffer.from(markdown, "utf8"));
    } finally {
      server.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("private capability reads and writes while retaining immutable deletion checks", async () => {
    const storage = new MemoryStorage();
    const app = createStorageBrokerApp({
      storage,
      privateAssets: privateAssets({
        [privateKey.split("/").at(-1)!]: {
          filename: "private.txt",
          contentType: "text/plain",
          bytes: "private",
        },
        [newKey.split("/").at(-1)!]: {
          filename: "new.txt",
          contentType: "text/plain",
          bytes: "new",
        },
      }),
      tokens,
    });

    expect(
      (await app.handle(authorized(tokens.private, `/private/blob?key=${privateKey}`))).status,
    ).toBe(200);
    const replacement = Buffer.from("changed");
    expect(
      (
        await app.handle(
          authorized(tokens.private, "/private/blob", {
            method: "PUT",
            headers: {
              "content-length": String(replacement.byteLength),
              "x-asset-id": privateKey.split("/").at(-1)!,
              "x-blob-key": privateKey,
              "x-filename": "private.txt",
              "x-content-type": "text/plain",
              "x-content-sha256": createHash("sha256").update(replacement).digest("hex"),
            },
            body: replacement,
          }),
        )
      ).status,
    ).toBe(404);
    expect(Buffer.from(storage.objects.get(privateKey)!).toString()).toBe("private");

    const uploaded = Buffer.from("new");
    expect(
      (
        await app.handle(
          authorized(tokens.private, "/private/blob", {
            method: "PUT",
            headers: {
              "content-length": String(uploaded.byteLength),
              "x-asset-id": newKey.split("/").at(-1)!,
              "x-blob-key": newKey,
              "x-filename": "new.txt",
              "x-content-type": "text/plain",
              "x-content-sha256": createHash("sha256").update(uploaded).digest("hex"),
            },
            body: uploaded,
          }),
        )
      ).status,
    ).toBe(204);
    expect(Buffer.from(storage.objects.get(newKey)!).toString()).toBe("new");
    expect(
      (
        await app.handle(
          authorized(tokens.private, `/private/blob?key=${privateKey}`, { method: "DELETE" }),
        )
      ).status,
    ).toBe(404);
    expect(storage.objects.has(privateKey)).toBe(true);
    const verification = await app.handle(
      authorized(tokens.private, "/private/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ blob_key: privateKey, size_bytes: 7, content_hash: "a".repeat(64) }),
      }),
    );
    expect(verification.status).toBe(200);
    expect(await verification.json()).toEqual({ verified: false });
  });

  test("only the private capability can verify an exact public document artifact", async () => {
    const storage = new MemoryStorage();
    const artifact = Buffer.from("published projection");
    storage.objects.set(publicDocumentKey, artifact);
    const app = createStorageBrokerApp({
      storage,
      privateAssets: privateAssets({}),
      tokens,
    });
    const payload = {
      blob_key: publicDocumentKey,
      size_bytes: artifact.byteLength,
      content_hash: createHash("sha256").update(artifact).digest("hex"),
    };

    const privateResponse = await app.handle(
      authorized(tokens.private, "/private/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      }),
    );
    expect(privateResponse.status).toBe(200);
    expect(await privateResponse.json()).toEqual({ verified: true });
    for (const token of [tokens.public]) {
      expect(
        (
          await app.handle(
            authorized(token, "/private/verify", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(payload),
            }),
          )
        ).status,
      ).toBe(404);
    }
    expect(
      (
        await app.handle(
          authorized(
            tokens.private,
            `/private/markdown-blob?key=${encodeURIComponent(publicDocumentKey)}`,
          ),
        )
      ).status,
    ).toBe(404);
  });

  test("streams multi-chunk video bytes through the Unix storage broker", async () => {
    const bytes = Uint8Array.from(
      { length: 2 * 1024 * 1024 + 97 },
      (_, index) => (index * 31 + Math.floor(index / 65_536)) % 256,
    );
    const id = newKey.split("/").at(-1)!;
    const asset: StoredBlob = {
      id,
      blobKey: newKey,
      filename: "demo-video.mp4",
      contentType: "video/mp4",
      sizeBytes: bytes.byteLength,
      contentHash: createHash("sha256").update(bytes).digest("hex"),
    };
    const storage = new MemoryStorage();
    const app = createStorageBrokerApp({
      storage,
      privateAssets: privateAssets({
        [id]: {
          filename: asset.filename,
          contentType: asset.contentType,
          bytes,
        },
      }),
      tokens,
    });
    const directory = await mkdtemp(join(tmpdir(), "context-use-storage-broker-"));
    const socketPath = join(directory, "storage.sock");
    const server = Bun.serve({ unix: socketPath, fetch: app.handle });

    try {
      const client = createPrivateStorageBroker({ socketPath, token: tokens.private });
      await client.write(asset, new Blob([bytes]).stream());
      expect(storage.objects.get(newKey)).toEqual(bytes);
    } finally {
      server.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("dashboard can delete bytes only after metadata authorizes the lifecycle transition", async () => {
    const storage = new MemoryStorage();
    const privateId = privateKey.split("/").at(-1)!;
    const publishedId = publishedKey.slice("objects/".length);
    const app = createStorageBrokerApp({
      storage,
      privateAssets: privateAssets(
        {
          [privateId]: { filename: "private.txt", contentType: "text/plain", bytes: "private" },
          [publishedId]: {
            filename: "published.txt",
            contentType: "text/plain",
            bytes: "published",
          },
        },
        [privateId],
      ),
      tokens,
    });

    expect(
      (
        await app.handle(
          authorized(tokens.private, `/private/blob?key=${publishedKey}`, { method: "DELETE" }),
        )
      ).status,
    ).toBe(404);
    expect(storage.objects.has(publishedKey)).toBe(true);
    expect(
      (
        await app.handle(
          authorized(tokens.private, `/private/blob?key=${privateKey}`, { method: "DELETE" }),
        )
      ).status,
    ).toBe(204);
    expect(storage.objects.has(privateKey)).toBe(false);
    expect(
      (
        await app.handle(
          authorized(
            "invalid-token-that-is-long-enough-for-parser",
            `/private/blob?key=${publishedKey}`,
          ),
        )
      ).status,
    ).toBe(404);
  });
});
