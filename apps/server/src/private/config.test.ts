import { describe, expect, test } from "bun:test";
import { loadPrivateConfig } from "./config.ts";

const valid = {
  NODE_ENV: "production",
  APP_ORIGIN: "https://context.example.com",
  ASSET_ORIGIN: "https://assets.context.example.com",
  PRIVATE_DATABASE_URL: "postgres://context_use_private:secret@postgres:5432/context_use",
  OWNER_EMAIL: "owner@context.example.com",
  OWNER_SETUP_TOKEN_HASH: "a".repeat(64),
  BETTER_AUTH_SECRET: "a".repeat(48),
  MCP_ASSET_CAPABILITY_SECRET: "b".repeat(48),
  OAUTH_ISSUER: "https://context.example.com",
  MCP_RESOURCE: "https://context.example.com/mcp",
  WEBAUTHN_RP_ID: "context.example.com",
  STORAGE_PRIVATE_TOKEN: "c".repeat(48),
  NANGO_ORIGIN: "https://nango.context.example.com",
  NANGO_OAUTH_CLIENT_SECRET: "d".repeat(48),
  AUTH_NANGO_TOKEN: "e".repeat(48),
  NANGO_INTERNAL_URL: "http://nango-server:3003",
};

describe("private process configuration", () => {
  test("accepts the single private database role and private storage capability", () => {
    expect(loadPrivateConfig(valid).PRIVATE_DATABASE_URL).toContain("context_use_private");
  });

  test.each([
    "PUBLIC_DATABASE_URL",
    "STORAGE_DATABASE_URL",
    "STORAGE_PUBLIC_TOKEN",
    "AWS_CREDENTIALS_FILE",
    "AUTH_INTERNAL_URL",
    "CONFIRMATION_INTERNAL_URL",
    "AUTH_DASHBOARD_TOKEN",
    "STORAGE_MCP_TOKEN",
  ])("rejects foreign or obsolete variable %s", (name) => {
    expect(() => loadPrivateConfig({ ...valid, [name]: "forbidden" })).toThrow();
  });
});
