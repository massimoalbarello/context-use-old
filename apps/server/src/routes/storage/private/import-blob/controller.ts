import { Elysia } from "elysia";
import { z } from "zod";
import { denied, privateCapability } from "../../../../storage/broker-boundary.ts";
import type { StorageRouteContext } from "../../../../storage/broker-contracts.ts";
import { importedObjectKeySchema } from "../../../../storage/broker-model.ts";
import { BlobAlreadyExistsError } from "../../../../storage.ts";

export function createPrivateImportBlobController(context: StorageRouteContext) {
  const { activeWrites, knowledgeBundles, storage, tokens } = context;
  return new Elysia().put(
    "/private/import-blob",
    async ({ request }) => {
      if (privateCapability({ request, tokens }) !== "dashboard" || !knowledgeBundles) {
        return denied();
      }
      const importId = z.string().uuid().parse(request.headers.get("x-import-id"));
      const blobKey = importedObjectKeySchema.parse(request.headers.get("x-blob-key"));
      const contentType = z.string().min(1).max(255).parse(request.headers.get("x-content-type"));
      const sizeBytes = z
        .number()
        .int()
        .nonnegative()
        .max(5_000_000_000)
        .parse(Number(request.headers.get("content-length")));
      const contentHash = z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .parse(request.headers.get("x-content-sha256"));
      const authorization = await knowledgeBundles.importBlobAuthorization(importId, blobKey);
      if (
        authorization?.status !== "restoring" ||
        !authorization.confirmed_at ||
        authorization.blob_key !== blobKey ||
        new Date(authorization.expires_at).getTime() <= Date.now() ||
        Number(authorization.size_bytes) !== sizeBytes ||
        authorization.content_hash !== contentHash ||
        authorization.content_type !== contentType
      ) {
        return denied();
      }
      if (await storage.exists(blobKey)) {
        return (await storage.verify(blobKey, sizeBytes, contentHash))
          ? new Response(null, { status: 204 })
          : denied();
      }
      if (activeWrites.has(blobKey)) {
        return denied();
      }
      activeWrites.add(blobKey);
      try {
        try {
          await storage.writeOnce(
            {
              id: importId,
              blobKey,
              filename: blobKey.split("/").at(-1) ?? importId,
              contentType,
              sizeBytes,
              contentHash,
            },
            request.body,
          );
        } catch (error) {
          if (
            !(error instanceof BlobAlreadyExistsError) ||
            !(await storage.verify(blobKey, sizeBytes, contentHash))
          ) {
            throw error;
          }
        }
        return new Response(null, { status: 204 });
      } finally {
        activeWrites.delete(blobKey);
      }
    },
    { parse: "none" },
  );
}
