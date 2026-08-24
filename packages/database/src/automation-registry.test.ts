import { describe, expect, test } from "bun:test";
import type { Pool } from "pg";
import { AutomationRegistryRepository } from "./automation-registry.ts";

describe("automation registry", () => {
  test("identity-preserving preparation never overwrites an owner rename or disabled state", async () => {
    const disabledAt = new Date("2026-01-01T00:00:00.000Z");
    const statements: string[] = [];
    const query = async (sql: string) => {
      statements.push(sql);
      if (!sql.includes("INSERT INTO automation_registry")) return { rows: [] };
      return {
        rows: [{
          id: "11111111-1111-4111-8111-111111111111",
          key: "activity-distiller",
          name: "Owner renamed distiller",
          instructions_document_id: "22222222-2222-4222-8222-222222222222",
          state_document_id: "33333333-3333-4333-8333-333333333333",
          created_at: new Date(0),
          updated_at: new Date(0),
          disabled_at: disabledAt,
        }],
      };
    };
    const pool = {
      async connect() {
        return { query, release() {} };
      },
    } as unknown as Pool;
    const registration = await new AutomationRegistryRepository(pool).register({
      id: "11111111-1111-4111-8111-111111111111",
      key: "activity-distiller",
      name: "Stale planned name",
      instructions_document_id: "22222222-2222-4222-8222-222222222222",
      state_document_id: "33333333-3333-4333-8333-333333333333",
    });

    const insert = statements.findIndex((sql) => sql.includes("INSERT INTO automation_registry"));
    expect(statements.some((sql) => sql.includes("filesystem-hypermedia-corpus-transition"))).toBe(false);
    expect(insert).toBeGreaterThan(-1);
    expect(statements[insert]).not.toContain("disabled_at=NULL");
    expect(statements[insert]).not.toContain("name=excluded.name");
    expect(registration.name).toBe("Owner renamed distiller");
    expect(registration.disabled_at).toBe(disabledAt);
  });
});
