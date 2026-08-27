import { publicationEntrypointSchema } from "@context-use/shared";
import { Elysia } from "elysia";
import { bodyJson, json } from "#http/responses.ts";
import type { AuthorizeOwner } from "#private/auth/dashboard-owner-authorizer.ts";
import type { DashboardPublicationService } from "#private/services/dashboard/publication-service.ts";

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
