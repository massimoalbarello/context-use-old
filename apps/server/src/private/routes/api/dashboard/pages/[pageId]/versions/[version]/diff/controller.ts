import { Elysia } from "elysia";
import { z } from "zod";
import { json, problem } from "#http/responses.ts";
import type { AuthorizeOwner } from "#private/auth/dashboard-owner-authorizer.ts";
import type { PageHistoryService } from "#private/services/dashboard/page-history-service.ts";

export function createPageVersionDiffController({
  authorizeOwner,
  service,
}: {
  authorizeOwner: AuthorizeOwner;
  service: PageHistoryService;
}) {
  return new Elysia().get(
    "/api/dashboard/pages/:pageId/versions/:version/diff",
    async ({ request, params, query }) => {
      await authorizeOwner({ request });
      const result = await service.diff({
        pageId: z.string().uuid().parse(params.pageId),
        revisionNumber: z.coerce.number().int().positive().parse(params.version),
        previousRevisionNumber:
          query.from === undefined ? null : z.coerce.number().int().positive().parse(query.from),
      });
      if (result.state === "invalid_comparison") {
        return problem(
          "The comparison revision must be earlier than the selected revision",
          422,
          "invalid_comparison",
        );
      }
      if (result.state === "not_found") {
        return problem("Revision not found", 404, "not_found");
      }
      if (result.state === "comparison_not_found") {
        return problem("Comparison revision not found", 404, "not_found");
      }
      return json(result.diff);
    },
  );
}
