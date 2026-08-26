import { Elysia } from "elysia";
import { config } from "./config.ts";
import { routeError } from "./http.ts";
import { createDashboardEdgeController } from "./routes/dashboard-edge/controller.ts";
import { securityHeaders } from "./security.ts";

// Caddy reaches only this credentialless process. The private dashboard
// authority remains responsible for owner-session, origin, CSRF, and streaming checks.
export const dashboardEdgeApp = new Elysia({
  serve: { maxRequestBodySize: 5_500_000_000 },
})
  .onError(({ error, code }) =>
    code === "NOT_FOUND"
      ? new Response("Not found", { status: 404, headers: securityHeaders })
      : routeError(error),
  )
  .use(createDashboardEdgeController(config.DASHBOARD_AUTHORITY_URL));
