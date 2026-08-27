import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { createPrivateApp } from "./app.ts";
import type { createAuthController } from "./auth/routes.ts";
import type { createDashboardController } from "./routes/api/dashboard/controller.ts";
import type { createMcpController } from "./routes/mcp/controller.ts";

const securityHeaders = { "x-content-type-options": "nosniff" };

function privateApp() {
  const auth = new Elysia().get("/api/auth/test", () => "auth") as unknown as ReturnType<
    typeof createAuthController
  >;
  const dashboard = new Elysia().get(
    "/api/dashboard/test",
    () => "dashboard",
  ) as unknown as ReturnType<typeof createDashboardController>;
  const mcp = new Elysia().get("/mcp/test", () => "mcp") as unknown as ReturnType<
    typeof createMcpController
  >;
  return createPrivateApp({ auth, dashboard, mcp, securityHeaders });
}

describe("private application boundary", () => {
  test("composes auth, dashboard, and MCP controllers in one application", async () => {
    const app = privateApp();
    for (const [path, body] of [
      ["/api/auth/test", "auth"],
      ["/api/dashboard/test", "dashboard"],
      ["/mcp/test", "mcp"],
    ] as const) {
      const response = await app.handle(new Request(`http://localhost${path}`));
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(body);
    }
  });

  test("does not expose the removed pairwise internal HTTP boundaries", async () => {
    const app = privateApp();
    for (const path of [
      "/internal/authorize-dashboard",
      "/internal/authorize-mcp",
      "/internal/browser-confirmation",
    ]) {
      const response = await app.handle(new Request(`http://localhost${path}`));
      expect(response.status).toBe(404);
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    }
  });
});
