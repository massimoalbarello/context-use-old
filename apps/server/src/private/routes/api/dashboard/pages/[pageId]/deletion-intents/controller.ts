import { Elysia } from "elysia";
import { z } from "zod";
import { bodyJson, json, problem } from "#http/responses.ts";
import type { AuthorizeOwner } from "#private/auth/dashboard-owner-authorizer.ts";
import type { PageDeletionService } from "#private/services/dashboard/page-deletion-service.ts";

const emptyObjectSchema = z.object({}).strict();

export function createPageDeletionIntentsController({
  authorizeOwner,
  service,
}: {
  authorizeOwner: AuthorizeOwner;
  service: PageDeletionService;
}) {
  return new Elysia().post(
    "/api/dashboard/pages/:pageId/deletion-intents",
    async ({ request, params }) => {
      const principal = await authorizeOwner({ request, mode: "json" });
      emptyObjectSchema.parse(await bodyJson(request));
      const result = await service.createIntent({
        pageId: z.string().uuid().parse(params.pageId),
        principal,
      });
      if (result.state === "not_found") {
        return problem("Page not found", 404, "not_found");
      }
      if (result.state === "not_deletable") {
        return problem(
          "Only archived, unpublished pages can be permanently deleted",
          409,
          "page_not_deletable",
        );
      }
      return json(
        { intent: result.intent, authentication_options: result.authentication_options },
        201,
      );
    },
  );
}
