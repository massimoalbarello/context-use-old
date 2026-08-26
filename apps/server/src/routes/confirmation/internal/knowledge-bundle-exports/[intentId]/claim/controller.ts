import { Elysia } from "elysia";
import { z } from "zod";
import { bodyJson, problem } from "../../../../../../http.ts";
import { hasInternalCapability } from "../../../../../../internal-capability.ts";
import type { ConfirmationService } from "../../../../../../services/confirmation-service.ts";
import { principalSchema } from "../../../../model.ts";

export function createKnowledgeBundleExportClaimController({
  dashboardToken,
  service,
}: {
  dashboardToken: string;
  service: ConfirmationService;
}) {
  return new Elysia().post(
    "/internal/knowledge-bundle-exports/:intentId/claim",
    async ({ request, params }) => {
      if (!hasInternalCapability(request, dashboardToken)) {
        return problem("Not found", 404, "not_found");
      }
      await service.claimExport({
        intentId: z.string().uuid().parse(params.intentId),
        principal: principalSchema.parse(await bodyJson(request)),
      });
      return new Response(null, { status: 204 });
    },
  );
}
