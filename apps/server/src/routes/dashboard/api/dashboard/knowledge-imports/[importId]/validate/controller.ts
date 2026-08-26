import { Elysia } from "elysia";
import { z } from "zod";
import { bodyJson, json } from "../../../../../../../http.ts";
import type { DashboardKnowledgeImportsService } from "../../../../../../../services/dashboard-knowledge-imports-service.ts";
import type { AuthorizeOwner } from "../../../../../authorization.ts";

const emptyObjectSchema = z.object({}).strict();

export function createKnowledgeImportValidationController({
  authorizeOwner,
  service,
}: {
  authorizeOwner: AuthorizeOwner;
  service: DashboardKnowledgeImportsService;
}) {
  return new Elysia().post(
    "/api/dashboard/knowledge-imports/:importId/validate",
    async ({ request, params }) => {
      const principal = await authorizeOwner({ request, mode: "json" });
      emptyObjectSchema.parse(await bodyJson(request));
      return json(
        await service.validate({
          importId: z.string().uuid().parse(params.importId),
          principal,
        }),
        202,
      );
    },
  );
}
