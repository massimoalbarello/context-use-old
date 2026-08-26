import { Elysia } from "elysia";
import { json } from "../../../http.ts";
import type { PublicWebService } from "../../../services/public-web-service.ts";

export function createPublicHealthController(service: PublicWebService) {
  return new Elysia().get("/health", () => json(service.health()));
}
