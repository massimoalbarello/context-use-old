import { Elysia } from "elysia";
import type { ConfirmationService } from "../../services/confirmation-service.ts";
import { ConfirmationHealthController } from "./health/controller.ts";
import { createBrowserConfirmationController } from "./internal/browser-confirmation/controller.ts";
import { createConfirmationOptionsController } from "./internal/confirmation/[kind]/[intentId]/options/controller.ts";

export function createConfirmationController({
  dashboardToken,
  gatewayToken,
  service,
}: {
  dashboardToken: string;
  gatewayToken: string;
  service: ConfirmationService;
}) {
  return new Elysia()
    .use(ConfirmationHealthController)
    .use(createConfirmationOptionsController({ dashboardToken, service }))
    .use(createBrowserConfirmationController({ gatewayToken, service }));
}
