import { describe, expect, test } from "bun:test";
import { loadStorageConfig } from "./config.ts";

const valid = {
  NODE_ENV: "production",
  STORAGE_DATABASE_URL: "postgres://context_use_storage:secret@postgres:5432/context_use",
  STORAGE_PRIVATE_TOKEN: "s".repeat(48),
  STORAGE_PUBLIC_TOKEN: "t".repeat(48),
  AWS_CREDENTIALS_FILE: "/run/context-use-aws-storage/credentials.json",
  AWS_EC2_METADATA_DISABLED: "true",
  ASSET_BUCKET: "context-use-assets",
  KMS_KEY_ID: "arn:aws:kms:eu-west-2:123456789012:key/test",
};

describe("storage process configuration", () => {
  test("accepts the storage database role and two distinct broker capabilities", () => {
    const config = loadStorageConfig(valid);
    expect(config.STORAGE_DATABASE_URL).toContain("context_use_storage");
    expect(config.STORAGE_PRIVATE_TOKEN).not.toBe(config.STORAGE_PUBLIC_TOKEN);
  });

  test.each([
    "PRIVATE_DATABASE_URL",
    "PUBLIC_DATABASE_URL",
    "BETTER_AUTH_SECRET",
    "AWS_ACCESS_KEY_ID",
  ])("rejects application capability %s", (name) => {
    expect(() => loadStorageConfig({ ...valid, [name]: "forbidden" })).toThrow();
  });
});
