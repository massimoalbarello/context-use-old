import { Elysia } from "elysia";
import { ensureNangoOAuthClient } from "../../../auth.ts";
import { json } from "../../../http.ts";

export const AuthHealthController = new Elysia().get("/health", async () => {
  await ensureNangoOAuthClient();
  return json({ status: "ok", service: "auth" });
});
