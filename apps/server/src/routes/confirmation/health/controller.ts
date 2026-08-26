import { Elysia } from "elysia";
import { json } from "../../../http.ts";

export const ConfirmationHealthController = new Elysia().get("/health", () =>
  json({ status: "ok", service: "confirmation" }),
);
