import { Elysia } from "elysia";
import { json } from "#http/responses.ts";
import type { AuthorizeOwner } from "#private/auth/dashboard-owner-authorizer.ts";
import type { DashboardObjectsService } from "#private/services/dashboard/objects-service.ts";

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
