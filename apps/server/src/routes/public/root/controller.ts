import { Elysia } from "elysia";
import type { PublicWebService } from "../../../services/public-web-service.ts";

export function createPublicLandingController(service: PublicWebService) {
  return new Elysia().get("/", () => service.landing());
}
