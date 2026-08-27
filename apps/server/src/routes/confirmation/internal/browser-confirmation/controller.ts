import { Elysia } from "elysia";
import { bodyJson, json, problem } from "../../../../http.ts";
import { hasInternalCapability } from "../../../../internal-capability.ts";
import type {
  BrowserConfirmationKind,
  ConfirmationService,
} from "../../../../services/confirmation-service.ts";
import { browserConfirmationSchema } from "../../model.ts";

export function createBrowserConfirmationController({
  gatewayToken,
  service,
}: {
  gatewayToken: string;
  service: ConfirmationService;
}) {
  const confirm = async ({
    request,
    kind,
  }: {
    request: Request;
    kind: BrowserConfirmationKind;
  }) => {
    if (!hasInternalCapability(request, gatewayToken)) {
      return problem("Not found", 404, "not_found");
    }
    const result = await service.confirm({
      kind,
      input: browserConfirmationSchema.parse(await bodyJson(request)),
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
    .post("/internal/browser-confirmation/publication", ({ request }) =>
      confirm({ request, kind: "publication" }),
    )
    .post("/internal/browser-confirmation/page_deletion", ({ request }) =>
      confirm({ request, kind: "page_deletion" }),
    );
}
