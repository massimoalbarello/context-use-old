import { Elysia } from "elysia";
import type { PublicAssetService } from "#public/services/asset-service.ts";

export function createPublicAssetController(service: PublicAssetService) {
  return new Elysia().get("/a/*", ({ request, params }) =>
    service.get({ request, rawPath: params["*"] }),
  );
}
