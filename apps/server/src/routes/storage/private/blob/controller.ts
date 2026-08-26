import { Elysia } from "elysia";
import { z } from "zod";
import {
  denied,
  parseRange,
  privateCapability,
  readBlob,
} from "../../../../storage/broker-boundary.ts";
import type { StorageRouteContext } from "../../../../storage/broker-contracts.ts";
import {
  assetBlobKeySchema,
  blobKeySchema,
  filenameHeader,
} from "../../../../storage/broker-model.ts";

export function createPrivateBlobController(context: StorageRouteContext) {
  const { activeWrites, privateAssets, storage, tokens } = context;
  return new Elysia()
    .put(
      "/private/blob",
      async ({ request }) => {
        if (!privateCapability({ request, tokens })) {
          return denied();
        }
        const asset = {
          id: z.string().uuid().parse(request.headers.get("x-asset-id")),
          blobKey: blobKeySchema.parse(request.headers.get("x-blob-key")),
          filename: filenameHeader(request),
          contentType: z.string().min(1).max(255).parse(request.headers.get("x-content-type")),
          sizeBytes: z
            .number()
            .int()
            .nonnegative()
            .max(5_000_000_000)
            .parse(Number(request.headers.get("content-length"))),
          contentHash: z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .parse(request.headers.get("x-content-sha256")),
        };
        if (asset.blobKey !== `blobs/${asset.id}`) {
          return denied();
        }
        const expected = await privateAssets.getForStorage(asset.id);
        if (
          !expected ||
          expected.blob_key !== asset.blobKey ||
          expected.filename !== asset.filename ||
          expected.content_type !== asset.contentType ||
          Number(expected.size_bytes) !== asset.sizeBytes ||
          expected.content_hash !== asset.contentHash
        ) {
          return denied();
        }
        if (activeWrites.has(asset.blobKey)) {
          return denied();
        }
        activeWrites.add(asset.blobKey);
        try {
          if (await storage.exists(asset.blobKey)) {
            return denied();
          }
          await storage.write(asset, request.body);
          return new Response(null, { status: 204 });
        } finally {
          activeWrites.delete(asset.blobKey);
        }
      },
      { parse: "none" },
    )
    .get("/private/blob", ({ request, query }) => {
      if (!privateCapability({ request, tokens })) {
        return denied();
      }
      return readBlob({
        storage,
        blobKey: assetBlobKeySchema.parse(query.key),
        range: parseRange(request.headers.get("range")),
      });
    })
    .delete("/private/blob", async ({ request, query }) => {
      if (privateCapability({ request, tokens }) !== "dashboard") {
        return denied();
      }
      const blobKey = assetBlobKeySchema.parse(query.key);
      const id = z
        .string()
        .uuid()
        .parse(blobKey.slice(blobKey.indexOf("/") + 1));
      const deleted = await privateAssets.getDeletedForStorage(id);
      if (!deleted || deleted.blob_key !== blobKey) {
        return denied();
      }
      await storage.delete(blobKey);
      return new Response(null, { status: 204 });
    });
}
