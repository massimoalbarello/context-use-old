import { Elysia } from "elysia";
import { z } from "zod";
import { denied, parseRange, publicAuthorized, readBlob } from "#storage/broker-boundary.ts";
import type { StorageRouteContext } from "#storage/broker-contracts.ts";
import { publicAssetArtifactKeySchema, publicPageKeySchema } from "#storage/broker-model.ts";
import { exactNumber } from "#storage/services/publication-service.ts";

const representationQuerySchema = z.object({ token: z.string().regex(/^[a-f0-9]{64}$/) }).strict();

export function createPublicRepresentationController(context: StorageRouteContext) {
  const { publications, storage, tokens } = context;
  const resolve = async ({
    request,
    query,
  }: {
    request: Request;
    query: Record<string, string>;
  }) => {
    if (!publicAuthorized({ request, tokens }) || !publications?.resolve) {
      return null;
    }
    const { token } = representationQuerySchema.parse(query);
    const route = await publications.resolve(token);
    if (!route || route.representation_token !== token) {
      return null;
    }
    const sizeBytes = exactNumber({ value: route.body_size_bytes, maximum: 5_000_000_000 });
    const blobKey =
      route.resource_kind === "page"
        ? publicPageKeySchema.parse(route.body_object_key)
        : publicAssetArtifactKeySchema.parse(route.body_object_key);
    if (!(await storage.verify(blobKey, sizeBytes, route.body_content_hash))) {
      return null;
    }
    return { route, sizeBytes, blobKey };
  };
  return new Elysia()
    .head("/public/representation", async ({ request, query }) => {
      const representation = await resolve({ request, query });
      if (!representation) {
        return denied();
      }
      return new Response(null, {
        headers: {
          "cache-control": "no-store",
          "content-length": String(representation.sizeBytes),
          "x-content-sha256": representation.route.body_content_hash,
        },
      });
    })
    .get("/public/representation", async ({ request, query }) => {
      const representation = await resolve({ request, query });
      if (!representation) {
        return denied();
      }
      const range = parseRange(request.headers.get("range"));
      if (request.headers.has("range") && !range) {
        return denied();
      }
      if (
        range &&
        (range.start >= representation.sizeBytes || range.end >= representation.sizeBytes)
      ) {
        return denied();
      }
      return readBlob({ storage, blobKey: representation.blobKey, range });
    });
}
