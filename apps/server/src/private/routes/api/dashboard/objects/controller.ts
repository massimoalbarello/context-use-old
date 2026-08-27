import { createPageSchema } from "@context-use/shared";
import { Elysia } from "elysia";
import { bodyJson, json, problem } from "#http/responses.ts";
import type { AuthorizeOwner } from "#private/auth/dashboard-owner-authorizer.ts";
import type { DashboardObjectsService } from "#private/services/dashboard/objects-service.ts";
import type { PageMutationsService } from "#private/services/dashboard/page-mutations-service.ts";

export function createObjectsController({
  authorizeOwner,
  objects,
  pages,
}: {
  authorizeOwner: AuthorizeOwner;
  objects: DashboardObjectsService;
  pages: PageMutationsService;
}) {
  return new Elysia()
    .get("/api/dashboard/objects", async ({ request, query }) => {
      await authorizeOwner({ request });
      return json(await objects.catalog(query));
    })
    .post("/api/dashboard/objects", async ({ request }) => {
      const principal = await authorizeOwner({ request, mode: "json" });
      const result = await pages.create({
        input: createPageSchema.parse(await bodyJson(request)),
        principal,
      });
      return result.state === "found"
        ? json(result.page, 201)
        : problem("Page was not retained", 409, "write_conflict");
    });
}
