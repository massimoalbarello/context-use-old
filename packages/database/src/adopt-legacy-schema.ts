import { createHash } from "node:crypto";
import type { Client } from "pg";
import {
  authStructureFingerprint,
  BETTER_AUTH_TABLES,
  inspectLegacySchema,
  type LegacySchemaInspection,
} from "./legacy-schema.ts";
import type { MigrationStreams } from "./migrations/catalog.ts";
import { MIGRATION_LEDGERS } from "./migrations/ledger.ts";
import { restoreOwnershipContractPending } from "./restore-ownership.ts";

export const LEGACY_ADOPTION_ENV = "CONTEXT_USE_ADOPT_LEGACY_SCHEMA";
export const LEGACY_ADOPTION_CONFIRMATION = "v0.1.97";
export const TARGET_AUTH_STRUCTURE_FINGERPRINT =
  "446c0a76a6919361d48b8ae0bcd7a4ba31c30f9e75f1d4de422ba0936a376fab";
export const TARGET_ROUTINE_FINGERPRINT =
  "0c4cbc07ab34948920865afad54ae737951d995cd2f50e27e1451192dd2c4f6a";

const TARGET_MIGRATION_VERSIONS = {
  auth: ["001_create_auth_schema.sql", "002_better_auth.sql"],
  application: ["001_application_schema.sql", "002_harden_owner_auth.sql"],
} as const;

const NORMALIZED_ROUTINES = [
  "begin_hypermedia_bootstrap",
  "begin_publication_intent",
  "consume_confirmation_challenge",
  "lock_publication_context",
  "protect_passkey_credential",
  "remove_owner_passkey",
] as const;

type AuthTableIdentity = {
  table: string;
  oid: number;
  rows: string;
};

export type LegacyAdoptionResult = {
  action: "transitioned" | "already-transitioned" | "not-required";
  authStructureFingerprint?: string;
  routineFingerprint?: string;
  inspection?: Exclude<LegacySchemaInspection, { state: "unsupported" }>;
};

function identifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

async function authTableIdentities({
  client,
  schema,
}: {
  client: Client;
  schema: "public" | "auth";
}): Promise<AuthTableIdentity[]> {
  const identities: AuthTableIdentity[] = [];
  for (const table of [...BETTER_AUTH_TABLES].sort()) {
    const qualified = `${identifier(schema)}.${identifier(table)}`;
    const result = await client.query<{ oid: number; rows: string }>(
      `SELECT $1::regclass::oid AS oid,count(*)::text AS rows FROM ${qualified}`,
      [qualified],
    );
    const identity = result.rows[0];
    if (!identity) {
      throw new Error(`Could not inspect ${schema}.${table}`);
    }
    identities.push({ table, ...identity });
  }
  return identities;
}

function assertIdentitiesPreserved({
  before,
  after,
}: {
  before: AuthTableIdentity[];
  after: AuthTableIdentity[];
}): void {
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    throw new Error("Better Auth table identities or row counts changed during legacy adoption");
  }
}

function assertTargetMigrationCatalog(streams: MigrationStreams): void {
  for (const stream of ["auth", "application"] as const) {
    const versions = streams[stream].map(({ version }) => version);
    if (JSON.stringify(versions) !== JSON.stringify(TARGET_MIGRATION_VERSIONS[stream])) {
      throw new Error(
        `Legacy adoption received an unexpected ${stream} migration catalog: ${versions.join(", ")}`,
      );
    }
  }
}

async function migrationLedgersMatch({
  client,
  streams,
}: {
  client: Client;
  streams: MigrationStreams;
}): Promise<boolean> {
  for (const stream of ["auth", "application"] as const) {
    const ledger = MIGRATION_LEDGERS[stream];
    const present = await client.query<{ present: boolean }>(
      `SELECT pg_catalog.to_regclass('public.${ledger}') IS NOT NULL AS present`,
    );
    if (!present.rows[0]?.present) return false;
    const applied = (
      await client.query<{ version: string; checksum: string }>(
        `SELECT version,checksum FROM public.${ledger} ORDER BY version`,
      )
    ).rows;
    const expected = streams[stream].map(({ version, checksum }) => ({ version, checksum }));
    if (JSON.stringify(applied) !== JSON.stringify(expected)) return false;
  }
  return true;
}

export function replacementFunctionDefinitions({
  applicationMigrationSql,
}: {
  applicationMigrationSql: string;
}): string[] {
  return NORMALIZED_ROUTINES.map((routine) => {
    const marker = `CREATE FUNCTION public.${routine}(`;
    const start = applicationMigrationSql.indexOf(marker);
    if (start < 0) {
      throw new Error(`Application migration is missing ${routine}`);
    }
    const terminator = applicationMigrationSql.indexOf("\n$$;", start);
    if (terminator < 0) {
      throw new Error(`Application migration has no complete definition for ${routine}`);
    }
    return applicationMigrationSql
      .slice(start, terminator + "\n$$;".length)
      .replace("CREATE FUNCTION", "CREATE OR REPLACE FUNCTION");
  });
}

type TransitionRoutineRow = {
  routine: string;
  arguments: string;
  configuration: string;
  definition: string;
};

export async function transitionRoutineCatalog(client: Client): Promise<TransitionRoutineRow[]> {
  const result = await client.query<{
    routine: string;
    arguments: string;
    configuration: string;
    definition: string;
  }>(
    `
    SELECT procedure.proname AS routine,
      pg_catalog.pg_get_function_identity_arguments(procedure.oid) AS arguments,
      COALESCE(procedure.proconfig::text,'') AS configuration,
      pg_catalog.pg_get_functiondef(procedure.oid) AS definition
    FROM pg_catalog.pg_proc AS procedure
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid=procedure.pronamespace
    WHERE namespace.nspname='public' AND procedure.proname=ANY($1::text[])
    ORDER BY procedure.proname,pg_catalog.pg_get_function_identity_arguments(procedure.oid)
  `,
    [[...NORMALIZED_ROUTINES]],
  );
  if (result.rows.length !== NORMALIZED_ROUTINES.length) {
    throw new Error("Transition routine set is incomplete");
  }
  return result.rows;
}

export async function transitionRoutineFingerprint(client: Client): Promise<string> {
  return createHash("sha256")
    .update(JSON.stringify(await transitionRoutineCatalog(client)))
    .digest("hex");
}

async function assertTargetSchema(client: Client): Promise<{
  authStructureFingerprint: string;
  routineFingerprint: string;
}> {
  const authFingerprint = await authStructureFingerprint(client);
  if (authFingerprint !== TARGET_AUTH_STRUCTURE_FINGERPRINT) {
    throw new Error(
      `Transition auth structure does not match the target: expected ${TARGET_AUTH_STRUCTURE_FINGERPRINT}, ` +
        `found ${authFingerprint ?? "nothing"}`,
    );
  }
  const routineFingerprint = await transitionRoutineFingerprint(client);
  if (routineFingerprint !== TARGET_ROUTINE_FINGERPRINT) {
    throw new Error(
      `Transition routines do not match the target: expected ${TARGET_ROUTINE_FINGERPRINT}, ` +
        `found ${routineFingerprint}`,
    );
  }
  const authRole = await client.query<{ configuration: string[] | null }>(
    "SELECT rolconfig AS configuration FROM pg_catalog.pg_roles WHERE rolname='context_use_auth'",
  );
  if (
    JSON.stringify(authRole.rows[0]?.configuration) !==
    JSON.stringify(["search_path=pg_catalog, auth, public"])
  ) {
    throw new Error("context_use_auth does not have the target search path");
  }
  return { authStructureFingerprint: authFingerprint, routineFingerprint };
}

async function normalizeAdoptedSchema({
  client,
  applicationMigrationSql,
}: {
  client: Client;
  applicationMigrationSql: string;
}): Promise<void> {
  await client.query(`
    ALTER TABLE auth."oauthClient"
      ADD COLUMN "backchannelLogoutUri" text,
      ADD COLUMN "backchannelLogoutSessionRequired" boolean,
      ADD COLUMN jwks text,
      ADD COLUMN "jwksUri" text,
      ALTER COLUMN "dpopBoundAccessTokens" DROP DEFAULT,
      ALTER COLUMN "dpopBoundAccessTokens" DROP NOT NULL;
    ALTER TABLE auth."oauthResource"
      ALTER COLUMN "dpopBoundAccessTokensRequired" DROP DEFAULT,
      ALTER COLUMN "dpopBoundAccessTokensRequired" DROP NOT NULL,
      ALTER COLUMN disabled DROP DEFAULT,
      ALTER COLUMN disabled DROP NOT NULL,
      ALTER COLUMN "policyVersion" DROP DEFAULT,
      ALTER COLUMN "policyVersion" DROP NOT NULL;
    ALTER INDEX auth."passkey_credentialID_unique" RENAME TO passkey_credential_id_unique;
    CREATE INDEX "passkey_userId_idx" ON auth.passkey ("userId");
    GRANT USAGE ON SCHEMA auth TO
      context_use_auth,context_use_backup,context_use_boundary_owner,context_use_confirmation;
    ALTER ROLE context_use_auth SET search_path TO pg_catalog, auth, public;
    COMMENT ON SCHEMA public IS NULL;
  `);
  for (const definition of replacementFunctionDefinitions({ applicationMigrationSql })) {
    await client.query(definition);
  }
}

async function replaceMigrationLedger({
  client,
  streams,
}: {
  client: Client;
  streams: MigrationStreams;
}): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS public.auth_schema_migrations (
      version text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  for (const stream of ["auth", "application"] as const) {
    const ledger = MIGRATION_LEDGERS[stream];
    await client.query(`DELETE FROM public.${ledger}`);
    for (const migration of streams[stream]) {
      await client.query(`INSERT INTO public.${ledger}(version,checksum) VALUES ($1,$2)`, [
        migration.version,
        migration.checksum,
      ]);
    }
  }
}

export async function adoptLegacySchema({
  client,
  targetMigrationStreams,
  applicationMigrationSql,
  afterTableMoved,
}: {
  client: Client;
  targetMigrationStreams: MigrationStreams;
  applicationMigrationSql: string;
  afterTableMoved?: (table: string) => void | Promise<void>;
}): Promise<LegacyAdoptionResult> {
  assertTargetMigrationCatalog(targetMigrationStreams);
  await client.query("BEGIN");
  try {
    await client.query(
      "SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('context-use:migrate',0))",
    );
    if (await restoreOwnershipContractPending(client)) {
      throw new Error(
        "Refusing legacy schema adoption while a restore ownership contract is pending",
      );
    }
    if (await migrationLedgersMatch({ client, streams: targetMigrationStreams })) {
      const target = await assertTargetSchema(client);
      await client.query("COMMIT");
      return { action: "already-transitioned", ...target };
    }
    const initial = await inspectLegacySchema(client);
    if (initial.state === "unsupported") {
      throw new Error(`Refusing legacy schema adoption: ${initial.reasons.join("; ")}`);
    }
    if (initial.state === "fresh") {
      await client.query("COMMIT");
      return { action: "not-required", inspection: initial };
    }

    if (initial.state === "legacy-v0.1.97") {
      const tables = [...BETTER_AUTH_TABLES].sort();
      await client.query(
        `LOCK TABLE ${tables.map((table) => `public.${identifier(table)}`).join(",")} IN ACCESS EXCLUSIVE MODE`,
      );
      const before = await authTableIdentities({ client, schema: "public" });
      await client.query("CREATE SCHEMA auth");
      await client.query("REVOKE ALL ON SCHEMA auth FROM PUBLIC");
      for (const table of tables) {
        await client.query(`ALTER TABLE public.${identifier(table)} SET SCHEMA auth`);
        await afterTableMoved?.(table);
      }
      const after = await authTableIdentities({ client, schema: "auth" });
      assertIdentitiesPreserved({ before, after });
    }

    await normalizeAdoptedSchema({ client, applicationMigrationSql });
    const target = await assertTargetSchema(client);
    await replaceMigrationLedger({ client, streams: targetMigrationStreams });
    await client.query("COMMIT");
    return { action: "transitioned", ...target };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
