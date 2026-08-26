import { describe, expect, test } from "bun:test";
import { createCombinedApp } from "./combined-app-router.ts";

function application(name: string) {
  return {
    handle() {
      return new Response(null, { headers: { "x-test-application": name } });
    },
  };
}

describe("combined application router", () => {
  test("keeps public protocols out of the private dashboard fallback", async () => {
    const combined = createCombinedApp({
      auth: application("auth"),
      dashboard: application("dashboard"),
      mcp: application("mcp"),
      publicWeb: application("public"),
    });
    const expectations = [
      ["/api/auth/get-session", "auth"],
      ["/.well-known/openid-configuration", "auth"],
      ["/mcp", "mcp"],
      ["/.well-known/oauth-protected-resource/mcp", "mcp"],
      ["/", "public"],
      ["/p/example", "public"],
      ["/a/example", "public"],
      ["/api/dashboard/session", "dashboard"],
      ["/app", "dashboard"],
    ] as const;

    for (const [path, expected] of expectations) {
      const response = await combined.handle(new Request(`https://context.example${path}`));
      expect(response.headers.get("x-test-application"), path).toBe(expected);
    }
  });
});
