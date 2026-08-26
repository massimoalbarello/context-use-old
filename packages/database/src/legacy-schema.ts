import { createHash } from "node:crypto";
import type { Client } from "pg";
import type { AppliedMigration } from "./migration-state.ts";

export const LEGACY_SCHEMA_VERSION = "v0.1.97";

export const LEGACY_MIGRATIONS = [
  {
    version: "001_baseline.sql",
    checksum: "9722866b57be6cdf70fadfb32947483f78e0fa5d0d60a318e9d413eaff70b891",
  },
  {
    version: "002_normalize_retained_bootstrap.sql",
    checksum: "ed5ee1f05a1211a63466ab44e700ce95329026d8c30ba7648447c6c60462f7f8",
  },
  {
    version: "003_close_filesystem_deprecation.sql",
    checksum: "47e42f4050de09656d33ca8a5ec4da57a457a15edf4040d9be4f4440fb8d82d1",
  },
  {
    version: "004_full_knowledge_bundles.sql",
    checksum: "53fccf99c34dd6532b54008632a11a06be6aa9fff1110acd14ef3194d321c2d4",
  },
  {
    version: "005_add_dashboard_catalog_types.sql",
    checksum: "3b7f3dacb028cd67ad9221af7a2db157a0dfe5e1901e9393d9d5018aa55b6ebe",
  },
  {
    version: "006_neutral_blob_keys.sql",
    checksum: "3b9e3a0b9613841d9a7d508af2e64224eb9d5985309936c01e3b21577e54f1a8",
  },
  {
    version: "007_fix_full_knowledge_bundle_boundaries.sql",
    checksum: "9b076c253fafab1e6ffad5a203a0a312bfffe9415eec385a3e693c14a7513ad6",
  },
  {
    version: "008_allow_export_confirmation_preflight.sql",
    checksum: "3c520e2d9d6100080484f567cd256e8ba9383298e1729090a9db9fc71151912e",
  },
  {
    version: "009_add_knowledge_entity_types.sql",
    checksum: "a138cbeac68b8d66beddde70c7a11706b7435854ef5a1cbf9f1559eab18f7fde",
  },
  {
    version: "010_source_record_lifecycle.sql",
    checksum: "88ef425d28463d1a2f788284858cf561c57475dc857fba23ed1f12396d0d9ce6",
  },
] as const;

export const BETTER_AUTH_TABLES = [
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
] as const;

// Generated from a fresh v0.1.97 database by authStructureFingerprint(). The
// digest deliberately excludes row data and includes only the auth tables'
// structural catalog surface and privileges.
export const LEGACY_AUTH_STRUCTURE_FINGERPRINT =
  "29896142b2cec5923a294a2c61440c8cc5e2e47f11524e280f58c09a2df0d010";

type AuthStructureRow = {
  kind: string;
  identity: string;
  definition: string;
};

export type LegacySchemaInspection =
  | { state: "fresh" }
  | { state: "legacy-v0.1.97"; authStructureFingerprint: string }
  | { state: "unsupported"; reasons: string[] };

export function legacyStateFromInspection({
  migrations,
  relations,
  hasAuthSchema,
  authStructureFingerprint,
}: {
  migrations: AppliedMigration[];
  relations: Array<{ schema: string; table: string }>;
  hasAuthSchema: boolean;
  authStructureFingerprint: string | null;
}): LegacySchemaInspection {
  if (migrations.length === 0 && relations.length === 0 && !hasAuthSchema) {
    return { state: "fresh" };
  }

  const reasons: string[] = [];
  if (migrations.length !== LEGACY_MIGRATIONS.length) {
    reasons.push(
      `expected ${LEGACY_MIGRATIONS.length} legacy migrations, found ${migrations.length}`,
    );
  }
  for (const [index, expected] of LEGACY_MIGRATIONS.entries()) {
    const actual = migrations[index];
    if (!actual) {
      continue;
    }
    if (actual.version !== expected.version || actual.checksum !== expected.checksum) {
      reasons.push(`migration ${index + 1} does not match ${expected.version}`);
    }
  }

  const locations = new Map<string, string[]>();
  for (const relation of relations) {
    const schemas = locations.get(relation.table) ?? [];
    schemas.push(relation.schema);
    locations.set(relation.table, schemas);
  }
  for (const table of BETTER_AUTH_TABLES) {
    const schemas = locations.get(table) ?? [];
    if (schemas.length !== 1 || schemas[0] !== "public") {
      reasons.push(
        `expected public.${table} exactly once, found ${schemas.length ? schemas.join(", ") : "nothing"}`,
      );
    }
  }
  if (hasAuthSchema) {
    reasons.push("expected the auth schema to be absent");
  }

  if (authStructureFingerprint !== LEGACY_AUTH_STRUCTURE_FINGERPRINT) {
    reasons.push(
      `Better Auth table structure does not match v0.1.97: expected ${LEGACY_AUTH_STRUCTURE_FINGERPRINT}, ` +
        `found ${authStructureFingerprint ?? "nothing"}`,
    );
  }
  if (reasons.length) {
    return { state: "unsupported", reasons };
  }
  if (!authStructureFingerprint) {
    throw new Error("Legacy auth structure fingerprint invariant failed");
  }
  return { state: "legacy-v0.1.97", authStructureFingerprint };
}

export async function authStructureFingerprint(client: Client): Promise<string | null> {
  const result = await client.query<AuthStructureRow>(
    `
    WITH auth_relations AS (
      SELECT relation.oid
      FROM pg_catalog.pg_class AS relation
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid=relation.relnamespace
      WHERE relation.relkind IN ('r','p')
        AND relation.relname=ANY($1::text[])
        AND namespace.nspname NOT IN ('pg_catalog','information_schema')
        AND namespace.nspname NOT LIKE 'pg_toast%'
        AND namespace.nspname NOT LIKE 'pg_temp_%'
    )
    SELECT kind,identity,definition
    FROM (
      SELECT
        'relation'::text AS kind,
        format('%I.%I',namespace.nspname,relation.relname) AS identity,
        concat_ws('|',relation.relkind,owner.rolname,COALESCE(relation.relacl::text,''),
          relation.relrowsecurity,relation.relforcerowsecurity) AS definition
      FROM auth_relations AS selected
      JOIN pg_catalog.pg_class AS relation ON relation.oid=selected.oid
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid=relation.relnamespace
      JOIN pg_catalog.pg_roles AS owner ON owner.oid=relation.relowner

      UNION ALL

      SELECT
        'column',
        format('%I.%I.%I',namespace.nspname,relation.relname,attribute.attname),
        concat_ws('|',attribute.attnum,
          pg_catalog.format_type(attribute.atttypid,attribute.atttypmod),
          attribute.attnotnull,COALESCE(pg_catalog.pg_get_expr(default_value.adbin,default_value.adrelid),''),
          attribute.attidentity,attribute.attgenerated,COALESCE(attribute.attacl::text,''))
      FROM auth_relations AS selected
      JOIN pg_catalog.pg_class AS relation ON relation.oid=selected.oid
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid=relation.relnamespace
      JOIN pg_catalog.pg_attribute AS attribute ON attribute.attrelid=relation.oid
      LEFT JOIN pg_catalog.pg_attrdef AS default_value
        ON default_value.adrelid=attribute.attrelid AND default_value.adnum=attribute.attnum
      WHERE attribute.attnum>0 AND NOT attribute.attisdropped

      UNION ALL

      SELECT
        'constraint',
        format('%I.%I',namespace.nspname,constraint_row.conname),
        concat_ws('|',constraint_row.contype,
          pg_catalog.pg_get_constraintdef(constraint_row.oid,true),
          constraint_row.condeferrable,constraint_row.condeferred,constraint_row.convalidated)
      FROM pg_catalog.pg_constraint AS constraint_row
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid=constraint_row.connamespace
      WHERE constraint_row.conrelid IN (SELECT oid FROM auth_relations)
         OR constraint_row.confrelid IN (SELECT oid FROM auth_relations)

      UNION ALL

      SELECT
        'index',
        format('%I.%I',namespace.nspname,index_relation.relname),
        pg_catalog.pg_get_indexdef(index_relation.oid)
      FROM pg_catalog.pg_index AS index_row
      JOIN pg_catalog.pg_class AS index_relation ON index_relation.oid=index_row.indexrelid
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid=index_relation.relnamespace
      WHERE index_row.indrelid IN (SELECT oid FROM auth_relations)

      UNION ALL

      SELECT
        'trigger',
        format('%I.%I',namespace.nspname,trigger_row.tgname),
        pg_catalog.pg_get_triggerdef(trigger_row.oid,true)
      FROM pg_catalog.pg_trigger AS trigger_row
      JOIN pg_catalog.pg_class AS relation ON relation.oid=trigger_row.tgrelid
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid=relation.relnamespace
      WHERE trigger_row.tgrelid IN (SELECT oid FROM auth_relations)
        AND NOT trigger_row.tgisinternal

      UNION ALL

      SELECT
        'policy',
        format('%I.%I',namespace.nspname,policy.polname),
        concat_ws('|',policy.polcmd,policy.polpermissive,policy.polroles::text,
          COALESCE(pg_catalog.pg_get_expr(policy.polqual,policy.polrelid),''),
          COALESCE(pg_catalog.pg_get_expr(policy.polwithcheck,policy.polrelid),''))
      FROM pg_catalog.pg_policy AS policy
      JOIN pg_catalog.pg_class AS relation ON relation.oid=policy.polrelid
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid=relation.relnamespace
      WHERE policy.polrelid IN (SELECT oid FROM auth_relations)
    ) AS structure
    ORDER BY kind,identity,definition
  `,
    [[...BETTER_AUTH_TABLES]],
  );
  if (result.rows.length === 0) {
    return null;
  }
  return createHash("sha256").update(JSON.stringify(result.rows)).digest("hex");
}

export async function inspectLegacySchema(client: Client): Promise<LegacySchemaInspection> {
  const ledgerPresent = await client.query<{ present: boolean }>(
    "SELECT pg_catalog.to_regclass('public.schema_migrations') IS NOT NULL AS present",
  );
  const migrations = ledgerPresent.rows[0]?.present
    ? (
        await client.query<AppliedMigration>(
          "SELECT version,checksum FROM public.schema_migrations ORDER BY version",
        )
      ).rows
    : [];
  const relations = (
    await client.query<{ schema: string; table: string }>(`
    SELECT namespace.nspname AS schema,relation.relname AS table
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid=relation.relnamespace
    WHERE relation.relkind IN ('r','p')
      AND namespace.nspname NOT IN ('pg_catalog','information_schema')
      AND namespace.nspname NOT LIKE 'pg_toast%'
      AND namespace.nspname NOT LIKE 'pg_temp_%'
    ORDER BY namespace.nspname,relation.relname
  `)
  ).rows;
  const applicationRelations = relations.filter(
    ({ schema, table }) =>
      schema !== "context_use_deployment_internal" && table !== "schema_migrations",
  );
  const authSchema = await client.query<{ present: boolean }>(
    "SELECT pg_catalog.to_regnamespace('auth') IS NOT NULL AS present",
  );
  return legacyStateFromInspection({
    migrations,
    relations: applicationRelations,
    hasAuthSchema: authSchema.rows[0]?.present ?? false,
    authStructureFingerprint: await authStructureFingerprint(client),
  });
}
