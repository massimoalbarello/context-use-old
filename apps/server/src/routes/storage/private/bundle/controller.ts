import { Elysia } from "elysia";
import {
  bundleObjectResponse,
  denied,
  privateCapability,
} from "../../../../storage/broker-boundary.ts";
import type { StorageRouteContext } from "../../../../storage/broker-contracts.ts";
import { bundleObjectKeySchema } from "../../../../storage/broker-model.ts";

export function createPrivateBundleController(context: StorageRouteContext) {
  const { activeWrites, storage, tokens } = context;
  const read = ({ request, key }: { request: Request; key: unknown }) => {
    if (privateCapability({ request, tokens }) !== "dashboard") {
      return denied();
    }
    return bundleObjectResponse({
      request,
      storage,
      blobKey: bundleObjectKeySchema.parse(key),
    });
  };
  return new Elysia()
    .put(
      "/private/bundle",
      async ({ request, query }) => {
        if (privateCapability({ request, tokens }) !== "dashboard") {
          return denied();
        }
        const blobKey = bundleObjectKeySchema.parse(query.key);
        const existing = await storage.inspectBundle(blobKey);
        if (existing) {
          return Response.json(
            { size_bytes: existing.sizeBytes, content_hash: existing.contentHash },
            { headers: { "cache-control": "no-store" } },
          );
        }
        if (activeWrites.has(blobKey)) {
          return new Response("Bundle already exists", {
            status: 409,
            headers: { "cache-control": "no-store" },
          });
        }
        activeWrites.add(blobKey);
        try {
          const metadata = await storage.writeBundle(blobKey, request.body);
          return Response.json(
            { size_bytes: metadata.sizeBytes, content_hash: metadata.contentHash },
            { status: 201, headers: { "cache-control": "no-store" } },
          );
        } finally {
          activeWrites.delete(blobKey);
        }
      },
      { parse: "none" },
    )
    .head("/private/bundle", ({ request, query }) => read({ request, key: query.key }))
    .get("/private/bundle", ({ request, query }) => read({ request, key: query.key }))
    .delete("/private/bundle", async ({ request, query }) => {
      if (privateCapability({ request, tokens }) !== "dashboard") {
        return denied();
      }
      await storage.deleteBundle(bundleObjectKeySchema.parse(query.key));
      return new Response(null, { status: 204 });
    });
}
