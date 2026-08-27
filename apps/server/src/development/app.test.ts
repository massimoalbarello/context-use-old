import { describe, expect, test } from "bun:test";
import { createDevelopmentApp } from "./app.ts";

const application = (name: string) => ({
  handle: () => new Response(name),
});

describe("development application routing", () => {
  const app = createDevelopmentApp({
    privateApp: application("private"),
    publicApp: application("public"),
  });

  test.each(["/", "/p/page", "/a/asset", "/robots.txt", "/llms.txt"])(
    "routes the anonymous surface %s to the public application",
    async (path) => {
      const response = await app.handle(new Request(`http://localhost${path}`));
      expect(await response.text()).toBe("public");
    },
  );

  test.each(["/app", "/api/dashboard/pages", "/api/auth/session", "/mcp"])(
    "routes the protected surface %s to the private application",
    async (path) => {
      const response = await app.handle(new Request(`http://localhost${path}`));
      expect(await response.text()).toBe("private");
    },
  );
});
