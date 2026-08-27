import { Elysia } from "elysia";

export const StorageHealthController = new Elysia().get("/health", () => ({ status: "ok" }));
