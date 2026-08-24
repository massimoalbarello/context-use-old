import { describe, expect, test } from "bun:test";
import {
  assertMigrationState,
  configuredExistingRolePasswords,
  matchesCompletedLedger,
  migrationLedgerDigest,
} from "../src/migration-state.ts";

const files = [{ version: "001_baseline.sql", checksum: "current-checksum" }];

describe("completed ledger handoff", () => {
  const completed = [
    { version: "001", checksum: "a" },
    { version: "002", checksum: "b" },
  ];
  const digest = "b51efc7b2797fc57025dc13d80ac5390cea1936cb5ae15d46707560ce3a8efca";

  test("hashes the ordered version and checksum pairs deterministically", () => {
    expect(migrationLedgerDigest(completed)).toBe(digest);
    expect(migrationLedgerDigest([...completed].reverse())).toBe(digest);
    expect(migrationLedgerDigest([{ version: "001", checksum: null }])).toBeNull();
  });

  test("requires the exact completed count and digest", () => {
    expect(matchesCompletedLedger(completed, { count: 2, digest })).toBe(true);
    expect(matchesCompletedLedger(completed.slice(0, 1), { count: 2, digest })).toBe(false);
    expect(matchesCompletedLedger([
      completed[0]!,
      { version: "002", checksum: "modified" },
    ], { count: 2, digest })).toBe(false);
  });
});

describe("flattened migration state", () => {
  test("accepts a fresh database and an exactly matching baseline", () => {
    expect(() => assertMigrationState(files, [], [])).not.toThrow();
    expect(() => assertMigrationState(files, [
      { version: "001_baseline.sql", checksum: "current-checksum" },
    ], ["knowledge_pages"])).not.toThrow();
  });

  test("fails closed for an unrecognized ledger", () => {
    expect(() => assertMigrationState(files, [
      { version: "001_baseline.sql", checksum: null },
      { version: "002_unknown.sql", checksum: null },
    ], ["knowledge_pages"])).toThrow("fresh database");
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
