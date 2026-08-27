import { Elysia } from "elysia";
import { z } from "zod";
import { json } from "#http/responses.ts";
import type { AuthorizeOwner } from "#private/auth/dashboard-owner-authorizer.ts";
import type { PageHistoryService } from "#private/services/dashboard/page-history-service.ts";

export function createPageHistoryController({
  authorizeOwner,
  service,
}: {
  authorizeOwner: AuthorizeOwner;
  service: PageHistoryService;
}) {
  return new Elysia().get(
    "/api/dashboard/pages/:pageId/history",
    async ({ request, params, query }) => {
      await authorizeOwner({ request });
      return json(
        await service.history({
          pageId: z.string().uuid().parse(params.pageId),
          ...(query.before === undefined
            ? {}
            : {
                beforeRevisionNumber: z.coerce.number().int().positive().parse(query.before),
              }),
          limit:
            query.limit === undefined
              ? 100
              : z.coerce.number().int().min(1).max(100).parse(query.limit),
        }),
      );
    },
  );
}
