import { Elysia } from "elysia";
import { json } from "#http/responses.ts";
import type { DashboardSecurity } from "#private/auth/dashboard-security.ts";
import type { AuthorizeAuthOwner } from "#private/auth/owner-authorizer.ts";

export function createDashboardCsrfController({
  authorizeOwner,
  csrfToken,
}: {
  authorizeOwner: AuthorizeAuthOwner;
  csrfToken: DashboardSecurity["csrfToken"];
}) {
  return new Elysia().get("/api/dashboard/csrf", async ({ request }) => {
    const principal = await authorizeOwner({ request });
    return json({ csrf_token: csrfToken(principal) });
  });
}
