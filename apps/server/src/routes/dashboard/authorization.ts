import { authorizeDashboardRequest, type DashboardPrincipal } from "../../auth-client.ts";
import { requestMatchesOrigin, SecurityError } from "../../security.ts";

export type OwnerRequestMode = "read" | "json" | "upload";

export type AuthorizeOwner = (input: {
  request: Request;
  mode?: OwnerRequestMode;
}) => Promise<DashboardPrincipal>;

export function createOwnerAuthorizer({ appOrigin }: { appOrigin: string }): AuthorizeOwner {
  return async ({ request, mode = "read" }) => {
    if (!requestMatchesOrigin(request, appOrigin)) {
      throw new SecurityError("Not found", 404);
    }
    const principal = await authorizeDashboardRequest(request, mode);
    if (!principal) {
      throw new SecurityError("Dashboard session required", 401);
    }
    return principal;
  };
}
