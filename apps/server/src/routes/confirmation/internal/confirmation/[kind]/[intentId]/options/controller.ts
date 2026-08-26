import { Elysia } from "elysia";
import { z } from "zod";
import { json, problem } from "../../../../../../../http.ts";
import { hasInternalCapability } from "../../../../../../../internal-capability.ts";
import type { ConfirmationService } from "../../../../../../../services/confirmation-service.ts";
import { confirmationKindSchema } from "../../../../../model.ts";

export function createConfirmationOptionsController({
  dashboardToken,
  service,
}: {
  dashboardToken: string;
  service: ConfirmationService;
}) {
  return new Elysia().post(
    "/internal/confirmation/:kind/:intentId/options",
    async ({ request, params }) => {
      if (!hasInternalCapability(request, dashboardToken)) {
        return problem("Not found", 404, "not_found");
      }
      const options = await service.options({
        kind: confirmationKindSchema.parse(params.kind),
        intentId: z.string().uuid().parse(params.intentId),
      });
      return options
        ? json(options)
        : problem("Register a passkey before confirming", 409, "passkey_required");
    },
  );
}
