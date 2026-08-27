import { Elysia } from "elysia";
import { routeError } from "#http/responses.ts";
import type { createPublicController } from "./routes/controller.ts";

export function createPublicApp({
  routes,
  securityHeaders,
}: {
  routes: ReturnType<typeof createPublicController>;
  securityHeaders: Record<string, string>;
}) {
  return new Elysia({ strictPath: true })
    .onError(({ error, code }) =>
      code === "NOT_FOUND"
        ? new Response("Not found", { status: 404, headers: securityHeaders })
        : routeError(error),
    )
    .use(routes);
}

export type PublicApp = ReturnType<typeof createPublicApp>;
