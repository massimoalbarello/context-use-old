import { Elysia } from "elysia";
import { z } from "zod";
import { json, problem } from "../../../../../../http.ts";
import type { DashboardObjectsService } from "../../../../../../services/dashboard-objects-service.ts";
import type { AuthorizeOwner } from "../../../../authorization.ts";

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
