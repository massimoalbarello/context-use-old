import { requestMatchesOrigin } from "#http/request-origin.ts";
import { SecurityError } from "#http/security-error.ts";
import type { AuthEngine, DashboardPrincipal } from "#private/auth/auth-engine.ts";
import type { DashboardSecurity } from "#private/auth/dashboard-security.ts";

export type AuthorizeAuthOwner = (input: {
  request: Request;
  mutation?: boolean;
}) => Promise<DashboardPrincipal>;

export function createAuthOwnerAuthorizer({
  appOrigin,
  dashboardPrincipal,
  dashboardSecurity,
}: {
  appOrigin: string;
  dashboardPrincipal: AuthEngine["dashboardPrincipal"];
  dashboardSecurity: DashboardSecurity;
}): AuthorizeAuthOwner {
  return async ({ request, mutation = false }) => {
    if (!requestMatchesOrigin({ request, expectedOrigin: appOrigin })) {
      throw new SecurityError("Not found", 404);
    }
    const principal = await dashboardPrincipal(request);
    if (!principal) {
      throw new SecurityError("Dashboard session required", 401);
    }
    if (mutation) {
      dashboardSecurity.assertDashboardRequestSecurity({ request, principal });
    }
    return principal;
  };
}

export function browserAuthRequest({
  request,
  removeCookie = false,
}: {
  request: Request;
  removeCookie?: boolean;
}): Request {
  const headers = new Headers(request.headers);
  if (removeCookie) {
    headers.delete("cookie");
  }
  return new Request(request.url, {
    method: request.method,
    headers,
    body: request.body,
    signal: request.signal,
  });
}

const oauthTokenRequestBodyLimit = 64 * 1024;

export async function bufferOAuthTokenRequestBody(request: Request): Promise<Request | Response> {
  const declaredLength = request.headers.get("content-length");
  if (
    declaredLength !== null &&
    (!/^\d+$/.test(declaredLength) || Number(declaredLength) > oauthTokenRequestBodyLimit)
  ) {
    return oauthTokenRequestError({ description: "request body is too large", status: 413 });
  }
  try {
    const body = await request.arrayBuffer();
    if (body.byteLength > oauthTokenRequestBodyLimit) {
      return oauthTokenRequestError({ description: "request body is too large", status: 413 });
    }
    return new Request(request.url, {
      method: request.method,
      headers: request.headers,
      body,
      signal: request.signal,
    });
  } catch {
    return oauthTokenRequestError({ description: "request body could not be read", status: 400 });
  }
}

export function bearerAccessToken(request: Request): string | null {
  return (
    request.headers.get("authorization")?.match(/^Bearer ([A-Za-z0-9._~-]{32,8192})$/)?.[1] ?? null
  );
}

function oauthTokenRequestError({
  description,
  status,
}: {
  description: string;
  status: number;
}): Response {
  return Response.json(
    { error: "invalid_request", error_description: description },
    { status, headers: { "cache-control": "no-store", pragma: "no-cache" } },
  );
}
