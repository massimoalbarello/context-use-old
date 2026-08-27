import { Elysia } from "elysia";
import { routeError } from "#http/responses.ts";
import type { createAuthController } from "./auth/routes.ts";
import type { createDashboardController } from "./routes/api/dashboard/controller.ts";
import type { createMcpController } from "./routes/mcp/controller.ts";

export function createPrivateApp({
  auth,
  dashboard,
  mcp,
  securityHeaders,
}: {
  auth: ReturnType<typeof createAuthController>;
  dashboard: ReturnType<typeof createDashboardController>;
  mcp: ReturnType<typeof createMcpController>;
  securityHeaders: Record<string, string>;
}) {
  return new Elysia({ serve: { maxRequestBodySize: 5_500_000_000 } })
    .onError(({ error, code }) =>
      code === "NOT_FOUND"
        ? new Response("Not found", { status: 404, headers: securityHeaders })
        : routeError(error),
    )
    .use(auth)
    .use(dashboard)
    .use(mcp);
}

export type PrivateApp = ReturnType<typeof createPrivateApp>;
