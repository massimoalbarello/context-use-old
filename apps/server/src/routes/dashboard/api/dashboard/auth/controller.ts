import { Elysia } from "elysia";
import { forwardDashboardAuthRoute } from "../../../../../auth-dashboard-gateway.ts";

export const DashboardAuthController = new Elysia()
  .get("/api/dashboard/session", ({ request }) => forwardDashboardAuthRoute(request))
  .get("/api/dashboard/csrf", ({ request }) => forwardDashboardAuthRoute(request))
  .post(
    "/api/dashboard/passkey-enrollment-intents",
    ({ request }) => forwardDashboardAuthRoute(request),
    { parse: "none" },
  )
  .post(
    "/api/dashboard/passkey-enrollment-intents/:intentId/confirm",
    ({ request }) => forwardDashboardAuthRoute(request),
    { parse: "none" },
  )
  .post(
    "/api/dashboard/passkeys/:passkeyId/removal-intents",
    ({ request }) => forwardDashboardAuthRoute(request),
    { parse: "none" },
  )
  .post(
    "/api/dashboard/passkeys/:passkeyId/remove",
    ({ request }) => forwardDashboardAuthRoute(request),
    { parse: "none" },
  )
  .post(
    "/api/dashboard/publications/confirm",
    ({ request }) => forwardDashboardAuthRoute(request),
    { parse: "none" },
  )
  .post(
    "/api/dashboard/page-deletions/confirm",
    ({ request }) => forwardDashboardAuthRoute(request),
    { parse: "none" },
  )
  .get("/api/dashboard/private-mcp-clients", ({ request }) => forwardDashboardAuthRoute(request))
  .get("/api/dashboard/oauth-client-preview", ({ request }) => forwardDashboardAuthRoute(request))
  .delete("/api/dashboard/oauth-clients/:clientId", ({ request }) =>
    forwardDashboardAuthRoute(request),
  );
