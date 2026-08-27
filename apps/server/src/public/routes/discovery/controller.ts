import { Elysia } from "elysia";
import type { PublicDiscoveryService } from "#public/services/discovery-service.ts";

export function createPublicDiscoveryController(service: PublicDiscoveryService) {
  return new Elysia()
    .get("/robots.txt", () => service.robots())
    .get("/sitemap.xml", () => service.sitemap())
    .get("/llms.txt", () => service.llms(false))
    .get("/llms-full.txt", () => service.llms(true));
}
