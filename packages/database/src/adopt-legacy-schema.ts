import type { Client } from "pg";
import {
  BETTER_AUTH_TABLES,
  inspectLegacySchema,
  type LegacySchemaInspection,
} from "./legacy-schema.ts";
import { restoreOwnershipContractPending } from "./restore-ownership.ts";

export const LEGACY_ADOPTION_ENV = "CONTEXT_USE_ADOPT_LEGACY_SCHEMA";
export const LEGACY_ADOPTION_CONFIRMATION = "v0.1.97";

type AuthTableIdentity = {
  table: string;
  oid: number;
  rows: string;
};

export type LegacyAdoptionResult = {
  action: "adopted" | "already-adopted" | "not-required";
  inspection: Exclude<LegacySchemaInspection, { state: "unsupported" }>;
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

export async function adoptLegacySchema({
  client,
  afterTableMoved,
}: {
  client: Client;
  afterTableMoved?: (table: string) => void | Promise<void>;
}): Promise<LegacyAdoptionResult> {
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
    const initial = await inspectLegacySchema(client);
    if (initial.state === "unsupported") {
      throw new Error(`Refusing legacy schema adoption: ${initial.reasons.join("; ")}`);
    }
    if (initial.state === "fresh") {
      await client.query("COMMIT");
      return { action: "not-required", inspection: initial };
    }
    if (initial.state === "legacy-auth-adopted") {
      await client.query("COMMIT");
      return { action: "already-adopted", inspection: initial };
    }

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

    const adopted = await inspectLegacySchema(client);
    if (adopted.state !== "legacy-auth-adopted") {
      const detail = adopted.state === "unsupported" ? adopted.reasons.join("; ") : adopted.state;
      throw new Error(`Legacy schema adoption did not reach its verified target: ${detail}`);
    }
    await client.query("COMMIT");
    return { action: "adopted", inspection: adopted };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
