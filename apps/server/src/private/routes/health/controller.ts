import { Elysia } from "elysia";
import { json } from "#http/responses.ts";
import type { AuthEngine } from "#private/auth/auth-engine.ts";

export function createAuthHealthController(authEngine: Pick<AuthEngine, "ensureNangoOAuthClient">) {
  return new Elysia().get("/health", async () => {
    await authEngine.ensureNangoOAuthClient();
    return json({ status: "ok", service: "private" });
  });
}
