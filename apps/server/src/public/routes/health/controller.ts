import { Elysia } from "elysia";
import { json } from "#http/responses.ts";

export function createPublicHealthController() {
  return new Elysia().get("/health", () => json({ status: "ok", service: "public" }));
}
