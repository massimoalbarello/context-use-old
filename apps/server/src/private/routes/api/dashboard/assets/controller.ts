import { Elysia } from "elysia";
import { json } from "#http/responses.ts";
import type { AuthorizeOwner } from "#private/auth/dashboard-owner-authorizer.ts";
import type { DashboardAssetsService } from "#private/services/dashboard/assets-service.ts";

export function createAssetsController({
  authorizeOwner,
  service,
}: {
  authorizeOwner: AuthorizeOwner;
  service: DashboardAssetsService;
}) {
  return new Elysia().get("/api/dashboard/assets", async ({ request }) => {
    await authorizeOwner({ request });
    return json(await service.list());
  });
}
