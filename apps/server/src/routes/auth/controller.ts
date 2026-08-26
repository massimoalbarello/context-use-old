import { Elysia } from "elysia";
import type { AuthClientRepository } from "../../repositories/auth-client-repository.ts";
import type { AuthAuthorizationService } from "../../services/auth-authorization-service.ts";
import { AuthProtocolController } from "./api/auth/controller.ts";
import { createDashboardConfirmationController } from "./api/dashboard/confirmations/controller.ts";
import { createDashboardCsrfController } from "./api/dashboard/csrf/controller.ts";
import { createDashboardOAuthClientsController } from "./api/dashboard/oauth-clients/controller.ts";
import { createDashboardPasskeyController } from "./api/dashboard/passkeys/controller.ts";
import { createDashboardSessionController } from "./api/dashboard/session/controller.ts";
import type { AuthorizeAuthOwner } from "./boundary.ts";
import { AuthHealthController } from "./health/controller.ts";
import { createAuthorizeDashboardController } from "./internal/authorize-dashboard/controller.ts";
import { createAuthorizeMcpController } from "./internal/authorize-mcp/controller.ts";
import { createAuthorizeNangoController } from "./internal/authorize-nango/controller.ts";
import { createInternalJwksController } from "./internal/jwks/controller.ts";
import { AuthWellKnownController } from "./well-known/controller.ts";

export function createAuthController({
  appOrigin,
  authorizeOwner,
  authorization,
  clients,
  dashboardToken,
  mcpToken,
  nangoToken,
}: {
  appOrigin: string;
  authorizeOwner: AuthorizeAuthOwner;
  authorization: AuthAuthorizationService;
  clients: AuthClientRepository;
  dashboardToken: string;
  mcpToken: string;
  nangoToken: string;
}) {
  return new Elysia()
    .use(AuthHealthController)
    .use(AuthProtocolController)
    .use(AuthWellKnownController)
    .use(createAuthorizeDashboardController({ appOrigin, dashboardToken }))
    .use(createAuthorizeNangoController({ gatewayToken: nangoToken, service: authorization }))
    .use(createAuthorizeMcpController({ gatewayToken: mcpToken, service: authorization }))
    .use(createInternalJwksController({ appOrigin, mcpToken }))
    .use(createDashboardSessionController({ authorizeOwner, clients }))
    .use(createDashboardCsrfController({ authorizeOwner }))
    .use(createDashboardPasskeyController({ authorizeOwner }))
    .use(createDashboardConfirmationController({ authorizeOwner }))
    .use(createDashboardOAuthClientsController({ authorizeOwner, clients }));
}
