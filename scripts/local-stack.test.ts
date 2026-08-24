import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  LOCAL_STACK,
  composeArguments,
  setupUrl,
  stackUrl,
  stackVolumeName,
} from "./local-stack.ts";

describe("local stack commands", () => {
  test("uses one local application and database", () => {
    expect(LOCAL_STACK).toEqual({
      project: "context-use-dev",
      database: "context_use",
      url: "http://localhost:5173",
    });
    expect(stackUrl()).toBe("http://localhost:5173");
    expect(setupUrl()).toContain("/app#setup=development-owner-setup-token-");
  });

  test("only purge removes the local Compose project volumes", () => {
    expect(composeArguments("purge")).toEqual([
      "compose",
      "--project-name",
      "context-use-dev",
      "down",
      "--volumes",
      "--remove-orphans",
    ]);
    expect(composeArguments("down")).not.toContain("--volumes");
    expect(stackVolumeName("minio-data")).toBe("context-use-dev_minio-data");
  });

  test("development compose can receive an eval-selected template", () => {
    const compose = readFileSync(join(import.meta.dir, "..", "compose.dev.yml"), "utf8");
    expect(compose).toContain("CONTEXT_USE_TEMPLATE_INSTALL: ${CONTEXT_USE_TEMPLATE_INSTALL:-default}");
    expect(compose).toContain(
      "CONTEXT_USE_DEVELOPMENT_TEMPLATE_ROOT: ${CONTEXT_USE_DEVELOPMENT_TEMPLATE_ROOT:-}",
    );
    expect(compose).toContain("S3_ENDPOINT: http://minio:9000");
    expect(compose).not.toContain("STORAGE_DRIVER");
    expect(compose).not.toContain("STORAGE_PATH");
  });
});
