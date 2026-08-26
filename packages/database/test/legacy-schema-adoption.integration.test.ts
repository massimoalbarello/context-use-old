import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { adoptLegacySchema } from "../src/adopt-legacy-schema.ts";
import { disposableDatabaseUrl } from "../src/disposable-database.ts";
import { inspectLegacySchema } from "../src/legacy-schema.ts";

const serverUrl = await disposableDatabaseUrl();
const describeDatabase = serverUrl ? describe : describe.skip;

function identifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function databaseUrl({ source, database }: { source: string; database: string }): string {
  const target = new URL(source);
  target.pathname = `/${database}`;
  return target.toString();
}

describeDatabase("legacy auth schema adoption", () => {
  const database = `context_use_adoption_${randomUUID().replaceAll("-", "")}`;
  const sourceDatabase = new URL(serverUrl ?? "postgres://localhost/postgres").pathname.replace(
    /^\//,
    "",
  );
  const maintenanceUrl = databaseUrl({
    source: serverUrl ?? "postgres://localhost/postgres",
    database: "postgres",
  });
  const targetUrl = databaseUrl({
    source: serverUrl ?? "postgres://localhost/postgres",
    database,
  });
  const ownerId = "context-use-owner";
  const ownerEmail = `adoption-fixture-${randomUUID()}@example.invalid`;
  let maintenance: Client;
  let target: Client;

  beforeAll(async () => {
    maintenance = new Client({ connectionString: maintenanceUrl });
    await maintenance.connect();
    await maintenance.query(
      `CREATE DATABASE ${identifier(database)} TEMPLATE ${identifier(sourceDatabase)}`,
    );
    target = new Client({ connectionString: targetUrl });
    await target.connect();
    await target.query(
      `INSERT INTO public."user"(id,name,email,"emailVerified")
       VALUES ($1,'Adoption fixture',$2,true)
       ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name,email=EXCLUDED.email`,
      [ownerId, ownerEmail],
    );
  });

  afterAll(async () => {
    await target?.end().catch(() => {});
    if (maintenance) {
      await maintenance.query(`DROP DATABASE IF EXISTS ${identifier(database)} WITH (FORCE)`);
      await maintenance.end();
    }
  });

  test("rolls back a partial move, preserves data, and converges on retry", async () => {
    let moved = 0;
    await expect(
      adoptLegacySchema({
        client: target,
        afterTableMoved: () => {
          moved += 1;
          if (moved === 3) {
            throw new Error("injected adoption failure");
          }
        },
      }),
    ).rejects.toThrow("injected adoption failure");
    expect(await inspectLegacySchema(target)).toMatchObject({ state: "legacy-v0.1.97" });
    expect(
      (await target.query('SELECT 1 FROM public."user" WHERE id=$1', [ownerId])).rowCount,
    ).toBe(1);

    expect(await adoptLegacySchema({ client: target })).toMatchObject({ action: "adopted" });
    expect(await inspectLegacySchema(target)).toMatchObject({ state: "legacy-auth-adopted" });
    expect((await target.query('SELECT 1 FROM auth."user" WHERE id=$1', [ownerId])).rowCount).toBe(
      1,
    );
    expect(await adoptLegacySchema({ client: target })).toMatchObject({
      action: "already-adopted",
    });
  });
});
