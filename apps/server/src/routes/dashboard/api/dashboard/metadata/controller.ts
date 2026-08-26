import { Elysia } from "elysia";
import { json } from "../../../../../http.ts";
import type { DashboardMetadataService } from "../../../../../services/dashboard-metadata-service.ts";
import type { AuthorizeOwner } from "../../../authorization.ts";

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
