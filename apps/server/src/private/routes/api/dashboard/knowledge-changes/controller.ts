import { Elysia } from "elysia";
import { z } from "zod";
import { json } from "#http/responses.ts";
import type { AuthorizeOwner } from "#private/auth/dashboard-owner-authorizer.ts";
import type { PageHistoryService } from "#private/services/dashboard/page-history-service.ts";

export function createKnowledgeChangesController({
  authorizeOwner,
  service,
}: {
  authorizeOwner: AuthorizeOwner;
  service: PageHistoryService;
}) {
  return new Elysia().get("/api/dashboard/knowledge-changes", async ({ request, query }) => {
    await authorizeOwner({ request });
    const before =
      typeof query.before === "string"
        ? z
            .string()
            .regex(/^cu-page-changes-v1\.[0-9a-z]+$/)
            .parse(query.before)
        : undefined;
    const limit =
      query.limit === undefined ? 50 : z.coerce.number().int().min(1).max(100).parse(query.limit);
    return json(await service.recentChanges({ ...(before ? { before } : {}), limit }));
  });
}
