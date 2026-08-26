import { Elysia } from "elysia";
import { authPool } from "./auth.ts";
import { config, production } from "./config.ts";
import { routeError } from "./http.ts";
import { AuthClientRepository } from "./repositories/auth-client-repository.ts";
import { createAuthOwnerAuthorizer } from "./routes/auth/boundary.ts";
import { createAuthController } from "./routes/auth/controller.ts";
import { securityHeaders } from "./security.ts";
import { AuthAuthorizationService } from "./services/auth-authorization-service.ts";

export { nangoGatewayHeader } from "./routes/auth/internal/authorize-nango/controller.ts";

const clients = new AuthClientRepository(authPool);
const authorization = new AuthAuthorizationService({
  clients,
  issuer: config.OAUTH_ISSUER,
  mcpResource: config.MCP_RESOURCE,
  nangoClientId: config.NANGO_OAUTH_CLIENT_ID,
  nangoClientSecret: config.NANGO_OAUTH_CLIENT_SECRET,
  appOrigin: config.APP_ORIGIN,
});
const authorizeOwner = createAuthOwnerAuthorizer({
  appOrigin: config.APP_ORIGIN,
  dashboardToken: config.AUTH_DASHBOARD_TOKEN,
  isolated: production && config.SERVICE_MODE === "auth",
});

export const authApp = new Elysia()
  .onError(({ error, code }) =>
    code === "NOT_FOUND"
      ? new Response("Not found", { status: 404, headers: securityHeaders })
      : routeError(error),
  )
  .use(
    createAuthController({
      appOrigin: config.APP_ORIGIN,
      authorizeOwner,
      authorization,
      clients,
      dashboardToken: config.AUTH_DASHBOARD_TOKEN,
      mcpToken: config.AUTH_MCP_TOKEN,
      nangoToken: config.AUTH_NANGO_TOKEN,
    }),
  );
