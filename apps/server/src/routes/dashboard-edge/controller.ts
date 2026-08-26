import { Elysia } from "elysia";
import { json } from "../../http.ts";
import { forwardInternalRequest } from "../../internal-proxy.ts";
import { securityHeaders } from "../../security.ts";
import { disableStreamingRequestIdleTimeout } from "../../streaming-timeout.ts";

export function createDashboardEdgeController(authorityUrl: string) {
  const forward = (request: Request): Promise<Response> | Response => {
    if (!dashboardRequestAllowed(request)) {
      return new Response("Not found", { status: 404, headers: securityHeaders });
    }
    return forwardInternalRequest(request, authorityUrl, (headers) => {
      headers.delete("x-context-use-dashboard-gateway");
    });
  };
  return new Elysia()
    .get("/health", () => json({ status: "ok", service: "dashboard-edge" }))
    .all(
      "/api/dashboard/*",
      ({ request, server }) => {
        const pathname = new URL(request.url).pathname;
        if (
          request.method === "GET" &&
          /^\/api\/dashboard\/knowledge-bundles\/[^/]+\/download$/.test(pathname)
        ) {
          disableStreamingRequestIdleTimeout(server, request);
        }
        return forward(request);
      },
      { parse: "none" },
    )
    .all("/api/health", ({ request }) => forward(request), { parse: "none" })
    .all("/app", ({ request }) => forward(request), { parse: "none" })
    .all("/app/*", ({ request }) => forward(request), { parse: "none" })
    .all("/assets/*", ({ request }) => forward(request), { parse: "none" });
}

function dashboardRequestAllowed(request: Request): boolean {
  const { pathname } = new URL(request.url);
  if (pathname === "/api/health") {
    return request.method === "GET" || request.method === "HEAD";
  }
  if (pathname.startsWith("/api/dashboard/")) {
    return true;
  }
  if (pathname === "/app" || pathname.startsWith("/app/") || pathname.startsWith("/assets/")) {
    return request.method === "GET" || request.method === "HEAD";
  }
  return false;
}
