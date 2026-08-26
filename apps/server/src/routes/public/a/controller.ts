import { Elysia } from "elysia";
import type { PublicWebService } from "../../../services/public-web-service.ts";

export function createPublicAssetController(service: PublicWebService) {
  return new Elysia().get("/a/*", ({ request, params }) =>
    service.asset({ request, rawPath: params["*"] }),
  );
}
