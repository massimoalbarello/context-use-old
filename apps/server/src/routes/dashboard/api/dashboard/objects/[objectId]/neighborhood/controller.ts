import { Elysia } from "elysia";
import { z } from "zod";
import { json, problem } from "../../../../../../../http.ts";
import type { DashboardObjectsService } from "../../../../../../../services/dashboard-objects-service.ts";
import type { AuthorizeOwner } from "../../../../../authorization.ts";

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
