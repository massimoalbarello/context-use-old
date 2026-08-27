import { Elysia } from "elysia";
import { z } from "zod";
import { json, problem } from "#http/responses.ts";
import type { AuthorizeOwner } from "#private/auth/dashboard-owner-authorizer.ts";
import type { DashboardObjectsService } from "#private/services/dashboard/objects-service.ts";

export function createObjectNeighborhoodController({
  authorizeOwner,
  service,
}: {
  authorizeOwner: AuthorizeOwner;
  service: DashboardObjectsService;
}) {
  return new Elysia().get(
    "/api/dashboard/objects/:objectId/neighborhood",
    async ({ request, params, query }) => {
      await authorizeOwner({ request });
      const neighborhood = await service.neighborhood({
        objectId: z.string().uuid().parse(params.objectId),
        query,
      });
      return neighborhood ? json(neighborhood) : problem("Object not found", 404, "not_found");
    },
  );
}
