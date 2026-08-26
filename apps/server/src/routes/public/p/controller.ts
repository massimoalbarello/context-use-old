import { Elysia } from "elysia";
import { securityHeaders } from "../../../security.ts";
import type { PublicWebService } from "../../../services/public-web-service.ts";

export function createPublicPageController(service: PublicWebService) {
  return new Elysia()
    .get(
      "/p",
      () => new Response(null, { status: 308, headers: { ...securityHeaders, location: "/p/" } }),
    )
    .get("/p/*", ({ params }) => service.page(params["*"]));
}
