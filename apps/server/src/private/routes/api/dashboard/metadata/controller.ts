import { Elysia } from "elysia";
import { json } from "#http/responses.ts";
import type { AuthorizeOwner } from "#private/auth/dashboard-owner-authorizer.ts";
import type { DashboardMetadataService } from "#private/services/dashboard/metadata-service.ts";

export function createDashboardMetadataController({
  authorizeOwner,
  service,
}: {
  authorizeOwner: AuthorizeOwner;
  service: DashboardMetadataService;
}) {
  return new Elysia()
    .get("/api/dashboard/mcp-endpoint", async ({ request }) => {
      await authorizeOwner({ request });
      return json(service.mcpEndpoint());
    })
    .get("/api/dashboard/services", async ({ request }) => {
      await authorizeOwner({ request });
      return json(service.services());
    });
}
