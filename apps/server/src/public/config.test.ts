import { describe, expect, test } from "bun:test";
import { loadPublicConfig } from "./config.ts";

const valid = {
  NODE_ENV: "production",
  APP_ORIGIN: "https://context.example.com",
  ASSET_ORIGIN: "https://assets.context.example.com",
  PUBLIC_DATABASE_URL: "postgres://context_use_public:secret@postgres:5432/context_use",
  STORAGE_PUBLIC_TOKEN: "p".repeat(48),
};

describe("public process configuration", () => {
  test("accepts only the public database and storage capabilities", () => {
    expect(loadPublicConfig(valid).PUBLIC_DATABASE_URL).toContain("context_use_public");
  });

  test.each([
    "PRIVATE_DATABASE_URL",
    "STORAGE_DATABASE_URL",
    "STORAGE_PRIVATE_TOKEN",
    "BETTER_AUTH_SECRET",
    "AWS_CREDENTIALS_FILE",
  ])("rejects private capability %s", (name) => {
    expect(() => loadPublicConfig({ ...valid, [name]: "forbidden" })).toThrow();
  });
});
