import { dashboardPrincipal } from "../../auth.ts";
import type { DashboardPrincipal } from "../../auth-client.ts";
import { dashboardGatewayHeader } from "../../auth-dashboard-gateway.ts";
import { hasHeaderCapability } from "../../internal-capability.ts";
import {
  assertDashboardRequestSecurity,
  requestMatchesOrigin,
  SecurityError,
} from "../../security.ts";

export type AuthorizeAuthOwner = (input: {
  request: Request;
  mutation?: boolean;
}) => Promise<DashboardPrincipal>;

export function createAuthOwnerAuthorizer({
  appOrigin,
  dashboardToken,
  isolated,
}: {
  appOrigin: string;
  dashboardToken: string;
  isolated: boolean;
}): AuthorizeAuthOwner {
  return async ({ request, mutation = false }) => {
    const fromDashboard = hasHeaderCapability(request, dashboardGatewayHeader, dashboardToken);
    if (isolated && !fromDashboard) {
      throw new SecurityError("Not found", 404);
    }
    const browserRequest = fromDashboard
      ? new Request(
          new URL(`${new URL(request.url).pathname}${new URL(request.url).search}`, appOrigin),
          { method: request.method, headers: request.headers },
        )
      : request;
    if (!requestMatchesOrigin(browserRequest, appOrigin)) {
      throw new SecurityError("Not found", 404);
    }
    const principal = await dashboardPrincipal(browserRequest);
    if (!principal) {
      throw new SecurityError("Dashboard session required", 401);
    }
    if (mutation) {
      assertDashboardRequestSecurity(browserRequest, principal);
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
