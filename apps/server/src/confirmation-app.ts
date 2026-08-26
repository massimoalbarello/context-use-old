import { ConfirmationRepository, createPool } from "@context-use/database";
import { Elysia } from "elysia";
import { config } from "./config.ts";
import { routeError } from "./http.ts";
import { createConfirmationController } from "./routes/confirmation/controller.ts";
import { securityHeaders } from "./security.ts";
import { ConfirmationService } from "./services/confirmation-service.ts";

const pool = createPool(config.CONFIRMATION_DATABASE_URL, {
  application_name: "context-use-confirmation",
});
const service = new ConfirmationService({
  confirmations: new ConfirmationRepository(pool),
  appOrigin: config.APP_ORIGIN,
  rpId: config.WEBAUTHN_RP_ID,
});

export const confirmationApp = new Elysia()
  .onError(({ error, code }) =>
    code === "NOT_FOUND"
      ? new Response("Not found", { status: 404, headers: securityHeaders })
      : routeError(error),
  )
  .use(
    createConfirmationController({
      dashboardToken: config.CONFIRMATION_DASHBOARD_TOKEN,
      gatewayToken: config.CONFIRMATION_GATEWAY_TOKEN,
      service,
    }),
  );
