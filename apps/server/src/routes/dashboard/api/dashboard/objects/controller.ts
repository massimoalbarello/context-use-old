import { createPageSchema } from "@context-use/shared";
import { Elysia } from "elysia";
import { bodyJson, json, problem } from "../../../../../http.ts";
import type { DashboardObjectsService } from "../../../../../services/dashboard-objects-service.ts";
import type { DashboardPagesService } from "../../../../../services/dashboard-pages-service.ts";
import type { AuthorizeOwner } from "../../../authorization.ts";

export function createObjectsController({
  authorizeOwner,
  objects,
  pages,
}: {
  authorizeOwner: AuthorizeOwner;
  objects: DashboardObjectsService;
  pages: DashboardPagesService;
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
