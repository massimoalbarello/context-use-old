import { Elysia } from "elysia";
import type { PublicWebService } from "../../../services/public-web-service.ts";

export function createPublicStylesController(service: PublicWebService) {
  return new Elysia()
    .get("/public.css", () => service.styles("public"))
    .get("/content.css", () => service.styles("content"));
}
