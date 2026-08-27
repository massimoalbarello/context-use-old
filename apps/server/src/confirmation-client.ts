import type { ConfirmationIntentKind } from "@context-use/database";
import { config } from "./config.ts";

export async function issueConfirmationOptions(
  kind: ConfirmationIntentKind,
  intentId: string,
): Promise<unknown> {
  const endpoint = config.CONFIRMATION_INTERNAL_URL;
  const internalRequest = new Request(`${endpoint}/internal/confirmation/${kind}/${encodeURIComponent(intentId)}/options`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.CONFIRMATION_DASHBOARD_TOKEN}`,
      "content-type": "application/json",
    },
    body: "{}",
  });
  const local = (globalThis as typeof globalThis & {
    __contextUseConfirmationHandler?: (request: Request) => Promise<Response> | Response;
  }).__contextUseConfirmationHandler;
  const response = local ? await local(internalRequest) : await fetch(internalRequest);
  if (!response.ok) throw new Error(`Confirmation service could not issue a challenge (${response.status})`);
  return response.json();
}
