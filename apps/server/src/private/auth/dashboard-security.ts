import { createHmac, timingSafeEqual } from "node:crypto";
import { SecurityError } from "#http/security-error.ts";
import type { DashboardPrincipal } from "./auth-engine.ts";

const mutatingMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function createDashboardSecurity({
  appOrigin,
  csrfSecret,
}: {
  appOrigin: string;
  csrfSecret: string;
}) {
  const csrfToken = (principal: DashboardPrincipal): string =>
    createHmac("sha256", csrfSecret)
      .update(`dashboard-csrf\0${principal.sessionId}\0${principal.userId}`)
      .digest("base64url");

  const assertMutationSource = ({
    request,
    principal,
  }: {
    request: Request;
    principal: DashboardPrincipal;
  }): void => {
    if (request.headers.get("origin") !== appOrigin) {
      throw new SecurityError("Untrusted origin", 403);
    }
    if (request.headers.get("sec-fetch-site") !== "same-origin") {
      throw new SecurityError("Missing or cross-site Fetch Metadata", 403);
    }
    const supplied = request.headers.get("x-csrf-token") ?? "";
    if (!constantTimeTextEqual({ left: supplied, right: csrfToken(principal) })) {
      throw new SecurityError("Invalid CSRF token", 403);
    }
  };

  return {
    csrfToken,
    assertDashboardRequestSecurity({
      request,
      principal,
    }: {
      request: Request;
      principal: DashboardPrincipal;
    }): void {
      if (!mutatingMethods.has(request.method)) {
        return;
      }
      assertMutationSource({ request, principal });
      if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
        throw new SecurityError("JSON content type required", 415);
      }
    },
    assertDashboardUploadSecurity({
      request,
      principal,
    }: {
      request: Request;
      principal: DashboardPrincipal;
    }): void {
      assertMutationSource({ request, principal });
    },
  };
}

function constantTimeTextEqual({ left, right }: { left: string; right: string }): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export type DashboardSecurity = ReturnType<typeof createDashboardSecurity>;
