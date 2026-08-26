import { describe, expect, test } from "bun:test";
import {
  ADOPTED_AUTH_STRUCTURE_FINGERPRINT,
  BETTER_AUTH_TABLES,
  LEGACY_AUTH_STRUCTURE_FINGERPRINT,
  LEGACY_MIGRATIONS,
  legacyStateFromInspection,
} from "./legacy-schema.ts";

const legacyRelations = BETTER_AUTH_TABLES.map((table) => ({ schema: "public", table }));

describe("legacy schema classification", () => {
  test("recognizes a fresh database", () => {
    expect(
      legacyStateFromInspection({
        migrations: [],
        relations: [],
        hasAuthSchema: false,
        authStructureFingerprint: null,
      }),
    ).toEqual({ state: "fresh" });
  });

  test("recognizes only the exact v0.1.97 legacy state", () => {
    expect(
      legacyStateFromInspection({
        migrations: [...LEGACY_MIGRATIONS],
        relations: legacyRelations,
        hasAuthSchema: false,
        authStructureFingerprint: LEGACY_AUTH_STRUCTURE_FINGERPRINT,
      }),
    ).toEqual({
      state: "legacy-v0.1.97",
      authStructureFingerprint: LEGACY_AUTH_STRUCTURE_FINGERPRINT,
    });
  });

  test("recognizes an already moved legacy auth schema", () => {
    expect(
      legacyStateFromInspection({
        migrations: [...LEGACY_MIGRATIONS],
        relations: BETTER_AUTH_TABLES.map((table) => ({ schema: "auth", table })),
        hasAuthSchema: true,
        authStructureFingerprint: ADOPTED_AUTH_STRUCTURE_FINGERPRINT,
      }),
    ).toEqual({
      state: "legacy-auth-adopted",
      authStructureFingerprint: ADOPTED_AUTH_STRUCTURE_FINGERPRINT,
    });
  });

  test("refuses ledger and partial-location drift", () => {
    const inspection = legacyStateFromInspection({
      migrations: LEGACY_MIGRATIONS.slice(0, -1),
      relations: legacyRelations.map((relation) =>
        relation.table === "user" ? { ...relation, schema: "auth" } : relation,
      ),
      hasAuthSchema: true,
      authStructureFingerprint: "unexpected",
    });
    expect(inspection.state).toBe("unsupported");
    if (inspection.state !== "unsupported") {
      throw new Error("expected unsupported state");
    }
    expect(inspection.reasons).toEqual([
      "expected 10 legacy migrations, found 9",
      "Better Auth tables are split between legacy and adopted schemas",
    ]);
  });

  test("refuses auth structure drift", () => {
    const inspection = legacyStateFromInspection({
      migrations: [...LEGACY_MIGRATIONS],
      relations: legacyRelations,
      hasAuthSchema: false,
      authStructureFingerprint: "unexpected",
    });
    expect(inspection).toEqual({
      state: "unsupported",
      reasons: [
        `Better Auth table structure does not match v0.1.97: expected ${LEGACY_AUTH_STRUCTURE_FINGERPRINT}, found unexpected`,
      ],
    });
  });

  test("does not call a non-empty untracked database fresh", () => {
    expect(
      legacyStateFromInspection({
        migrations: [],
        relations: [{ schema: "public", table: "untracked" }],
        hasAuthSchema: false,
        authStructureFingerprint: null,
      }).state,
    ).toBe("unsupported");
  });
});
