import { describe, expect, test } from "bun:test";
import {
  assertMigrationState,
  configuredExistingRolePasswords,
  migrationsThroughVersion,
} from "../src/migration-state.ts";

const files = [{ version: "001_baseline.sql", checksum: "current-checksum" }];

describe("flattened migration state", () => {
  test("accepts a fresh database and an exactly matching baseline", () => {
    expect(() => assertMigrationState(files, [], [])).not.toThrow();
    expect(() => assertMigrationState(files, [
      { version: "001_baseline.sql", checksum: "current-checksum" },
    ], ["knowledge_pages"])).not.toThrow();
  });

  test("fails closed for removed legacy migrations", () => {
    expect(() => assertMigrationState(files, [
      { version: "001_baseline.sql", checksum: null },
      { version: "006_legacy.sql", checksum: null },
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

describe("staged migration ceiling", () => {
  const stagedFiles = [
    { version: "001_baseline.sql", checksum: "checksum-001", sql: "one" },
    { version: "026_audited_corpus.sql", checksum: "checksum-026", sql: "twenty-six" },
    { version: "027_canonical_contract.sql", checksum: "checksum-027", sql: "twenty-seven" },
    { version: "028_canonical_publication.sql", checksum: "checksum-028", sql: "twenty-eight" },
  ];

  test("defaults to every on-disk migration", () => {
    expect(migrationsThroughVersion(stagedFiles, [], undefined)).toEqual(stagedFiles);
  });

  test("accepts only an exact filename and includes that migration", () => {
    expect(migrationsThroughVersion(
      stagedFiles,
      [{ version: "026_audited_corpus.sql", checksum: "checksum-026" }],
      "027_canonical_contract.sql",
    ).map(({ version }) => version)).toEqual([
      "001_baseline.sql",
      "026_audited_corpus.sql",
      "027_canonical_contract.sql",
    ]);
    expect(() => migrationsThroughVersion(stagedFiles, [], "027_canonical_contract"))
      .toThrow("exactly match an on-disk migration filename");
    expect(() => migrationsThroughVersion(stagedFiles, [], ""))
      .toThrow("exactly match an on-disk migration filename");
  });

  test("rejects a target older than any applied migration", () => {
    expect(() => migrationsThroughVersion(
      stagedFiles,
      [
        { version: "001_baseline.sql", checksum: "checksum-001" },
        { version: "027_canonical_contract.sql", checksum: "checksum-027" },
      ],
      "026_audited_corpus.sql",
    )).toThrow("older than already-applied migration(s): 027_canonical_contract.sql");
  });

  test("allows a bounded compatibility pass after later contraction migrations", () => {
    expect(migrationsThroughVersion(
      stagedFiles,
      [
        { version: "001_baseline.sql", checksum: "checksum-001" },
        { version: "027_canonical_contract.sql", checksum: "checksum-027" },
      ],
      "026_audited_corpus.sql",
      true,
    ).map(({ version }) => version)).toEqual([
      "001_baseline.sql",
      "026_audited_corpus.sql",
    ]);
  });

  test("validates every applied checksum before limiting new migrations", () => {
    const applied = [
      { version: "001_baseline.sql", checksum: "checksum-001" },
      { version: "027_canonical_contract.sql", checksum: "modified-checksum" },
    ];
    expect(() => {
      assertMigrationState(stagedFiles, applied, ["knowledge_pages"]);
      migrationsThroughVersion(stagedFiles, applied, "027_canonical_contract.sql");
    }).toThrow("027_canonical_contract.sql does not match this release");
  });
});

describe("staged role password configuration", () => {
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
