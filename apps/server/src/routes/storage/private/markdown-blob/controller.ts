import { MAX_MARKDOWN_BLOB_BYTES } from "@context-use/database";
import { Elysia } from "elysia";
import { z } from "zod";
import {
  denied,
  parseRange,
  privateCapability,
  readBlob,
} from "../../../../storage/broker-boundary.ts";
import type { StorageRouteContext } from "../../../../storage/broker-contracts.ts";
import { blobKeySchema, pageBlobKeySchema } from "../../../../storage/broker-model.ts";

export function createPrivateMarkdownBlobController(context: StorageRouteContext) {
  const { activeWrites, storage, tokens } = context;
  return new Elysia()
    .put(
      "/private/markdown-blob",
      async ({ request }) => {
        if (!privateCapability({ request, tokens })) {
          return denied();
        }
        const revisionId = z.string().uuid().parse(request.headers.get("x-page-revision-id"));
        const blobKey = blobKeySchema.parse(request.headers.get("x-blob-key"));
        const sizeBytes = z
          .number()
          .int()
          .nonnegative()
          .max(MAX_MARKDOWN_BLOB_BYTES)
          .parse(Number(request.headers.get("content-length")));
        const contentHash = z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .parse(request.headers.get("x-content-sha256"));
        if (blobKey !== `blobs/${revisionId}` || activeWrites.has(blobKey)) {
          return denied();
        }
        const blob = {
          id: revisionId,
          blobKey,
          filename: `${revisionId}.md`,
          contentType: "text/markdown; charset=utf-8",
          sizeBytes,
          contentHash,
        };
        if (await storage.exists(blobKey)) {
          return (await storage.verify(blobKey, sizeBytes, contentHash))
            ? new Response(null, { status: 204 })
            : denied();
        }
        activeWrites.add(blobKey);
        try {
          await storage.write(blob, request.body);
          return new Response(null, { status: 204 });
        } finally {
          activeWrites.delete(blobKey);
        }
      },
      { parse: "none" },
    )
    .get("/private/markdown-blob", ({ request, query }) => {
      if (!privateCapability({ request, tokens })) {
        return denied();
      }
      return readBlob({
        storage,
        blobKey: pageBlobKeySchema.parse(query.key),
        range: parseRange(request.headers.get("range")),
      });
    });
}
