import { Elysia } from "elysia";
import { z } from "zod";
import { problem } from "../../../../../../../../http.ts";
import { securityHeaders } from "../../../../../../../../security.ts";
import type { DashboardKnowledgeImportsService } from "../../../../../../../../services/dashboard-knowledge-imports-service.ts";
import { disableStreamingRequestIdleTimeout } from "../../../../../../../../streaming-timeout.ts";
import type { AuthorizeOwner } from "../../../../../../authorization.ts";

export function createKnowledgeImportPartController({
  authorizeOwner,
  service,
}: {
  authorizeOwner: AuthorizeOwner;
  service: DashboardKnowledgeImportsService;
}) {
  return new Elysia().put(
    "/api/dashboard/knowledge-imports/:importId/parts/:part",
    async ({ request, params, server }) => {
      disableStreamingRequestIdleTimeout(server, request);
      const principal = await authorizeOwner({ request, mode: "upload" });
      const result = await service.uploadPart({
        importId: z.string().uuid().parse(params.importId),
        partNumber: z.coerce.number().int().nonnegative().parse(params.part),
        sizeBytes: Number(request.headers.get("content-length")),
        contentHash: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .parse(request.headers.get("x-content-sha256")),
        body: request.body,
        principal,
      });
      if (result.state === "not_found") {
        return problem("Knowledge import not found", 404, "not_found");
      }
      if (result.state === "part_size_mismatch") {
        return problem("Knowledge import part has the wrong size", 400, "part_size_mismatch");
      }
      return new Response(null, { status: 204, headers: securityHeaders });
    },
    { parse: "none" },
  );
}
