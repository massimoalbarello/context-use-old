import { Elysia } from "elysia";
import { z } from "zod";
import { json, problem } from "#http/responses.ts";
import type { AuthorizeOwner } from "#private/auth/dashboard-owner-authorizer.ts";
import type { DashboardObjectsService } from "#private/services/dashboard/objects-service.ts";

export function createObjectController({
  authorizeOwner,
  service,
}: {
  authorizeOwner: AuthorizeOwner;
  service: DashboardObjectsService;
}) {
  return new Elysia().get("/api/dashboard/objects/:objectId", async ({ request, params }) => {
    await authorizeOwner({ request });
    const object = await service.get(z.string().uuid().parse(params.objectId));
    return object ? json(object) : problem("Object not found", 404, "not_found");
  });
}
