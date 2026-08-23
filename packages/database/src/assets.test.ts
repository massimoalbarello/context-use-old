import { describe, expect, test } from "bun:test";
import type { Pool } from "pg";
import { AssetRepository } from "./assets.ts";

describe("asset mutation lock ordering", () => {
  test("archive locks the corpus transition before the asset row", async () => {
    const calls: string[] = [];
    const query = async (sql: string) => {
      calls.push(sql);
      return { rowCount: 0, rows: [] };
    };
    const pool = {
      async connect() {
        return { query, release() {} };
      },
    } as unknown as Pool;

    expect(await new AssetRepository(pool).archive(
      "11111111-1111-4111-8111-111111111111",
    )).toBeNull();

    const transition = calls.findIndex((sql) => sql.includes(
      "pg_advisory_xact_lock_shared",
    ));
    const asset = calls.findIndex((sql) => sql.includes("FOR UPDATE"));
    expect(transition).toBeGreaterThan(-1);
    expect(asset).toBeGreaterThan(transition);
  });
});
