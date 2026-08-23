import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { RESTORE_OWNERSHIP_SCHEMA } from "../src/restore-ownership.ts";

const serverUrl = process.env.TEST_RESTORE_OWNERSHIP_DATABASE_URL;
const historicalServerUrl = process.env.TEST_RESTORE_OWNERSHIP_HISTORICAL_DATABASE_URL;
const describeDatabase = serverUrl ? describe : describe.skip;
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));

type Ownership = {
  object_kind: string;
  schema_name: string;
  object_name: string;
  identity_arguments: string;
  owner_role_name: string;
};

function identifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function fixtureDatabaseName(prefix: string): string {
  const name = `${prefix}_${randomUUID().replaceAll("-", "")}`;
  if (new TextEncoder().encode(name).length > 63) {
    throw new Error(`PostgreSQL fixture database name exceeds 63 bytes: ${name}`);
  }
  return name;
}

function objectKey(object: Ownership): string {
  return JSON.stringify([
    object.object_kind,
    object.schema_name,
    object.object_name,
    object.identity_arguments,
  ]);
}

const compatibilityRole = "context_use_public_mcp";
const ensureCompatibilityRoleSql = `
  DO $compatibility$
  BEGIN
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='${compatibilityRole}') THEN
      IF EXISTS (
        SELECT 1 FROM pg_catalog.pg_roles AS role
        WHERE role.rolname='${compatibilityRole}'
          AND (
            role.rolsuper OR role.rolinherit OR role.rolcreaterole OR role.rolcreatedb
            OR role.rolcanlogin OR role.rolreplication OR role.rolbypassrls
            OR role.rolconfig IS NOT NULL
            OR EXISTS (
              SELECT 1 FROM pg_catalog.pg_auth_members AS membership
              WHERE membership.roleid=role.oid OR membership.member=role.oid
            )
            OR EXISTS (
              SELECT 1 FROM pg_catalog.pg_shdepend AS dependency
              WHERE dependency.refclassid='pg_catalog.pg_authid'::pg_catalog.regclass
                AND dependency.refobjid=role.oid
                AND NOT (
                  dependency.deptype='o'
                  AND dependency.classid='pg_catalog.pg_default_acl'::pg_catalog.regclass
                  AND dependency.dbid=(
                    SELECT database.oid FROM pg_catalog.pg_database AS database
                    WHERE database.datname=pg_catalog.current_database()
                  )
                )
                AND NOT (
                  dependency.deptype='a'
                  AND dependency.dbid=(
                    SELECT database.oid FROM pg_catalog.pg_database AS database
                    WHERE database.datname=pg_catalog.current_database()
                  )
                )
            )
          )
      ) THEN
        RAISE EXCEPTION 'Existing ${compatibilityRole} role is not an isolated NOLOGIN compatibility role';
      END IF;
    ELSE
      CREATE ROLE ${compatibilityRole}
        NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
    END IF;
  END
  $compatibility$
`;

async function processResult(
  command: string[],
  options: { environment?: Record<string, string | undefined>; stdin?: Uint8Array } = {},
): Promise<{ stdout: string; stderr: string }> {
  const child = Bun.spawn(command, {
    cwd: repositoryRoot,
    env: { ...process.env, ...options.environment },
    stdin: options.stdin ?? "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`${command[0]} exited ${exitCode}: ${stderr || stdout}`);
  return { stdout, stderr };
}

async function processChunks(command: string[], chunks: readonly Uint8Array[]): Promise<void> {
  const child = Bun.spawn(command, {
    cwd: repositoryRoot,
    env: process.env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  for (const chunk of chunks) child.stdin.write(chunk);
  child.stdin.end();
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`${command[0]} exited ${exitCode}: ${stderr || stdout}`);
}

async function processChunksFailure(command: string[], chunks: readonly Uint8Array[]): Promise<string> {
  const child = Bun.spawn(command, {
    cwd: repositoryRoot,
    env: process.env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  for (const chunk of chunks) child.stdin.write(chunk);
  child.stdin.end();
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(exitCode).not.toBe(0);
  return `${stdout}\n${stderr}`;
}

async function processFailure(
  command: string[],
  environment: Record<string, string | undefined>,
  stdin?: Uint8Array,
): Promise<string> {
  const child = Bun.spawn(command, {
    cwd: repositoryRoot,
    env: { ...process.env, ...environment },
    stdin: stdin ?? "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(exitCode).not.toBe(0);
  return `${stdout}\n${stderr}`;
}

async function dumpDatabase(databaseUrl: string): Promise<Uint8Array> {
  const dump = Bun.spawn([
    "pg_dump",
    "--format=plain",
    "--clean",
    "--if-exists",
    "--no-owner",
    `--exclude-schema=${RESTORE_OWNERSHIP_SCHEMA}`,
    databaseUrl,
  ], { cwd: repositoryRoot, stdout: "pipe", stderr: "pipe" });
  const [dumpBytes, dumpError, dumpExit] = await Promise.all([
    new Response(dump.stdout).bytes(),
    new Response(dump.stderr).text(),
    dump.exited,
  ]);
  expect(dumpExit, dumpError).toBe(0);
  expect(new TextDecoder().decode(dumpBytes)).not.toContain(RESTORE_OWNERSHIP_SCHEMA);
  return dumpBytes;
}

function restoreCommand(databaseUrl: string): string[] {
  return [
    "psql", "-X", "--single-transaction", "-v", "ON_ERROR_STOP=1", "-d", databaseUrl,
    "-c", `CREATE TEMP TABLE context_use_restore_contract_snapshot AS
      SELECT ${RESTORE_OWNERSHIP_SCHEMA}.restore_contract_fingerprint() AS fingerprint;
      SELECT ${RESTORE_OWNERSHIP_SCHEMA}.reset_default_acls_for_restore(); `
      + "CREATE TEMP TABLE context_use_restore_guard(complete boolean PRIMARY KEY); "
      + "CREATE TEMP TABLE context_use_restore_guard_required(complete boolean NOT NULL "
      + "REFERENCES context_use_restore_guard(complete) DEFERRABLE INITIALLY DEFERRED); "
      + "INSERT INTO context_use_restore_guard_required VALUES (true); "
      + "DROP SCHEMA public CASCADE; CREATE SCHEMA public AUTHORIZATION pg_database_owner; "
      + "GRANT USAGE ON SCHEMA public TO PUBLIC",
    "-f", "-",
  ];
}

function restoreCompletion(): Uint8Array {
  return new TextEncoder().encode(
    `\nINSERT INTO pg_temp.context_use_restore_guard
      SELECT true
      FROM pg_temp.context_use_restore_contract_snapshot AS captured
      WHERE captured.fingerprint=${RESTORE_OWNERSHIP_SCHEMA}.restore_contract_fingerprint();\n`,
  );
}

async function restoreDatabase(databaseUrl: string, dumpBytes: Uint8Array): Promise<void> {
  await processChunks(restoreCommand(databaseUrl), [dumpBytes, restoreCompletion()]);
}

async function expectRestoredPublicSchema(client: Client): Promise<void> {
  const result = await client.query<{
    owner_role_name: string;
    public_usage: boolean;
    public_create: boolean;
    pgcrypto_schema: string | null;
  }>(`
    SELECT owner.rolname::text AS owner_role_name,
      EXISTS (
        SELECT 1 FROM pg_catalog.aclexplode(COALESCE(
          namespace.nspacl,pg_catalog.acldefault('n',namespace.nspowner)
        )) AS acl WHERE acl.grantee=0 AND acl.privilege_type='USAGE'
      ) AS public_usage,
      EXISTS (
        SELECT 1 FROM pg_catalog.aclexplode(COALESCE(
          namespace.nspacl,pg_catalog.acldefault('n',namespace.nspowner)
        )) AS acl WHERE acl.grantee=0 AND acl.privilege_type='CREATE'
      ) AS public_create,
      (
        SELECT extension_namespace.nspname::text
        FROM pg_catalog.pg_extension AS extension
        JOIN pg_catalog.pg_namespace AS extension_namespace ON extension_namespace.oid=extension.extnamespace
        WHERE extension.extname='pgcrypto'
      ) AS pgcrypto_schema
    FROM pg_catalog.pg_namespace AS namespace
    JOIN pg_catalog.pg_roles AS owner ON owner.oid=namespace.nspowner
    WHERE namespace.nspname='public'
  `);
  expect(result.rows).toEqual([{
    owner_role_name: "pg_database_owner",
    public_usage: false,
    public_create: false,
    pgcrypto_schema: "public",
  }]);
}

async function catalogOwnership(client: Client): Promise<Ownership[]> {
  const result = await client.query<Ownership>(`
    SELECT
      CASE routine.prokind
        WHEN 'p' THEN 'procedure'
        WHEN 'a' THEN 'aggregate'
        WHEN 'w' THEN 'window_function'
        ELSE 'function'
      END AS object_kind,
      namespace.nspname::text AS schema_name,
      routine.proname::text AS object_name,
      pg_catalog.pg_get_function_identity_arguments(routine.oid) AS identity_arguments,
      owner.rolname::text AS owner_role_name
    FROM pg_catalog.pg_proc AS routine
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid=routine.pronamespace
    JOIN pg_catalog.pg_roles AS owner ON owner.oid=routine.proowner
    WHERE namespace.nspname='public'

    UNION ALL

    SELECT CASE relation.relkind WHEN 'm' THEN 'materialized_view' ELSE 'view' END,
      namespace.nspname::text,relation.relname::text,'',owner.rolname::text
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid=relation.relnamespace
    JOIN pg_catalog.pg_roles AS owner ON owner.oid=relation.relowner
    WHERE namespace.nspname='public' AND relation.relkind IN ('v','m')

    ORDER BY object_kind,schema_name,object_name,identity_arguments
  `);
  return result.rows;
}

describeDatabase("pg_dump ownership reconciliation", () => {
  const source = new URL(serverUrl ?? "postgres://localhost/postgres");
  const sourceDatabaseName = decodeURIComponent(source.pathname.replace(/^\//, ""));
  const databaseName = fixtureDatabaseName("context_use_restore");
  const placeholderDatabaseName = fixtureDatabaseName("context_use_restore_ph");
  const maintenance = new URL(source);
  maintenance.pathname = "/postgres";
  const target = new URL(source);
  target.pathname = `/${databaseName}`;
  const migrationEnvironment = {
    MIGRATOR_DATABASE_URL: target.toString(),
    MIGRATOR_MAX_VERSION: undefined,
    MIGRATOR_PREPARE_RESTORE_OWNERSHIP: undefined,
    MIGRATOR_RECONCILE_RESTORE_OWNERSHIP: undefined,
  };
  const prepareEnvironment = {
    ...migrationEnvironment,
    MIGRATOR_PREPARE_RESTORE_OWNERSHIP: "true",
  };
  const reconcileEnvironment = {
    ...migrationEnvironment,
    MIGRATOR_RECONCILE_RESTORE_OWNERSHIP: "true",
  };
  const migrate = [process.execPath, "packages/database/src/migrate.ts"];
  let maintenanceClient: Client;
  let targetClient: Client;
  let compatibilityRoleFixtureCreated = false;

  beforeAll(async () => {
    maintenanceClient = new Client({ connectionString: maintenance.toString() });
    await maintenanceClient.connect();
    await maintenanceClient.query(
      `CREATE DATABASE ${identifier(databaseName)} TEMPLATE ${identifier(sourceDatabaseName)}`,
    );
    targetClient = new Client({ connectionString: target.toString() });
    await targetClient.connect();
  });

  afterAll(async () => {
    await targetClient?.end().catch(() => {});
    if (maintenanceClient) {
      await maintenanceClient.query(`DROP DATABASE IF EXISTS ${identifier(databaseName)} WITH (FORCE)`);
      await maintenanceClient.query(
        `DROP DATABASE IF EXISTS ${identifier(placeholderDatabaseName)} WITH (FORCE)`,
      );
      if (compatibilityRoleFixtureCreated) {
        const roleExists = await maintenanceClient.query<{ exists: boolean }>(
          "SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=$1) AS exists",
          [compatibilityRole],
        );
        if (roleExists.rows[0]?.exists) {
          // The suite proved this cluster-global name absent before creating
          // it, so normalize any partially exercised fixture state before the
          // fail-closed isolation check. Dropping both fixture databases above
          // has already removed every object the fixture could have owned.
          await maintenanceClient.query(`
            ALTER ROLE ${compatibilityRole}
              NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
            ALTER ROLE ${compatibilityRole} RESET ALL;
            DO $cleanup_memberships$
            DECLARE membership record;
            BEGIN
              FOR membership IN
                SELECT granted.rolname::text AS granted_role,
                  member.rolname::text AS member_role
                FROM pg_catalog.pg_auth_members AS role_membership
                JOIN pg_catalog.pg_roles AS granted ON granted.oid=role_membership.roleid
                JOIN pg_catalog.pg_roles AS member ON member.oid=role_membership.member
                WHERE granted.rolname='${compatibilityRole}'
                   OR member.rolname='${compatibilityRole}'
              LOOP
                IF membership.member_role='${compatibilityRole}' THEN
                  EXECUTE pg_catalog.format(
                    'REVOKE %I FROM ${compatibilityRole}',membership.granted_role
                  );
                ELSE
                  EXECUTE pg_catalog.format(
                    'REVOKE ${compatibilityRole} FROM %I',membership.member_role
                  );
                END IF;
              END LOOP;
            END
            $cleanup_memberships$;
          `);
          // Validate against the same fail-closed isolation boundary before a
          // fixture cleanup can remove any cluster-global role state.
          await maintenanceClient.query(ensureCompatibilityRoleSql);
          await maintenanceClient.query(
            `DROP OWNED BY ${compatibilityRole}; DROP ROLE ${compatibilityRole}`,
          );
        }
      }
      await maintenanceClient.end();
    }
  });

  test("same-version and historical no-owner restores recover every least-privilege owner", async () => {
    const migrationAdmin = await targetClient.query<{ role_name: string }>(
      "SELECT current_user::text AS role_name",
    );
    const migrationAdminName = migrationAdmin.rows[0]?.role_name;
    expect(migrationAdminName).toBeTruthy();
    const initialMigration = await processResult(migrate, { environment: migrationEnvironment });
    expect(initialMigration.stdout).not.toContain("Applied ");
    const currentMigrationCount = (await targetClient.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM schema_migrations",
    )).rows[0]!.count;

    const missingReconcile = await processFailure(migrate, reconcileEnvironment);
    expect(missingReconcile).toContain("reconciliation requires a pending contract");
    const conflictingPhase = await processFailure(migrate, {
      ...prepareEnvironment,
      MIGRATOR_RECONCILE_RESTORE_OWNERSHIP: "true",
    });
    expect(conflictingPhase).toContain("mutually exclusive");

    await targetClient.query("GRANT CREATE ON SCHEMA public TO context_use_dashboard");
    const unsafeSchema = await processFailure(migrate, prepareEnvironment);
    expect(unsafeSchema).toContain("no non-owner CREATE grant");
    await targetClient.query("REVOKE CREATE ON SCHEMA public FROM context_use_dashboard");

    await targetClient.query(
      "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO context_use_dashboard",
    );
    const unsafeDefaults = await processFailure(migrate, prepareEnvironment);
    expect(unsafeDefaults).toContain("exact public-sequence backup default ACL");
    await targetClient.query(
      "ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE SELECT ON TABLES FROM context_use_dashboard",
    );

    const prepared = await processResult(migrate, { environment: prepareEnvironment });
    expect(prepared.stdout).toContain("Prepared ");

    const expectedResult = await targetClient.query<Ownership>(`
      SELECT object_kind,schema_name::text,object_name::text,identity_arguments,
        owner_role_name::text
      FROM ${RESTORE_OWNERSHIP_SCHEMA}.objects
      ORDER BY object_kind,schema_name,object_name,identity_arguments
    `);
    const expected = expectedResult.rows;
    expect(expected.length).toBeGreaterThan(80);

    await targetClient.query(`
      GRANT USAGE ON SCHEMA ${RESTORE_OWNERSHIP_SCHEMA} TO context_use_dashboard;
      GRANT SELECT ON ${RESTORE_OWNERSHIP_SCHEMA}.manifest TO context_use_dashboard;
    `);
    const exposedContract = await processFailure(migrate, prepareEnvironment);
    expect(exposedContract).toContain("accessible to another principal");
    await targetClient.query(`
      REVOKE SELECT ON ${RESTORE_OWNERSHIP_SCHEMA}.manifest FROM context_use_dashboard;
      REVOKE USAGE ON SCHEMA ${RESTORE_OWNERSHIP_SCHEMA} FROM context_use_dashboard;
    `);
    const reusedPrepared = await processResult(migrate, { environment: prepareEnvironment });
    expect(reusedPrepared.stdout).toContain(
      `Reused pending restore contract for ${expected.length} routine/view ownerships`,
    );

    const dumpBytes = await dumpDatabase(target.toString());
    const incomplete = await processFailure(restoreCommand(target.toString()), {}, new Uint8Array());
    expect(incomplete).toContain("context_use_restore_guard_required_complete_fkey");
    const rolledBack = await targetClient.query<{ migrations: string; contract: string | null }>(`
      SELECT (SELECT count(*)::text FROM schema_migrations) AS migrations,
        pg_catalog.to_regnamespace($1)::text AS contract
    `, [RESTORE_OWNERSHIP_SCHEMA]);
    expect(rolledBack.rows).toEqual([{
      migrations: currentMigrationCount,
      contract: RESTORE_OWNERSHIP_SCHEMA,
    }]);

    const destructiveStream = new TextEncoder().encode(
      `DROP SCHEMA ${RESTORE_OWNERSHIP_SCHEMA} CASCADE;\n`,
    );
    const droppedContract = await processChunksFailure(
      restoreCommand(target.toString()),
      [destructiveStream, restoreCompletion()],
    );
    expect(droppedContract).toContain("restore_contract_fingerprint");
    const streamRolledBack = await targetClient.query<{ migrations: string; contract: string | null }>(`
      SELECT (SELECT count(*)::text FROM schema_migrations) AS migrations,
        pg_catalog.to_regnamespace($1)::text AS contract
    `, [RESTORE_OWNERSHIP_SCHEMA]);
    expect(streamRolledBack.rows).toEqual([{
      migrations: currentMigrationCount,
      contract: RESTORE_OWNERSHIP_SCHEMA,
    }]);

    await restoreDatabase(target.toString(), dumpBytes);
    await expectRestoredPublicSchema(targetClient);

    const restored = new Map((await catalogOwnership(targetClient)).map((object) => [objectKey(object), object]));
    for (const object of expected) {
      expect(restored.get(objectKey(object))?.owner_role_name).toBe(migrationAdminName);
    }

    const strayMigrator = await processFailure(migrate, migrationEnvironment);
    expect(strayMigrator).toContain("A restore ownership contract is pending");
    const reconciled = await processResult(migrate, { environment: reconcileEnvironment });
    expect(reconciled.stdout).toContain(`Reconciled ${expected.length} restored routine/view ownerships`);
    expect(reconciled.stdout).not.toContain("Applied ");

    const current = new Map((await catalogOwnership(targetClient)).map((object) => [objectKey(object), object]));
    for (const object of expected) {
      expect(current.get(objectKey(object))?.owner_role_name).toBe(object.owner_role_name);
    }
    const contract = await targetClient.query<{ contract: string | null }>(
      "SELECT pg_catalog.to_regnamespace($1)::text AS contract",
      [RESTORE_OWNERSHIP_SCHEMA],
    );
    expect(contract.rows[0]?.contract).toBeNull();

    const residual = await targetClient.query<{ count: string }>(`
      SELECT count(*)::text
      FROM pg_catalog.pg_proc AS routine
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid=routine.pronamespace
      JOIN pg_catalog.pg_roles AS owner ON owner.oid=routine.proowner
      WHERE namespace.nspname='public'
        AND routine.prosecdef
        AND owner.rolname=$1
        AND (
          EXISTS (
            SELECT 1 FROM pg_catalog.aclexplode(COALESCE(
              routine.proacl,pg_catalog.acldefault('f',routine.proowner)
            )) AS acl
            WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE'
          ) OR EXISTS (
            SELECT 1 FROM pg_catalog.pg_roles AS role
            WHERE role.rolname ~ '^context_use_'
              AND pg_catalog.has_function_privilege(role.oid,routine.oid,'EXECUTE')
          )
        )
    `, [migrationAdminName]);
    expect(residual.rows[0]?.count).toBe("0");

    const retryGoodRestore = async (): Promise<void> => {
      const reused = await processResult(migrate, { environment: prepareEnvironment });
      expect(reused.stdout).toContain(
        `Reused pending restore contract for ${expected.length} routine/view ownerships`,
      );
      await restoreDatabase(target.toString(), dumpBytes);
      const repaired = await processResult(migrate, { environment: reconcileEnvironment });
      expect(repaired.stdout).toContain(
        `Reconciled ${expected.length} restored routine/view ownerships`,
      );
    };

    await processResult(migrate, { environment: prepareEnvironment });
    await restoreDatabase(target.toString(), dumpBytes);
    await targetClient.query(
      "GRANT EXECUTE ON FUNCTION public.lock_public_uuid_namespace(uuid) TO PUBLIC",
    );
    const routineAclRejected = await processFailure(migrate, reconcileEnvironment);
    expect(routineAclRejected).toContain("Restore ownership target ACL changed");
    const retainedAfterRoutineAcl = await targetClient.query<{ contract: string | null }>(
      "SELECT pg_catalog.to_regnamespace($1)::text AS contract",
      [RESTORE_OWNERSHIP_SCHEMA],
    );
    expect(retainedAfterRoutineAcl.rows[0]?.contract).toBe(RESTORE_OWNERSHIP_SCHEMA);
    await retryGoodRestore();

    await processResult(migrate, { environment: prepareEnvironment });
    await restoreDatabase(target.toString(), dumpBytes);
    await targetClient.query(
      "GRANT SELECT (body_markdown) ON public.published_page_sources TO context_use_dashboard",
    );
    const viewAclRejected = await processFailure(migrate, reconcileEnvironment);
    expect(viewAclRejected).toContain("Restore ownership target ACL changed");
    await retryGoodRestore();

    await processResult(migrate, { environment: prepareEnvironment });
    await restoreDatabase(target.toString(), dumpBytes);
    await targetClient.query("GRANT CREATE ON SCHEMA public TO PUBLIC");
    const schemaAclRejected = await processFailure(migrate, reconcileEnvironment);
    expect(schemaAclRejected).toContain("Restored public schema ownership or ACL changed");
    await retryGoodRestore();

    await processResult(migrate, { environment: prepareEnvironment });
    await restoreDatabase(target.toString(), dumpBytes);
    await targetClient.query(
      "ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO context_use_dashboard",
    );
    const defaultAclRejected = await processFailure(migrate, reconcileEnvironment);
    expect(defaultAclRejected).toContain("Restored public/global default ACL state changed");
    await retryGoodRestore();

    const placeholderBefore = await targetClient.query<{ exists: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=$1) AS exists",
      [compatibilityRole],
    );
    expect(placeholderBefore.rows[0]?.exists).toBe(false);
    await targetClient.query(ensureCompatibilityRoleSql);
    compatibilityRoleFixtureCreated = true;
    await targetClient.query(ensureCompatibilityRoleSql);
    await targetClient.query(`ALTER ROLE ${compatibilityRole} LOGIN`);
    await expect(targetClient.query(ensureCompatibilityRoleSql)).rejects.toThrow(
      "not an isolated NOLOGIN compatibility role",
    );
    await targetClient.query(`
      ALTER ROLE ${compatibilityRole}
        NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
      ALTER ROLE ${compatibilityRole} RESET ALL;
      CREATE TABLE public.restore_compatibility_owner_probe(id integer);
      ALTER TABLE public.restore_compatibility_owner_probe OWNER TO ${compatibilityRole};
    `);
    await expect(targetClient.query(ensureCompatibilityRoleSql)).rejects.toThrow(
      "not an isolated NOLOGIN compatibility role",
    );
    const restoreProbeOwner = await targetClient.query<{ statement: string }>(`
      SELECT pg_catalog.format(
        'ALTER TABLE public.restore_compatibility_owner_probe OWNER TO %I',current_user
      ) AS statement
    `);
    await targetClient.query(restoreProbeOwner.rows[0]!.statement);
    await targetClient.query("DROP TABLE public.restore_compatibility_owner_probe");
    await targetClient.query(`GRANT USAGE ON SCHEMA public TO ${compatibilityRole}`);
    await targetClient.query(ensureCompatibilityRoleSql);

    await maintenanceClient.query(
      `CREATE DATABASE ${identifier(placeholderDatabaseName)} TEMPLATE template0`,
    );
    const placeholderDatabase = new URL(source);
    placeholderDatabase.pathname = `/${placeholderDatabaseName}`;
    const placeholderClient = new Client({ connectionString: placeholderDatabase.toString() });
    await placeholderClient.connect();
    try {
      await placeholderClient.query(`GRANT USAGE ON SCHEMA public TO ${compatibilityRole}`);
      await expect(targetClient.query(ensureCompatibilityRoleSql)).rejects.toThrow(
        "not an isolated NOLOGIN compatibility role",
      );
      await placeholderClient.query(`
        REVOKE USAGE ON SCHEMA public FROM ${compatibilityRole};
        ALTER DEFAULT PRIVILEGES FOR ROLE ${compatibilityRole}
          GRANT SELECT ON TABLES TO PUBLIC;
      `);
      await expect(targetClient.query(ensureCompatibilityRoleSql)).rejects.toThrow(
        "not an isolated NOLOGIN compatibility role",
      );
    } finally {
      await placeholderClient.end();
    }
    await maintenanceClient.query(
      `DROP DATABASE ${identifier(placeholderDatabaseName)} WITH (FORCE)`,
    );
    await targetClient.query(ensureCompatibilityRoleSql);
    await targetClient.query(`DROP OWNED BY ${compatibilityRole}; DROP ROLE ${compatibilityRole}`);
    compatibilityRoleFixtureCreated = false;
    const placeholderAfter = await targetClient.query<{ exists: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=$1) AS exists",
      [compatibilityRole],
    );
    expect(placeholderAfter.rows[0]?.exists).toBe(false);

    if (historicalServerUrl) {
      const historicalPrepared = await processResult(migrate, { environment: prepareEnvironment });
      expect(historicalPrepared.stdout).toContain(`Prepared ${expected.length} routine/view ownerships for restore`);
      await targetClient.query(ensureCompatibilityRoleSql);
      compatibilityRoleFixtureCreated = true;
      const historicalDump = await dumpDatabase(historicalServerUrl);
      await restoreDatabase(target.toString(), historicalDump);
      await expectRestoredPublicSchema(targetClient);
      await targetClient.query(`
        GRANT USAGE ON SCHEMA public TO ${compatibilityRole};
        GRANT SELECT ON public.published_page_sources TO ${compatibilityRole};
        GRANT EXECUTE ON FUNCTION public.project_public_markdown(text) TO ${compatibilityRole};
        ALTER DEFAULT PRIVILEGES FOR ROLE ${compatibilityRole}
          GRANT SELECT ON TABLES TO PUBLIC;
      `);
      const historicalCompatibilityDefaults = await targetClient.query<{ count: string }>(`
        SELECT count(*)::text
        FROM pg_catalog.pg_default_acl AS defaults
        JOIN pg_catalog.pg_roles AS role ON role.oid=defaults.defaclrole
        WHERE role.rolname=$1
      `, [compatibilityRole]);
      expect(historicalCompatibilityDefaults.rows[0]?.count).toBe("1");
      const restoredVersions = await targetClient.query<{ version: string }>(
        "SELECT version FROM schema_migrations ORDER BY version",
      );
      expect(restoredVersions.rows.some(({ version }) => version === "027_pathless_document_contract.sql")).toBe(true);
      expect(restoredVersions.rows.some(({ version }) => version === "028_pathless_publication_artifacts.sql")).toBe(false);
      expect(restoredVersions.rows.some(({ version }) => version === "029_pathless_publication_api.sql")).toBe(false);

      const upgraded = await processResult(migrate, { environment: reconcileEnvironment });
      expect(upgraded.stdout).toContain("Applied 028_pathless_publication_artifacts.sql");
      expect(upgraded.stdout).toContain("Applied 029_pathless_publication_api.sql");
      expect(upgraded.stdout).toContain(`Reconciled ${expected.length} restored routine/view ownerships`);
      const upgradedOwnership = new Map(
        (await catalogOwnership(targetClient)).map((object) => [objectKey(object), object]),
      );
      for (const object of expected) {
        expect(upgradedOwnership.get(objectKey(object))?.owner_role_name).toBe(object.owner_role_name);
      }
      const upgradedContract = await targetClient.query<{ contract: string | null }>(
        "SELECT pg_catalog.to_regnamespace($1)::text AS contract",
        [RESTORE_OWNERSHIP_SCHEMA],
      );
      expect(upgradedContract.rows[0]?.contract).toBeNull();
      const scrubbedCompatibility = await targetClient.query<{
        schema_usage: boolean;
        view_select: boolean;
        function_execute: boolean;
        default_acl_count: string;
      }>(`
        SELECT pg_catalog.has_schema_privilege($1,'public','USAGE') AS schema_usage,
          pg_catalog.has_table_privilege($1,'public.published_page_sources','SELECT') AS view_select,
          pg_catalog.has_function_privilege(
            $1,'public.project_public_markdown(text)','EXECUTE'
          ) AS function_execute,
          (
            SELECT count(*)::text
            FROM pg_catalog.pg_default_acl AS defaults
            JOIN pg_catalog.pg_roles AS role ON role.oid=defaults.defaclrole
            WHERE role.rolname=$1
          ) AS default_acl_count
      `, [compatibilityRole]);
      expect(scrubbedCompatibility.rows).toEqual([{
        schema_usage: false,
        view_select: false,
        function_execute: false,
        default_acl_count: "0",
      }]);
      await targetClient.query(ensureCompatibilityRoleSql);
      await targetClient.query(`DROP OWNED BY ${compatibilityRole}; DROP ROLE ${compatibilityRole}`);
      compatibilityRoleFixtureCreated = false;
    }

    await processResult(migrate, { environment: prepareEnvironment });
    await targetClient.query(`
      CREATE FUNCTION public.restore_ownership_injection_probe()
      RETURNS text LANGUAGE sql SECURITY DEFINER AS 'SELECT current_user::text';
      GRANT EXECUTE ON FUNCTION public.restore_ownership_injection_probe() TO context_use_dashboard;
    `);
    const rejected = await processFailure(migrate, reconcileEnvironment);
    expect(rejected).toContain("Unexpected migration-admin-owned SECURITY DEFINER routine");
  }, 180_000);
});
