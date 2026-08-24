import { describe, expect, test } from "bun:test";
import {
  FILESYSTEM_DEPRECATION_AUDIT_ALLOWANCES,
  auditFilesystemDeprecation,
} from "./filesystem-deprecation-audit.ts";

describe("filesystem deprecation closure audit", () => {
  test("keeps retired runtime identifiers out of the live source scope", () => {
    expect(auditFilesystemDeprecation()).toEqual([]);
  });

  test("keeps intentional public and local path surfaces explicitly allowed", () => {
    expect(FILESYSTEM_DEPRECATION_AUDIT_ALLOWANCES).toEqual([
      "legacy public aliases and their HTTP route paths",
      "UUID public routes",
      "local configuration and cache paths",
      "Unix sockets and agent-sync directories",
      "XFS data-volume discovery and mounting",
      "negative regression tests for removed APIs",
    ]);
  });
});
