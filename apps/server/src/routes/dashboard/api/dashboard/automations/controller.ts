import { Elysia } from "elysia";
import { json } from "../../../../../http.ts";
import type { DashboardObjectsService } from "../../../../../services/dashboard-objects-service.ts";
import type { AuthorizeOwner } from "../../../authorization.ts";

export function createAutomationsController({
  authorizeOwner,
  service,
}: {
  authorizeOwner: AuthorizeOwner;
  service: DashboardObjectsService;
}) {
  return new Elysia().get("/api/dashboard/automations", async ({ request }) => {
    await authorizeOwner({ request });
    return json(await service.automations());
  });
}
