import { Elysia } from "elysia";
import type { PublicPageService } from "#public/services/page-service.ts";

export function createPublicPageController(service: PublicPageService) {
  return new Elysia()
    .get("/p", () => service.root())
    .get("/p/*", ({ params }) => service.get(params["*"]));
}
