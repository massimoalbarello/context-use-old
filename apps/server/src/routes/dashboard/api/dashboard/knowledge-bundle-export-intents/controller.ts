import { Elysia } from "elysia";
import { z } from "zod";
import { bodyJson, json } from "../../../../../http.ts";
import type { DashboardKnowledgeBundleExportsService } from "../../../../../services/dashboard-knowledge-bundle-exports-service.ts";
import type { AuthorizeOwner } from "../../../authorization.ts";

const emptyObjectSchema = z.object({}).strict();

export function createKnowledgeBundleExportIntentsController({
  authorizeOwner,
  service,
}: {
  authorizeOwner: AuthorizeOwner;
  service: DashboardKnowledgeBundleExportsService;
}) {
  return new Elysia().post(
    "/api/dashboard/knowledge-bundle-export-intents",
    async ({ request }) => {
      const principal = await authorizeOwner({ request, mode: "json" });
      emptyObjectSchema.parse(await bodyJson(request));
      return json(await service.create(principal), 201);
    },
  );
}
