import { Elysia } from "elysia";
import { z } from "zod";
import { json, problem } from "../../../../../../../http.ts";
import type { DashboardPagesService } from "../../../../../../../services/dashboard-pages-service.ts";
import type { AuthorizeOwner } from "../../../../../authorization.ts";

export function createPagePublicationPreviewController({
  authorizeOwner,
  service,
}: {
  authorizeOwner: AuthorizeOwner;
  service: DashboardPagesService;
}) {
  return new Elysia().get(
    "/api/dashboard/pages/:pageId/publication-preview",
    async ({ request, params }) => {
      await authorizeOwner({ request });
      const result = await service.publicationPreview(z.string().uuid().parse(params.pageId));
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
