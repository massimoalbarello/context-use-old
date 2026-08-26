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
  publicAssetArtifactKeySchema,
  publicPageKeySchema,
} from "../../../../storage/broker-model.ts";

export function createPrivateBundleSourceController({ storage, tokens }: StorageRouteContext) {
  return new Elysia().get("/private/bundle-source", ({ request, query }) => {
    if (privateCapability({ request, tokens }) !== "dashboard") {
      return denied();
    }
    return readBlob({
      storage,
      blobKey: z.union([publicPageKeySchema, publicAssetArtifactKeySchema]).parse(query.key),
      range: parseRange(request.headers.get("range")),
    });
  });
}
