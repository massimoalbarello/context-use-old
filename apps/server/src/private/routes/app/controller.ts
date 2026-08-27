import { Elysia } from "elysia";
import { problem } from "#http/responses.ts";
import type { DashboardWebService } from "#private/services/dashboard/web-service.ts";

function htmlResponse(file: Bun.BunFile, securityHeaders: Record<string, string>): Response {
  return new Response(file, {
    headers: { ...securityHeaders, "content-type": "text/html; charset=utf-8" },
  });
}

export function createDashboardWebController({
  service,
  securityHeaders,
}: {
  service: DashboardWebService;
  securityHeaders: Record<string, string>;
}) {
  const index = async () => {
    const file = await service.file("index.html");
    return file ? htmlResponse(file, securityHeaders) : problem("Dashboard build not found", 503);
  };

  return new Elysia()
    .get("/app", index)
    .get("/app/*", index)
    .get("/assets/*", async ({ params }) => {
      const path = params["*"];
      const file = typeof path === "string" ? await service.file(`assets/${path}`) : null;
      if (!file) {
        return new Response("Not found", { status: 404, headers: securityHeaders });
      }
      return new Response(file, {
        headers: {
          ...securityHeaders,
          "cache-control": "public, max-age=31536000, immutable",
        },
      });
    });
}
