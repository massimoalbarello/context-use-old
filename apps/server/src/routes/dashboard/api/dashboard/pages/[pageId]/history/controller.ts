import { Elysia } from "elysia";
import { z } from "zod";
import { json } from "../../../../../../../http.ts";
import type { DashboardPagesService } from "../../../../../../../services/dashboard-pages-service.ts";
import type { AuthorizeOwner } from "../../../../../authorization.ts";

export function createPageHistoryController({
  authorizeOwner,
  service,
}: {
  authorizeOwner: AuthorizeOwner;
  service: DashboardPagesService;
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
