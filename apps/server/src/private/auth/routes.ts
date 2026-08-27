import { Elysia } from "elysia";
import type { Pool } from "pg";
import type { AuthEngine } from "#private/auth/auth-engine.ts";
import type { DashboardSecurity } from "#private/auth/dashboard-security.ts";
import { createOwnerAuthenticationBoundary } from "#private/auth/owner-authentication-boundary.ts";
import type { AuthorizeAuthOwner } from "#private/auth/owner-authorizer.ts";
import type { PasskeyManagementPolicy } from "#private/auth/passkey-management.ts";
import type { AuthClientRepository } from "#private/repositories/auth/client-repository.ts";
import type { AuthAuthorizationService } from "#private/services/auth/authorization-service.ts";
import type { ConfirmationService } from "#private/services/confirmation/confirmation-service.ts";
import { createAuthWellKnownController } from "../routes/.well-known/auth-controller.ts";
import { createAuthProtocolController } from "../routes/api/auth/controller.ts";
import { createDashboardConfirmationController } from "../routes/api/dashboard/confirmations/controller.ts";
import { createDashboardCsrfController } from "../routes/api/dashboard/csrf/controller.ts";
import { createDashboardOAuthClientsController } from "../routes/api/dashboard/oauth-clients/controller.ts";
import { createDashboardPasskeyController } from "../routes/api/dashboard/passkeys/controller.ts";
import { createDashboardSessionController } from "../routes/api/dashboard/session/controller.ts";
import { createAuthHealthController } from "../routes/health/controller.ts";
import { createAuthorizeNangoController } from "../routes/internal/authorize-nango/controller.ts";

export function createAuthController({
  authEngine,
  authorizeOwner,
  authorization,
  clients,
  confirmation,
  dashboardSecurity,
  nangoToken,
  passkeyPolicy,
  pool,
}: {
  authEngine: AuthEngine;
  authorizeOwner: AuthorizeAuthOwner;
  authorization: AuthAuthorizationService;
  clients: AuthClientRepository;
  confirmation: Pick<ConfirmationService, "confirm">;
  dashboardSecurity: DashboardSecurity;
  nangoToken: string;
  passkeyPolicy: PasskeyManagementPolicy;
  pool: Pool;
}) {
  const ownerAuthentication = createOwnerAuthenticationBoundary({
    pool,
    dashboardPrincipal: authEngine.dashboardPrincipal,
  });
  return new Elysia()
    .use(createAuthHealthController(authEngine))
    .use(
      createAuthProtocolController({
        authEngine,
        authorizeOwnerAuthenticationRequest: ownerAuthentication,
      }),
    )
    .use(createAuthWellKnownController(authEngine))
    .use(createAuthorizeNangoController({ gatewayToken: nangoToken, service: authorization }))
    .use(createDashboardSessionController({ authorizeOwner, clients }))
    .use(
      createDashboardCsrfController({
        authorizeOwner,
        csrfToken: dashboardSecurity.csrfToken,
      }),
    )
    .use(createDashboardPasskeyController({ authorizeOwner, passkeyPolicy, pool }))
    .use(createDashboardConfirmationController({ authorizeOwner, service: confirmation }))
    .use(createDashboardOAuthClientsController({ authorizeOwner, clients }));
}
