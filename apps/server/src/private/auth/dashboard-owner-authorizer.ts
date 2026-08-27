import { requestMatchesOrigin } from "#http/request-origin.ts";
import { SecurityError } from "#http/security-error.ts";
import type { AuthEngine, DashboardPrincipal } from "#private/auth/auth-engine.ts";
import type { DashboardSecurity } from "#private/auth/dashboard-security.ts";

export type OwnerRequestMode = "read" | "json" | "upload";

export type AuthorizeOwner = (input: {
  request: Request;
  mode?: OwnerRequestMode;
}) => Promise<DashboardPrincipal>;

export function createOwnerAuthorizer({
  appOrigin,
  dashboardPrincipal,
  dashboardSecurity,
}: {
  appOrigin: string;
  dashboardPrincipal: AuthEngine["dashboardPrincipal"];
  dashboardSecurity: DashboardSecurity;
}): AuthorizeOwner {
  return async ({ request, mode = "read" }) => {
    if (!requestMatchesOrigin({ request, expectedOrigin: appOrigin })) {
      throw new SecurityError("Not found", 404);
    }
    const principal = await dashboardPrincipal(request);
    if (!principal) {
      throw new SecurityError("Dashboard session required", 401);
    }
    if (mode === "json") {
      dashboardSecurity.assertDashboardRequestSecurity({ request, principal });
    }
    if (mode === "upload") {
      dashboardSecurity.assertDashboardUploadSecurity({ request, principal });
    }
    return principal;
  };
}
