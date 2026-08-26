import { archivePageSchema } from "@context-use/shared";
import { Elysia } from "elysia";
import { z } from "zod";
import { bodyJson, json, problem } from "../../../../../../../http.ts";
import type { DashboardPagesService } from "../../../../../../../services/dashboard-pages-service.ts";
import type { AuthorizeOwner } from "../../../../../authorization.ts";

export function createPageArchiveController({
  authorizeOwner,
  service,
}: {
  authorizeOwner: AuthorizeOwner;
  service: DashboardPagesService;
}) {
  return new Elysia().post("/api/dashboard/pages/:pageId/archive", async ({ request, params }) => {
    const principal = await authorizeOwner({ request, mode: "json" });
    const result = await service.archive({
      pageId: z.string().uuid().parse(params.pageId),
      input: archivePageSchema.parse(await bodyJson(request)),
      principal,
    });
    if (result.state === "not_found") {
      return problem("Page not found", 404, "not_found");
    }
    return result.state === "found"
      ? json(result.page)
      : problem("Page archive was not retained", 409, "write_conflict");
  });
}
