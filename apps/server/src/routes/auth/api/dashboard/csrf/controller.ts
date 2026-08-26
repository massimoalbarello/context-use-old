import { Elysia } from "elysia";
import { json } from "../../../../../http.ts";
import { csrfToken } from "../../../../../security.ts";
import type { AuthorizeAuthOwner } from "../../../boundary.ts";

export function createDashboardCsrfController({
  authorizeOwner,
}: {
  authorizeOwner: AuthorizeAuthOwner;
}) {
  return new Elysia().get("/api/dashboard/csrf", async ({ request }) => {
    const principal = await authorizeOwner({ request });
    return json({ csrf_token: csrfToken(principal) });
  });
}
