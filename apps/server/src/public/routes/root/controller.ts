import { Elysia } from "elysia";
import type { PublicLandingService } from "#public/services/landing-service.ts";

export function createPublicLandingController(service: PublicLandingService) {
  return new Elysia().get("/", () => service.get());
}
