import { Elysia } from "elysia";
import { json } from "../../../../../../http.ts";
import type { DashboardKnowledgeImportsService } from "../../../../../../services/dashboard-knowledge-imports-service.ts";
import type { AuthorizeOwner } from "../../../../authorization.ts";

export function createKnowledgeImportAvailabilityController({
  authorizeOwner,
  service,
}: {
  authorizeOwner: AuthorizeOwner;
  service: DashboardKnowledgeImportsService;
}) {
  return new Elysia().get("/api/dashboard/knowledge-imports/availability", async ({ request }) => {
    await authorizeOwner({ request });
    return json(await service.availability());
  });
}
