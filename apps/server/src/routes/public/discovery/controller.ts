import { Elysia } from "elysia";
import type { PublicWebService } from "../../../services/public-web-service.ts";

export function createPublicDiscoveryController(service: PublicWebService) {
  return new Elysia()
    .get("/robots.txt", () => service.robots())
    .get("/sitemap.xml", () => service.sitemap())
    .get("/llms.txt", () => service.llms(false))
    .get("/llms-full.txt", () => service.llms(true));
}
