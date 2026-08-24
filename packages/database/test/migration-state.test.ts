import { describe, expect, test } from "bun:test";
import {
  assertMigrationState,
  configuredExistingRolePasswords,
} from "../src/migration-state.ts";

const files = [
  { version: "001_baseline.sql", checksum: "baseline-checksum" },
  { version: "002_normalize.sql", checksum: "forward-checksum" },
];

describe("forward migration state", () => {
  test("accepts a fresh database and an exactly matching applied prefix", () => {
    expect(() => assertMigrationState(files, [], [])).not.toThrow();
    expect(() => assertMigrationState(files, [
      { version: "001_baseline.sql", checksum: "baseline-checksum" },
    ], ["knowledge_pages"])).not.toThrow();
    expect(() => assertMigrationState(files, [
      { version: "001_baseline.sql", checksum: "baseline-checksum" },
      { version: "002_normalize.sql", checksum: "forward-checksum" },
    ], ["knowledge_pages"])).not.toThrow();
  });

  test("fails closed for an unrecognized migration", () => {
    expect(() => assertMigrationState(files, [
      { version: "001_baseline.sql", checksum: "baseline-checksum" },
      { version: "002_unknown.sql", checksum: "unknown-checksum" },
    ], ["knowledge_pages"])).toThrow("not part of this schema");
  });

  test("fails closed for an old or modified baseline", () => {
    expect(() => assertMigrationState(files, [
      { version: "001_baseline.sql", checksum: null },
    ], ["knowledge_pages"])).toThrow("no recorded checksum");
    expect(() => assertMigrationState(files, [
      { version: "001_baseline.sql", checksum: "old-checksum" },
    ], ["knowledge_pages"])).toThrow("does not match this release");
  });

  test("does not baseline over untracked relations", () => {
    expect(() => assertMigrationState(files, [], ["knowledge_pages"]))
      .toThrow("can only be applied to a fresh database");
  });
});

describe("role password configuration", () => {
  test("skips a configured role below its introducing migration", () => {
    expect(configuredExistingRolePasswords({
      DB_DASHBOARD_PASSWORD: "dashboard-secret",
      DB_CORPUS_PASSWORD: "corpus-secret",
    }, ["context_use_dashboard"])).toEqual([{
      role: "context_use_dashboard",
      password: "dashboard-secret",
    }]);
  });

  test("configures the later role once its migration has created it", () => {
    expect(configuredExistingRolePasswords(
      { DB_CORPUS_PASSWORD: "corpus-secret" },
      ["context_use_dashboard", "context_use_corpus"],
    )).toEqual([{ role: "context_use_corpus", password: "corpus-secret" }]);
  });
});
