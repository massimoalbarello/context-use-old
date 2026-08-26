import { Elysia } from "elysia";
import {
  auth,
  authPathRequiresOwnerSession,
  dashboardPrincipal,
  ensureNangoOAuthClient,
} from "../../../../auth.ts";
import { publicAuthRequestAllowed } from "../../../../auth-protocol.ts";
import { json, problem } from "../../../../http.ts";
import { authorizeOwnerAuthenticationRequest } from "../../../../passkey-boundary.ts";
import { whileOwnerAuthenticationLockHeld } from "../../../../passkey-policy.ts";
import { requireAuthenticationUserVerification } from "../../../../webauthn-policy.ts";
import { browserAuthRequest, bufferOAuthTokenRequestBody } from "../../boundary.ts";

export const AuthProtocolController = new Elysia().all("/api/auth/*", async ({ request }) => {
  if (!publicAuthRequestAllowed(request)) {
    return problem("Not found", 404, "not_found");
  }
  await ensureNangoOAuthClient();
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
    if (!(await dashboardPrincipal(sanitized))) {
      return json(null);
    }
  } else if (pathname === "/api/auth/oauth2/authorize") {
    if (!(await dashboardPrincipal(sanitized))) {
      return auth.handler(browserAuthRequest({ request: sanitized, removeCookie: true }));
    }
  } else if (authPathRequiresOwnerSession(pathname) && !(await dashboardPrincipal(sanitized))) {
    return problem("Owner session required", 401, "owner_session_required");
  }

  const boundary = await authorizeOwnerAuthenticationRequest(sanitized);
  if (boundary.denied) {
    return boundary.denied;
  }
  return whileOwnerAuthenticationLockHeld(
    async () => requireAuthenticationUserVerification(pathname, await auth.handler(sanitized)),
    boundary.release,
  );
});
