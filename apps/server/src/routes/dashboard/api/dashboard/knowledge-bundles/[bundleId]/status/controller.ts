import { Elysia } from "elysia";
import { z } from "zod";
import { json, problem } from "../../../../../../../http.ts";
import type { DashboardKnowledgeBundleExportsService } from "../../../../../../../services/dashboard-knowledge-bundle-exports-service.ts";
import type { AuthorizeOwner } from "../../../../../authorization.ts";

export function createKnowledgeBundleStatusController({
  authorizeOwner,
  service,
}: {
  authorizeOwner: AuthorizeOwner;
  service: DashboardKnowledgeBundleExportsService;
}) {
  return new Elysia().get(
    "/api/dashboard/knowledge-bundles/:bundleId/status",
    async ({ request, params }) => {
      const principal = await authorizeOwner({ request });
      const status = await service.status({
        intentId: z.string().uuid().parse(params.bundleId),
        principal,
      });
      if (status.state === "not_found") {
        return problem("Knowledge bundle export not found", 404, "not_found");
      }
      if (status.state === "passkey_required") {
        return problem("A fresh passkey confirmation is required", 403, "passkey_required");
      }
      return json(status.result.body, status.result.ready ? 200 : 202);
    },
  );
}
