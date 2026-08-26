import { publicationEntrypointSchema } from "@context-use/shared";
import { Elysia } from "elysia";
import { bodyJson, json } from "../../../../../http.ts";
import type { DashboardPublicationService } from "../../../../../services/dashboard-publication-service.ts";
import type { AuthorizeOwner } from "../../../authorization.ts";

export function createPublicationEntrypointController({
  authorizeOwner,
  service,
}: {
  authorizeOwner: AuthorizeOwner;
  service: DashboardPublicationService;
}) {
  return new Elysia()
    .get("/api/dashboard/publication-entrypoint", async ({ request }) => {
      await authorizeOwner({ request });
      return json(await service.entrypoint());
    })
    .get("/api/dashboard/publication-entrypoint/candidates", async ({ request }) => {
      await authorizeOwner({ request });
      return json(await service.entrypointCandidates());
    })
    .put("/api/dashboard/publication-entrypoint", async ({ request }) => {
      await authorizeOwner({ request, mode: "json" });
      const input = publicationEntrypointSchema.parse(await bodyJson(request));
      return json(await service.setEntrypoint(input));
    });
}
