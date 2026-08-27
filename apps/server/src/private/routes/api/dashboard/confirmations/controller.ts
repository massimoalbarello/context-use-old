import { Elysia } from "elysia";
import { bodyJson, json, problem } from "#http/responses.ts";
import type { AuthorizeAuthOwner } from "#private/auth/owner-authorizer.ts";
import type { ConfirmationService } from "#private/services/confirmation/confirmation-service.ts";
import { confirmationSchema } from "./model.ts";

export function createDashboardConfirmationController({
  authorizeOwner,
  service,
}: {
  authorizeOwner: AuthorizeAuthOwner;
  service: Pick<ConfirmationService, "confirm">;
}) {
  const forward = async ({
    request,
    kind,
  }: {
    request: Request;
    kind: "publication" | "page_deletion";
  }) => {
    const principal = await authorizeOwner({ request, mutation: true });
    const result = await service.confirm({
      kind,
      input: {
        principal: {
          owner_user_id: "context-use-owner",
          session_id: principal.sessionId,
        },
        confirmation: confirmationSchema.parse(await bodyJson(request)),
      },
    });
    switch (result.state) {
      case "confirmed":
        return json(result.body);
      case "not_found":
        return problem(result.message, 404, "not_found");
      case "inactive":
        return problem(result.message, 409, "intent_inactive");
      case "passkey_invalid":
        return problem("Passkey verification failed", 403, "passkey_invalid");
    }
  };
  return new Elysia()
    .post("/api/dashboard/publications/confirm", ({ request }) =>
      forward({ request, kind: "publication" }),
    )
    .post("/api/dashboard/page-deletions/confirm", ({ request }) =>
      forward({ request, kind: "page_deletion" }),
    );
}
