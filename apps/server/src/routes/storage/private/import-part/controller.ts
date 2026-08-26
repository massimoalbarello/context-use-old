import { Elysia } from "elysia";
import { z } from "zod";
import {
  denied,
  parseRange,
  privateCapability,
  readBlob,
} from "../../../../storage/broker-boundary.ts";
import type { StorageRouteContext } from "../../../../storage/broker-contracts.ts";
import { importPartKeySchema } from "../../../../storage/broker-model.ts";

export function createPrivateImportPartController(context: StorageRouteContext) {
  const { activeWrites, storage, tokens } = context;
  return new Elysia()
    .put(
      "/private/import-part",
      async ({ request }) => {
        if (privateCapability({ request, tokens }) !== "dashboard") {
          return denied();
        }
        const importId = z.string().uuid().parse(request.headers.get("x-import-id"));
        const partNumber = z
          .number()
          .int()
          .nonnegative()
          .max(99_999)
          .parse(Number(request.headers.get("x-part-number")));
        const blobKey = importPartKeySchema.parse(request.headers.get("x-blob-key"));
        const sizeBytes = z
          .number()
          .int()
          .positive()
          .max(64 * 1024 * 1024)
          .parse(Number(request.headers.get("content-length")));
        const contentHash = z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .parse(request.headers.get("x-content-sha256"));
        if (blobKey !== `imports/${importId}/parts/${partNumber}`) {
          return denied();
        }
        const existing = await storage.inspectImportPart(blobKey);
        if (existing) {
          return existing.sizeBytes === sizeBytes && existing.contentHash === contentHash
            ? new Response(null, { status: 204 })
            : denied();
        }
        if (activeWrites.has(blobKey)) {
          return denied();
        }
        activeWrites.add(blobKey);
        try {
          await storage.writeImportPart(
            {
              id: importId,
              blobKey,
              filename: `${partNumber}.part`,
              contentType: "application/octet-stream",
              sizeBytes,
              contentHash,
            },
            request.body,
          );
          return new Response(null, { status: 204 });
        } finally {
          activeWrites.delete(blobKey);
        }
      },
      { parse: "none" },
    )
    .get("/private/import-part", ({ request, query }) => {
      if (privateCapability({ request, tokens }) !== "dashboard") {
        return denied();
      }
      return readBlob({
        storage,
        blobKey: importPartKeySchema.parse(query.key),
        range: parseRange(request.headers.get("range")),
      });
    })
    .delete("/private/import-part", async ({ request, query }) => {
      if (privateCapability({ request, tokens }) !== "dashboard") {
        return denied();
      }
      await storage.deleteImportPart(importPartKeySchema.parse(query.key));
      return new Response(null, { status: 204 });
    });
}
