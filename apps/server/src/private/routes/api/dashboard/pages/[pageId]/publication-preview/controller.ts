import { Elysia } from "elysia";
import { z } from "zod";
import { json, problem } from "#http/responses.ts";
import type { AuthorizeOwner } from "#private/auth/dashboard-owner-authorizer.ts";
import type { PagePublicationPreviewService } from "#private/services/dashboard/page-publication-preview-service.ts";

export function createPagePublicationPreviewController({
  authorizeOwner,
  service,
}: {
  authorizeOwner: AuthorizeOwner;
  service: PagePublicationPreviewService;
}) {
  return new Elysia().get(
    "/api/dashboard/pages/:pageId/publication-preview",
    async ({ request, params }) => {
      await authorizeOwner({ request });
      const result = await service.preview(z.string().uuid().parse(params.pageId));
      if (result.state === "not_found") {
        return problem("Active page not found", 404, "not_found");
      }
      if (result.state === "publication_state_invalid") {
        return problem(
          "Published revision evidence is unavailable",
          409,
          "publication_state_invalid",
        );
      }
      return json(result.preview);
    },
  );
}
