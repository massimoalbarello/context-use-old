import { Elysia } from "elysia";
import { json } from "#http/responses.ts";
import type { DashboardMetadataService } from "#private/services/dashboard/metadata-service.ts";

export function createDashboardHealthController({
  service,
}: {
  service: DashboardMetadataService;
}) {
  return new Elysia().get("/api/health", () => json(service.health()));
}
