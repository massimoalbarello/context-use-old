import { Elysia } from "elysia";
import { z } from "zod";
import { json, problem } from "../../../../../../../http.ts";
import type { DashboardKnowledgeImportsService } from "../../../../../../../services/dashboard-knowledge-imports-service.ts";
import type { AuthorizeOwner } from "../../../../../authorization.ts";

export function createKnowledgeImportStatusController({
  authorizeOwner,
  service,
}: {
  authorizeOwner: AuthorizeOwner;
  service: DashboardKnowledgeImportsService;
}) {
  return new Elysia().get(
    "/api/dashboard/knowledge-imports/:importId/status",
    async ({ request, params }) => {
      const principal = await authorizeOwner({ request });
      const status = await service.status({
        importId: z.string().uuid().parse(params.importId),
        principal,
      });
      return status ? json(status) : problem("Knowledge import not found", 404, "not_found");
    },
  );
}
