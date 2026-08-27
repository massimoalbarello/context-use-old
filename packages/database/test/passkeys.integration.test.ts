import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { disposableDatabaseUrl } from "../src/disposable-database.ts";

const adminUrl = await disposableDatabaseUrl();
const describeDatabase = adminUrl ? describe : describe.skip;

describeDatabase("owner passkey schema", () => {
  let admin: Client;

  beforeAll(async () => {
    admin = new Client({ connectionString: adminUrl });
    await admin.connect();
  });

  afterAll(async () => {
    await admin.end();
  });

  test("installs Better Auth first and keeps every auth relation out of public", async () => {
    const authMigrations = await admin.query<{ version: string }>(
      "SELECT version FROM public.auth_schema_migrations ORDER BY version",
    );
    expect(authMigrations.rows.map(({ version }) => version)).toEqual([
      "001_create_auth_schema.sql",
      "002_better_auth.sql",
    ]);
    const applicationMigrations = await admin.query<{ version: string }>(
      "SELECT version FROM public.schema_migrations ORDER BY version",
    );
    expect(applicationMigrations.rows.map(({ version }) => version)).toEqual([
      "001_application_schema.sql",
      "002_harden_owner_auth.sql",
      "003_grant_bootstrap_and_migration_ledgers.sql",
      "004_remove_knowledge_bundles.sql",
    ]);

    const relations = await admin.query<{ schema_name: string; relation_name: string }>(
      `SELECT namespace.nspname AS schema_name,relation.relname AS relation_name
       FROM pg_catalog.pg_class AS relation
       JOIN pg_catalog.pg_namespace AS namespace
         ON namespace.oid=relation.relnamespace
       WHERE relation.relkind='r'
         AND relation.relname=ANY($1::text[])
       ORDER BY namespace.nspname,relation.relname`,
      [[
        "account",
        "jwks",
        "oauthAccessToken",
        "oauthClient",
        "oauthClientAssertion",
        "oauthClientResource",
        "oauthConsent",
        "oauthRefreshToken",
        "oauthResource",
        "passkey",
        "session",
        "user",
        "verification",
      ]],
    );
    expect(relations.rows).toHaveLength(13);
    expect(relations.rows.every(({ schema_name }) => schema_name === "auth")).toBe(true);

    const authRole = await admin.query<{ configuration: string[] | null }>(
      `SELECT rolconfig AS configuration
       FROM pg_catalog.pg_roles WHERE rolname='context_use_auth'`,
    );
    expect(authRole.rows[0]?.configuration).toContain("search_path=pg_catalog, auth, public");
  });

  test("allows multiple passkeys but never removal of the final credential", async () => {
    const userId = "context-use-owner";
    await admin.query("BEGIN");
    try {
      await admin.query(
        `INSERT INTO auth."user"(id,name,email,"emailVerified")
         VALUES ($1,'Passkey owner',$2,true)
         ON CONFLICT (id) DO NOTHING`,
        [userId, "owner@example.com"],
      );
      await admin.query(
        `INSERT INTO auth.passkey(id,"publicKey","userId","credentialID",counter,"deviceType","backedUp")
         VALUES ($1,'public-key',$2,$3,0,'singleDevice',false)`,
        [randomUUID(), userId, `credential-${randomUUID()}`],
      );

      const secondId = randomUUID();
      await admin.query(
        `INSERT INTO auth.passkey(id,"publicKey","userId","credentialID",counter,"deviceType","backedUp")
         VALUES ($1,'second-public-key',$2,$3,0,'singleDevice',false)`,
        [secondId, userId, `credential-${randomUUID()}`],
      );
      expect((await admin.query(
        `SELECT count(*)::int AS count FROM auth.passkey WHERE "userId"=$1`,
        [userId],
      )).rows[0]?.count).toBe(2);

      await admin.query("SELECT remove_owner_passkey($1,$2)", [userId, secondId]);
      await expect(admin.query(
        "SELECT remove_owner_passkey($1,(SELECT id FROM auth.passkey WHERE \"userId\"=$1))",
        [userId],
      )).rejects.toMatchObject({ code: "22023" });
    } finally {
      await admin.query("ROLLBACK");
    }
  });

  test("rejects any second owner identity", async () => {
    await expect(admin.query(
      `INSERT INTO auth."user"(id,name,email,"emailVerified") VALUES ('another-owner','Other','other@example.com',true)`,
    )).rejects.toMatchObject({ code: "23514", constraint: "user_single_owner_check" });
  });
});
