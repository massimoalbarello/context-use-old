import { Elysia } from "elysia";
import { hasHeaderCapability } from "#http/header-capability.ts";
import { apiSecurityHeaders, problem } from "#http/responses.ts";
import { bearerAccessToken } from "#private/auth/owner-authorizer.ts";
import type { AuthAuthorizationService } from "#private/services/auth/authorization-service.ts";

export const nangoGatewayHeader = "x-context-use-nango-gateway";

export function createAuthorizeNangoController({
  gatewayToken,
  service,
}: {
  gatewayToken: string;
  service: AuthAuthorizationService;
}) {
  return new Elysia().get("/internal/authorize-nango", async ({ request }) => {
    if (!hasHeaderCapability(request, nangoGatewayHeader, gatewayToken)) {
      return problem("Not found", 404, "not_found");
    }
    const token = bearerAccessToken(request);
    if (!token) {
      return problem("Authorization required", 401, "unauthorized");
    }
    const result = await service.authorizeNango(token);
    if (result.state === "unavailable") {
      return problem("Authorization unavailable", 503, "authorization_unavailable");
    }
    return result.state === "authorized"
      ? new Response(null, { status: 204, headers: apiSecurityHeaders })
      : problem("Authorization required", 401, "unauthorized");
  });
}
