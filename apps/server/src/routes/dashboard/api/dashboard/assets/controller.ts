import { Elysia } from "elysia";
import { json } from "../../../../../http.ts";
import type { DashboardAssetsService } from "../../../../../services/dashboard-assets-service.ts";
import type { AuthorizeOwner } from "../../../authorization.ts";

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
