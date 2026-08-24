import { describe, expect, test } from "bun:test";
import type { Pool } from "pg";
import { AutomationRegistryRepository } from "./automation-registry.ts";

describe("automation registry", () => {
  test("lists enabled and disabled automations with enabled entries first", async () => {
    const statements: string[] = [];
    const pool = {
      async query(sql: string) {
        statements.push(sql);
        return { rows: [] };
      },
    } as unknown as Pool;

    await new AutomationRegistryRepository(pool).list();

    expect(statements[0]).toContain("ORDER BY disabled_at NULLS FIRST,key,id");
    expect(statements[0]).not.toContain("WHERE disabled_at IS NULL");
  });

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

    const transition = statements.findIndex((sql) => sql.includes("pg_advisory_xact_lock_shared"));
    const insert = statements.findIndex((sql) => sql.includes("INSERT INTO automation_registry"));
    expect(transition).toBeGreaterThan(-1);
    expect(insert).toBeGreaterThan(transition);
    expect(statements[insert]).not.toContain("disabled_at=NULL");
    expect(statements[insert]).not.toContain("name=excluded.name");
    expect(registration.name).toBe("Owner renamed distiller");
    expect(registration.disabled_at).toBe(disabledAt);
  });
});
