import { publicationIntentSchema } from "@context-use/shared";
import { Elysia } from "elysia";
import { z } from "zod";
import { bodyJson, json } from "../../../../../http.ts";
import type { DashboardPublicationService } from "../../../../../services/dashboard-publication-service.ts";
import type { AuthorizeOwner } from "../../../authorization.ts";

export function createPublicationIntentsController({
  authorizeOwner,
  service,
}: {
  authorizeOwner: AuthorizeOwner;
  service: DashboardPublicationService;
}) {
  return new Elysia()
    .post("/api/dashboard/publication-intents", async ({ request }) => {
      const principal = await authorizeOwner({ request, mode: "json" });
      const input = publicationIntentSchema.parse(await bodyJson(request));
      const suppliedIntentId = request.headers.get("x-publication-intent-id");
      const intentId =
        suppliedIntentId === null ? undefined : z.string().uuid().parse(suppliedIntentId);
      return json(
        await service.begin({
          input,
          principal,
          ...(intentId === undefined ? {} : { intentId }),
        }),
        201,
      );
    })
    .delete("/api/dashboard/publication-intents/:intentId", async ({ request, params }) => {
      const principal = await authorizeOwner({ request, mode: "json" });
      return json(
        await service.cancel({
          intentId: z.string().uuid().parse(params.intentId),
          principal,
        }),
      );
    });
}
