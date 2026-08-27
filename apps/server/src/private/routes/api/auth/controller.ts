import { Elysia } from "elysia";
import { json, problem } from "#http/responses.ts";
import type { AuthEngine } from "#private/auth/auth-engine.ts";
import { authPathRequiresOwnerSession } from "#private/auth/auth-engine.ts";
import type { OwnerAuthenticationBoundaryAuthorizer } from "#private/auth/owner-authentication-boundary.ts";
import { browserAuthRequest, bufferOAuthTokenRequestBody } from "#private/auth/owner-authorizer.ts";
import { whileOwnerAuthenticationLockHeld } from "#private/auth/passkey-policy.ts";
import { publicAuthRequestAllowed } from "#private/auth/protocol-policy.ts";
import { requireAuthenticationUserVerification } from "#private/auth/webauthn-policy.ts";

export function createAuthProtocolController({
  authEngine,
  authorizeOwnerAuthenticationRequest,
}: {
  authEngine: Pick<AuthEngine, "auth" | "dashboardPrincipal" | "ensureNangoOAuthClient">;
  authorizeOwnerAuthenticationRequest: OwnerAuthenticationBoundaryAuthorizer;
}) {
  return new Elysia().all("/api/auth/*", async ({ request }) => {
    if (!publicAuthRequestAllowed(request)) {
      return problem("Not found", 404, "not_found");
    }
    await authEngine.ensureNangoOAuthClient();
    let sanitized = browserAuthRequest({ request });
    const pathname = new URL(sanitized.url).pathname;

    if (pathname === "/api/auth/oauth2/token") {
      const buffered = await bufferOAuthTokenRequestBody(sanitized);
      if (buffered instanceof Response) {
        return buffered;
      }
      sanitized = buffered;
    }

    if (pathname === "/api/auth/get-session") {
      if (!(await authEngine.dashboardPrincipal(sanitized))) {
        return json(null);
      }
    } else if (pathname === "/api/auth/oauth2/authorize") {
      if (!(await authEngine.dashboardPrincipal(sanitized))) {
        return authEngine.auth.handler(
          browserAuthRequest({ request: sanitized, removeCookie: true }),
        );
      }
    } else if (
      authPathRequiresOwnerSession(pathname) &&
      !(await authEngine.dashboardPrincipal(sanitized))
    ) {
      return problem("Owner session required", 401, "owner_session_required");
    }

    const boundary = await authorizeOwnerAuthenticationRequest(sanitized);
    if (boundary.denied) {
      return boundary.denied;
    }
    return whileOwnerAuthenticationLockHeld(
      async () =>
        requireAuthenticationUserVerification({
          pathname,
          response: await authEngine.auth.handler(sanitized),
        }),
      boundary.release,
    );
  });
}
