import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { adoptLegacySchema } from "../src/adopt-legacy-schema.ts";
import { disposableDatabaseUrl } from "../src/disposable-database.ts";
import {
  BETTER_AUTH_TABLES,
  inspectLegacySchema,
  LEGACY_MIGRATIONS,
} from "../src/legacy-schema.ts";
import { loadMigrationStreams } from "../src/migrations/catalog.ts";

const serverUrl = await disposableDatabaseUrl();
const describeDatabase = serverUrl ? describe : describe.skip;
const targetMigrationStreams = await loadMigrationStreams({
  directory: new URL("../migrations", import.meta.url).pathname,
});
const applicationMigrationSql = targetMigrationStreams.application.find(
  ({ version }) => version === "001_application_schema.sql",
)?.sql;
if (!applicationMigrationSql) {
  throw new Error("Test target catalog has no application schema");
}

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
    await target.query(`
      DROP INDEX auth."passkey_userId_idx";
      ALTER INDEX auth.passkey_credential_id_unique RENAME TO "passkey_credentialID_unique";
      ALTER TABLE auth."oauthClient"
        DROP COLUMN "backchannelLogoutUri",
        DROP COLUMN "backchannelLogoutSessionRequired",
        DROP COLUMN jwks,
        DROP COLUMN "jwksUri",
        ALTER COLUMN "dpopBoundAccessTokens" SET DEFAULT false,
        ALTER COLUMN "dpopBoundAccessTokens" SET NOT NULL;
      ALTER TABLE auth."oauthResource"
        ALTER COLUMN "dpopBoundAccessTokensRequired" SET DEFAULT false,
        ALTER COLUMN "dpopBoundAccessTokensRequired" SET NOT NULL,
        ALTER COLUMN disabled SET DEFAULT false,
        ALTER COLUMN disabled SET NOT NULL,
        ALTER COLUMN "policyVersion" SET DEFAULT 1,
        ALTER COLUMN "policyVersion" SET NOT NULL;
      ALTER ROLE context_use_auth SET search_path TO pg_catalog, public;
    `);
    for (const table of [...BETTER_AUTH_TABLES].sort()) {
      await target.query(`ALTER TABLE auth.${identifier(table)} SET SCHEMA public`);
    }
    await target.query("DROP SCHEMA auth");
    await target.query("DROP TABLE public.auth_schema_migrations");
    await target.query("DELETE FROM public.schema_migrations");
    for (const migration of LEGACY_MIGRATIONS) {
      await target.query("INSERT INTO public.schema_migrations(version,checksum) VALUES ($1,$2)", [
        migration.version,
        migration.checksum,
      ]);
    }
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
    expect(await inspectLegacySchema(target)).toMatchObject({ state: "legacy-v0.1.97" });
    let moved = 0;
    await expect(
      adoptLegacySchema({
        client: target,
        targetMigrationStreams,
        applicationMigrationSql,
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

    expect(
      await adoptLegacySchema({
        client: target,
        targetMigrationStreams,
        applicationMigrationSql,
      }),
    ).toMatchObject({ action: "transitioned" });
    expect((await target.query('SELECT 1 FROM auth."user" WHERE id=$1', [ownerId])).rowCount).toBe(
      1,
    );
    expect(
      await adoptLegacySchema({
        client: target,
        targetMigrationStreams,
        applicationMigrationSql,
      }),
    ).toMatchObject({
      action: "already-transitioned",
    });
  });
});
