import { createHash } from "node:crypto";
import type { Client } from "pg";

export const RESTORE_OWNERSHIP_SCHEMA = "context_use_deployment_internal";
export const PREPARE_RESTORE_OWNERSHIP_ENV = "MIGRATOR_PREPARE_RESTORE_OWNERSHIP";
export const RECONCILE_RESTORE_OWNERSHIP_ENV = "MIGRATOR_RECONCILE_RESTORE_OWNERSHIP";

const CONTRACT_VERSION = 2;
const OWNER_ROLE_PATTERN = /^context_use_[a-z0-9_]+_owner$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

type RoutineKind = "function" | "procedure" | "aggregate" | "window_function";
type RelationKind = "view" | "materialized_view";
type OwnedObjectKind = RoutineKind | RelationKind;

type OwnedObject = {
  object_kind: OwnedObjectKind;
  schema_name: string;
  object_name: string;
  identity_arguments: string;
  owner_role_oid: string;
  owner_role_name: string;
  definition_payload: string;
  acl_payload: string;
};

type ManifestObject = Omit<OwnedObject, "definition_payload" | "acl_payload"> & {
  definition_sha256: string;
  acl_sha256: string;
};

export type RestoreOwnershipMigration = {
  version: string;
  checksum: string;
};

export type RestoreOwnershipPublicSchema = {
  owner_role_oid: string;
  owner_role_name: string;
  acl_sha256: string;
};

export type RestoreOwnershipDefaultAcl = {
  defining_role_oid: string;
  defining_role_name: string;
  schema_name: string;
  object_type: string;
  acl_sha256: string;
};

export type RestoreOwnerRoleState = {
  role_oid: string;
  role_name: string;
  rolsuper: boolean;
  rolinherit: boolean;
  rolcreaterole: boolean;
  rolcreatedb: boolean;
  rolcanlogin: boolean;
  rolreplication: boolean;
  rolbypassrls: boolean;
  rolconfig: string[] | null;
  memberships: string[];
};

type RoleState = RestoreOwnerRoleState;

type ManifestRole = {
  role_oid: string;
  role_name: string;
  state_sha256: string;
};

type Administrator = {
  role_oid: string;
  role_name: string;
  rolsuper: boolean;
};

type ContractManifest = {
  contract_version: number;
  preparer_role_oid: string;
  preparer_role_name: string;
  object_count: number;
  role_count: number;
  migration_count: number;
  default_acl_count: number;
  public_schema_owner_oid: string;
  public_schema_owner_name: string;
  public_schema_acl_sha256: string;
  manifest_sha256: string;
};

type RestoreOwnershipContract = {
  manifest: ContractManifest;
  roles: ManifestRole[];
  objects: ManifestObject[];
  migrations: RestoreOwnershipMigration[];
  publicSchema: RestoreOwnershipPublicSchema;
  defaultAcls: RestoreOwnershipDefaultAcl[];
};

function normalizedAclSql(
  aclExpression: string,
  ownerExpression: string,
  defaultObjectType?: string,
): string {
  const effectiveAcl = defaultObjectType
    ? `COALESCE(${aclExpression},pg_catalog.acldefault('${defaultObjectType}',${ownerExpression}))`
    : aclExpression;
  const identity = (oid: string, roleName: string) => `CASE
    WHEN ${oid}=0 THEN pg_catalog.jsonb_build_object('kind','public')
    WHEN ${oid}=${ownerExpression} THEN pg_catalog.jsonb_build_object('kind','owner')
    ELSE pg_catalog.jsonb_build_object('kind','role','oid',${oid}::text,'name',${roleName})
  END`;
  const sortIdentity = (oid: string, roleName: string) => `CASE
    WHEN ${oid}=0 THEN '0:public'
    WHEN ${oid}=${ownerExpression} THEN '1:owner'
    ELSE pg_catalog.format('2:role:%s:%s',${oid},${roleName})
  END`;
  return `COALESCE((
    SELECT pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'grantor',${identity("acl.grantor", "grantor.rolname")},
        'grantee',${identity("acl.grantee", "grantee.rolname")},
        'privilege',acl.privilege_type,
        'grantable',acl.is_grantable
      ) ORDER BY
        ${sortIdentity("acl.grantee", "grantee.rolname")},
        acl.privilege_type,
        acl.is_grantable,
        ${sortIdentity("acl.grantor", "grantor.rolname")}
    )
    FROM pg_catalog.aclexplode(${effectiveAcl}) AS acl
    LEFT JOIN pg_catalog.pg_roles AS grantor ON grantor.oid=acl.grantor
    LEFT JOIN pg_catalog.pg_roles AS grantee ON grantee.oid=acl.grantee
  ),'[]'::jsonb)`;
}

const routineAclSql = normalizedAclSql("p.proacl", "p.proowner", "f");
const relationAclSql = normalizedAclSql("c.relacl", "c.relowner", "r");
const columnAclSql = normalizedAclSql("attribute.attacl", "c.relowner", "c");

const CONTRACT_FINGERPRINT_FUNCTION = "restore_contract_fingerprint";
const RESET_DEFAULT_ACLS_FUNCTION = "reset_default_acls_for_restore";
const RESET_DEFAULT_ACLS_BODY = `
DECLARE
  defaults record;
  grantee record;
  privilege_target text;
  schema_clause text;
  grantee_sql text;
BEGIN
  FOR defaults IN
    SELECT acl.defaclrole,definer.rolname AS definer_name,
      namespace.nspname AS schema_name,acl.defaclobjtype,acl.defaclacl
    FROM pg_catalog.pg_default_acl AS acl
    JOIN pg_catalog.pg_roles AS definer ON definer.oid=acl.defaclrole
    LEFT JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid=acl.defaclnamespace
    WHERE acl.defaclrole IN (
      SELECT manifest.preparer_role_oid FROM ${RESTORE_OWNERSHIP_SCHEMA}.manifest AS manifest
      UNION
      SELECT role.role_oid FROM ${RESTORE_OWNERSHIP_SCHEMA}.roles AS role
    )
      AND (acl.defaclnamespace=0 OR namespace.nspname='public')
    ORDER BY acl.defaclrole,acl.defaclnamespace,acl.defaclobjtype
  LOOP
    privilege_target := CASE defaults.defaclobjtype
      WHEN 'r' THEN 'TABLES'
      WHEN 'S' THEN 'SEQUENCES'
      WHEN 'f' THEN 'FUNCTIONS'
      WHEN 'T' THEN 'TYPES'
      WHEN 'n' THEN 'SCHEMAS'
      WHEN 'L' THEN 'LARGE OBJECTS'
      ELSE NULL
    END;
    IF privilege_target IS NULL THEN
      RAISE EXCEPTION 'Unsupported protected default ACL object type %',defaults.defaclobjtype;
    END IF;
    schema_clause := CASE WHEN defaults.schema_name IS NULL THEN ''
      ELSE pg_catalog.format(' IN SCHEMA %I',defaults.schema_name) END;
    FOR grantee IN
      SELECT DISTINCT exploded.grantee,role.rolname
      FROM pg_catalog.aclexplode(defaults.defaclacl) AS exploded
      LEFT JOIN pg_catalog.pg_roles AS role ON role.oid=exploded.grantee
    LOOP
      grantee_sql := CASE WHEN grantee.grantee=0 THEN 'PUBLIC'
        ELSE pg_catalog.format('%I',grantee.rolname) END;
      EXECUTE pg_catalog.format(
        'ALTER DEFAULT PRIVILEGES FOR ROLE %I%s REVOKE ALL PRIVILEGES ON %s FROM %s CASCADE',
        defaults.definer_name,schema_clause,privilege_target,grantee_sql
      );
    END LOOP;
    IF defaults.schema_name IS NULL THEN
      EXECUTE pg_catalog.format(
        'ALTER DEFAULT PRIVILEGES FOR ROLE %I GRANT ALL PRIVILEGES ON %s TO %I',
        defaults.definer_name,privilege_target,defaults.definer_name
      );
      IF defaults.defaclobjtype='f' THEN
        EXECUTE pg_catalog.format(
          'ALTER DEFAULT PRIVILEGES FOR ROLE %I GRANT EXECUTE ON FUNCTIONS TO PUBLIC',
          defaults.definer_name
        );
      ELSIF defaults.defaclobjtype='T' THEN
        EXECUTE pg_catalog.format(
          'ALTER DEFAULT PRIVILEGES FOR ROLE %I GRANT USAGE ON TYPES TO PUBLIC',
          defaults.definer_name
        );
      END IF;
    END IF;
  END LOOP;
END
`;
const CONTRACT_FINGERPRINT_BODY = `
  SELECT pg_catalog.jsonb_build_object(
    'namespace',(
      SELECT pg_catalog.jsonb_build_array(
        namespace.oid::text,namespace.nspname,namespace.nspowner::text,namespace.nspacl::text
      )
      FROM pg_catalog.pg_namespace AS namespace
      WHERE namespace.nspname='${RESTORE_OWNERSHIP_SCHEMA}'
    ),
    'relations',COALESCE((
      SELECT pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_array(
          relation.oid::text,relation.relname,relation.relkind,
          relation.relowner::text,relation.relacl::text,
          COALESCE((
            SELECT pg_catalog.jsonb_agg(
              pg_catalog.jsonb_build_array(attribute.attnum,attribute.attacl::text)
              ORDER BY attribute.attnum
            )
            FROM pg_catalog.pg_attribute AS attribute
            WHERE attribute.attrelid=relation.oid AND attribute.attnum>0
          ),'[]'::jsonb)
        ) ORDER BY relation.relname
      )
      FROM pg_catalog.pg_class AS relation
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid=relation.relnamespace
      WHERE namespace.nspname='${RESTORE_OWNERSHIP_SCHEMA}'
    ),'[]'::jsonb),
    'routines',COALESCE((
      SELECT pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_array(
          routine.oid::text,routine.proname,routine.prokind,routine.proowner::text,
          routine.proacl::text,routine.prosecdef,routine.proconfig,
          language.lanname,pg_catalog.pg_get_function_result(routine.oid),
          pg_catalog.pg_get_function_identity_arguments(routine.oid),
          pg_catalog.pg_get_functiondef(routine.oid)
        ) ORDER BY routine.proname,pg_catalog.pg_get_function_identity_arguments(routine.oid)
      )
      FROM pg_catalog.pg_proc AS routine
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid=routine.pronamespace
      JOIN pg_catalog.pg_language AS language ON language.oid=routine.prolang
      WHERE namespace.nspname='${RESTORE_OWNERSHIP_SCHEMA}'
    ),'[]'::jsonb),
    'manifest',COALESCE((
      SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(row) ORDER BY row.singleton)
      FROM ${RESTORE_OWNERSHIP_SCHEMA}.manifest AS row
    ),'[]'::jsonb),
    'roles',COALESCE((
      SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(row) ORDER BY row.role_oid)
      FROM ${RESTORE_OWNERSHIP_SCHEMA}.roles AS row
    ),'[]'::jsonb),
    'objects',COALESCE((
      SELECT pg_catalog.jsonb_agg(
        pg_catalog.to_jsonb(row)
        ORDER BY row.object_kind,row.schema_name,row.object_name,row.identity_arguments
      )
      FROM ${RESTORE_OWNERSHIP_SCHEMA}.objects AS row
    ),'[]'::jsonb),
    'migrations',COALESCE((
      SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(row) ORDER BY row.version)
      FROM ${RESTORE_OWNERSHIP_SCHEMA}.migrations AS row
    ),'[]'::jsonb),
    'default_acls',COALESCE((
      SELECT pg_catalog.jsonb_agg(
        pg_catalog.to_jsonb(row)
        ORDER BY row.defining_role_oid,row.schema_name,row.object_type
      )
      FROM ${RESTORE_OWNERSHIP_SCHEMA}.default_acls AS row
    ),'[]'::jsonb)
  )::text
`;

const ownedObjectsSql = `
  SELECT
    CASE p.prokind
      WHEN 'p' THEN 'procedure'
      WHEN 'a' THEN 'aggregate'
      WHEN 'w' THEN 'window_function'
      ELSE 'function'
    END AS object_kind,
    n.nspname::text AS schema_name,
    p.proname::text AS object_name,
    pg_catalog.pg_get_function_identity_arguments(p.oid) AS identity_arguments,
    owner.oid::text AS owner_role_oid,
    owner.rolname::text AS owner_role_name,
    pg_catalog.jsonb_build_object(
      'prokind', p.prokind,
      'definition', CASE
        WHEN p.prokind='a' THEN pg_catalog.jsonb_build_object(
          'arguments', pg_catalog.pg_get_function_arguments(p.oid),
          'identity_arguments', pg_catalog.pg_get_function_identity_arguments(p.oid),
          'result', pg_catalog.pg_get_function_result(p.oid),
          'language', language.lanname,
          'source', p.prosrc,
          'binary', p.probin,
          'volatility', p.provolatile,
          'parallel', p.proparallel,
          'strict', p.proisstrict,
          'security_definer', p.prosecdef,
          'leakproof', p.proleakproof,
          'config', p.proconfig
        )
        ELSE pg_catalog.to_jsonb(pg_catalog.pg_get_functiondef(p.oid))
      END
    )::text AS definition_payload,
    ${routineAclSql}::text AS acl_payload
  FROM pg_catalog.pg_proc AS p
  JOIN pg_catalog.pg_namespace AS n ON n.oid=p.pronamespace
  JOIN pg_catalog.pg_roles AS owner ON owner.oid=p.proowner
  JOIN pg_catalog.pg_language AS language ON language.oid=p.prolang
  WHERE n.nspname='public'

  UNION ALL

  SELECT
    CASE c.relkind WHEN 'm' THEN 'materialized_view' ELSE 'view' END AS object_kind,
    n.nspname::text AS schema_name,
    c.relname::text AS object_name,
    ''::text AS identity_arguments,
    owner.oid::text AS owner_role_oid,
    owner.rolname::text AS owner_role_name,
    pg_catalog.jsonb_build_object(
      'relkind', c.relkind,
      'definition', pg_catalog.pg_get_viewdef(c.oid, false),
      'options', c.reloptions,
      'columns', COALESCE((
        SELECT pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_array(
            attribute.attname,
            pg_catalog.format_type(attribute.atttypid,attribute.atttypmod),
            attribute.attnotnull
          ) ORDER BY attribute.attnum
        )
        FROM pg_catalog.pg_attribute AS attribute
        WHERE attribute.attrelid=c.oid
          AND attribute.attnum>0
          AND NOT attribute.attisdropped
      ), '[]'::jsonb)
    )::text AS definition_payload,
    pg_catalog.jsonb_build_object(
      'relation',${relationAclSql},
      'columns',COALESCE((
        SELECT pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'name',attribute.attname,
            'acl',${columnAclSql}
          ) ORDER BY attribute.attnum
        )
        FROM pg_catalog.pg_attribute AS attribute
        WHERE attribute.attrelid=c.oid
          AND attribute.attnum>0
          AND NOT attribute.attisdropped
      ),'[]'::jsonb)
    )::text AS acl_payload
  FROM pg_catalog.pg_class AS c
  JOIN pg_catalog.pg_namespace AS n ON n.oid=c.relnamespace
  JOIN pg_catalog.pg_roles AS owner ON owner.oid=c.relowner
  WHERE n.nspname='public' AND c.relkind IN ('v','m')

  ORDER BY object_kind,schema_name,object_name,identity_arguments
`;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function objectKey(object: Pick<ManifestObject, "object_kind" | "schema_name" | "object_name" | "identity_arguments">): string {
  return JSON.stringify([
    object.object_kind,
    object.schema_name,
    object.object_name,
    object.identity_arguments,
  ]);
}

function normalizedRoleState(role: RoleState): string {
  return JSON.stringify({
    role_oid: role.role_oid,
    role_name: role.role_name,
    rolsuper: role.rolsuper,
    rolinherit: role.rolinherit,
    rolcreaterole: role.rolcreaterole,
    rolcreatedb: role.rolcreatedb,
    rolcanlogin: role.rolcanlogin,
    rolreplication: role.rolreplication,
    rolbypassrls: role.rolbypassrls,
    rolconfig: [...(role.rolconfig ?? [])].sort(),
    memberships: [...role.memberships].sort(),
  });
}

export function restoreOwnershipPreparationRequested(value: string | undefined): boolean {
  if (value === undefined || value === "") return false;
  if (value === "true") return true;
  throw new Error(`${PREPARE_RESTORE_OWNERSHIP_ENV} must be exactly "true" when set`);
}

export function restoreOwnershipReconciliationRequested(value: string | undefined): boolean {
  if (value === undefined || value === "") return false;
  if (value === "true") return true;
  throw new Error(`${RECONCILE_RESTORE_OWNERSHIP_ENV} must be exactly "true" when set`);
}

export function restoreOwnershipPhase(
  prepareValue: string | undefined,
  reconcileValue: string | undefined,
): "prepare" | "reconcile" | null {
  const prepare = restoreOwnershipPreparationRequested(prepareValue);
  const reconcile = restoreOwnershipReconciliationRequested(reconcileValue);
  if (prepare && reconcile) {
    throw new Error("Restore ownership preparation and reconciliation phases are mutually exclusive");
  }
  return prepare ? "prepare" : reconcile ? "reconcile" : null;
}

export function assertLeastPrivilegeOwnerRole(role: RoleState): void {
  if (!OWNER_ROLE_PATTERN.test(role.role_name)) {
    throw new Error(`Restore ownership role ${JSON.stringify(role.role_name)} is not an approved owner identity`);
  }
  const elevated = [
    role.rolsuper,
    role.rolinherit,
    role.rolcreaterole,
    role.rolcreatedb,
    role.rolcanlogin,
    role.rolreplication,
    role.rolbypassrls,
  ].some(Boolean);
  if (elevated || role.memberships.length) {
    throw new Error(`Restore ownership role ${role.role_name} is not an isolated NOLOGIN role`);
  }
}

export function restoreOwnershipManifestChecksum(
  roles: readonly ManifestRole[],
  objects: readonly ManifestObject[],
  migrations: readonly RestoreOwnershipMigration[],
  publicSchema: RestoreOwnershipPublicSchema,
  defaultAcls: readonly RestoreOwnershipDefaultAcl[],
): string {
  return sha256(JSON.stringify({
    contract_version: CONTRACT_VERSION,
    roles: [...roles].sort((left, right) => left.role_oid.localeCompare(right.role_oid)),
    objects: [...objects].sort((left, right) => objectKey(left).localeCompare(objectKey(right))),
    migrations: migrations.map(({ version, checksum }) => ({ version, checksum }))
      .sort((left, right) => left.version.localeCompare(right.version)),
    public_schema: publicSchema,
    default_acls: [...defaultAcls].sort((left, right) => defaultAclKey(left).localeCompare(defaultAclKey(right))),
  }));
}

function defaultAclKey(acl: RestoreOwnershipDefaultAcl): string {
  return JSON.stringify([
    acl.defining_role_oid,
    acl.defining_role_name,
    acl.schema_name,
    acl.object_type,
  ]);
}

function validateMigrations(migrations: readonly RestoreOwnershipMigration[]): void {
  if (!migrations.length) throw new Error("Restore ownership release has no migrations");
  const versions = new Set<string>();
  for (const migration of migrations) {
    if (!migration.version || versions.has(migration.version) || !SHA256_PATTERN.test(migration.checksum)) {
      throw new Error(`Invalid restore ownership release migration ${JSON.stringify(migration.version)}`);
    }
    versions.add(migration.version);
  }
}

async function administrator(client: Client): Promise<Administrator> {
  const result = await client.query<Administrator>(`
    SELECT oid::text AS role_oid,rolname::text AS role_name,rolsuper
    FROM pg_catalog.pg_roles
    WHERE rolname=current_user
  `);
  const admin = result.rows[0];
  if (!admin || result.rowCount !== 1 || !admin.rolsuper) {
    throw new Error("Restore ownership preparation and reconciliation require the migration superuser");
  }
  return admin;
}

async function roleStates(client: Client, roleOids: readonly string[]): Promise<RoleState[]> {
  if (!roleOids.length) return [];
  const result = await client.query<RoleState>(`
    SELECT
      role.oid::text AS role_oid,
      role.rolname::text AS role_name,
      role.rolsuper,
      role.rolinherit,
      role.rolcreaterole,
      role.rolcreatedb,
      role.rolcanlogin,
      role.rolreplication,
      role.rolbypassrls,
      role.rolconfig,
      COALESCE((
        SELECT pg_catalog.array_agg(membership::text ORDER BY membership::text)
        FROM (
          SELECT pg_catalog.format('member-of:%s:set=%s:inherit=%s:admin=%s',
            granted.rolname,m.set_option,m.inherit_option,m.admin_option) AS membership
          FROM pg_catalog.pg_auth_members AS m
          JOIN pg_catalog.pg_roles AS granted ON granted.oid=m.roleid
          WHERE m.member=role.oid
          UNION ALL
          SELECT pg_catalog.format('member:%s:set=%s:inherit=%s:admin=%s',
            member.rolname,m.set_option,m.inherit_option,m.admin_option) AS membership
          FROM pg_catalog.pg_auth_members AS m
          JOIN pg_catalog.pg_roles AS member ON member.oid=m.member
          WHERE m.roleid=role.oid
        ) AS role_memberships
      ), ARRAY[]::text[]) AS memberships
    FROM pg_catalog.pg_roles AS role
    WHERE role.oid=ANY($1::oid[])
    ORDER BY role.oid
  `, [roleOids]);
  return result.rows;
}

async function publicSchemaState(client: Client): Promise<RestoreOwnershipPublicSchema> {
  const schemaAclSql = normalizedAclSql("namespace.nspacl", "namespace.nspowner", "n");
  const result = await client.query<{
    owner_role_oid: string;
    owner_role_name: string;
    acl_payload: string;
  }>(`
    SELECT owner.oid::text AS owner_role_oid,owner.rolname::text AS owner_role_name,
      ${schemaAclSql}::text AS acl_payload
    FROM pg_catalog.pg_namespace AS namespace
    JOIN pg_catalog.pg_roles AS owner ON owner.oid=namespace.nspowner
    WHERE namespace.nspname='public'
  `);
  const schema = result.rows[0];
  if (result.rowCount !== 1 || !schema) throw new Error("The public schema is missing or ambiguous");
  return {
    owner_role_oid: schema.owner_role_oid,
    owner_role_name: schema.owner_role_name,
    acl_sha256: sha256(schema.acl_payload),
  };
}

async function assertSafePublicSchemaForPreparation(client: Client): Promise<void> {
  const result = await client.query<{
    owner_role_name: string;
    non_owner_create_grants: string;
  }>(`
    SELECT owner.rolname::text AS owner_role_name,
      count(*) FILTER (
        WHERE acl.privilege_type='CREATE' AND acl.grantee<>namespace.nspowner
      )::text AS non_owner_create_grants
    FROM pg_catalog.pg_namespace AS namespace
    JOIN pg_catalog.pg_roles AS owner ON owner.oid=namespace.nspowner
    CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(
      namespace.nspacl,pg_catalog.acldefault('n',namespace.nspowner)
    )) AS acl
    WHERE namespace.nspname='public'
    GROUP BY owner.rolname
  `);
  if (result.rowCount !== 1
      || result.rows[0]?.owner_role_name !== "pg_database_owner"
      || result.rows[0]?.non_owner_create_grants !== "0") {
    throw new Error("Restore ownership preparation requires a pg_database_owner-owned public schema with no non-owner CREATE grant");
  }
}

async function assertSafeDefaultAclsForPreparation(
  client: Client,
  admin: Administrator,
  protectedRoleOids: readonly string[],
): Promise<void> {
  const result = await client.query<{
    default_row_count: string;
    defining_role_oid: string | null;
    defining_role_name: string | null;
    schema_name: string | null;
    object_type: string | null;
    grantor_oid: string | null;
    grantor_name: string | null;
    grantee_name: string | null;
    privilege_type: string | null;
    is_grantable: boolean | null;
  }>(`
    WITH protected_defaults AS (
      SELECT defaults.*
      FROM pg_catalog.pg_default_acl AS defaults
      LEFT JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid=defaults.defaclnamespace
      WHERE defaults.defaclrole=ANY($1::oid[])
        AND (defaults.defaclnamespace=0 OR namespace.nspname='public')
    ), entries AS (
      SELECT defaults.defaclrole,defaults.defaclobjtype,
        COALESCE(namespace.nspname,'')::text AS schema_name,
        acl.grantor,acl.grantee,acl.privilege_type,acl.is_grantable
      FROM protected_defaults AS defaults
      LEFT JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid=defaults.defaclnamespace
      CROSS JOIN LATERAL pg_catalog.aclexplode(defaults.defaclacl) AS acl
    )
    SELECT (SELECT count(*)::text FROM protected_defaults) AS default_row_count,
      defining_role.oid::text AS defining_role_oid,
      defining_role.rolname::text AS defining_role_name,
      entries.schema_name,entries.defaclobjtype::text AS object_type,
      grantor.oid::text AS grantor_oid,grantor.rolname::text AS grantor_name,
      grantee.rolname::text AS grantee_name,
      entries.privilege_type,entries.is_grantable
    FROM entries
    JOIN pg_catalog.pg_roles AS defining_role ON defining_role.oid=entries.defaclrole
    LEFT JOIN pg_catalog.pg_roles AS grantor ON grantor.oid=entries.grantor
    LEFT JOIN pg_catalog.pg_roles AS grantee ON grantee.oid=entries.grantee
  `, [[admin.role_oid, ...protectedRoleOids]]);
  const row = result.rows[0];
  if (result.rowCount !== 1 || !row || row.default_row_count !== "1"
      || row.defining_role_oid !== admin.role_oid
      || row.defining_role_name !== admin.role_name
      || row.schema_name !== "public"
      || row.object_type !== "S"
      || row.grantor_oid !== admin.role_oid
      || row.grantor_name !== admin.role_name
      || row.grantee_name !== "context_use_backup"
      || row.privilege_type !== "SELECT"
      || row.is_grantable !== false) {
    throw new Error(
      "Restore ownership preparation requires the exact public-sequence backup default ACL and no other protected defaults",
    );
  }
}

async function defaultAclStates(
  client: Client,
  definingRoleOids: readonly string[],
): Promise<RestoreOwnershipDefaultAcl[]> {
  if (!definingRoleOids.length) return [];
  const defaultAclSql = normalizedAclSql("defaults.defaclacl", "defaults.defaclrole");
  const result = await client.query<RestoreOwnershipDefaultAcl & { acl_payload: string }>(`
    SELECT defining_role.oid::text AS defining_role_oid,
      defining_role.rolname::text AS defining_role_name,
      COALESCE(namespace.nspname,'')::text AS schema_name,
      defaults.defaclobjtype::text AS object_type,
      ${defaultAclSql}::text AS acl_payload
    FROM pg_catalog.pg_default_acl AS defaults
    JOIN pg_catalog.pg_roles AS defining_role ON defining_role.oid=defaults.defaclrole
    LEFT JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid=defaults.defaclnamespace
    WHERE defaults.defaclrole=ANY($1::oid[])
      AND (defaults.defaclnamespace=0 OR namespace.nspname='public')
    ORDER BY defining_role.oid,COALESCE(namespace.nspname,''),defaults.defaclobjtype
  `, [definingRoleOids]);
  return result.rows.map((row) => ({
    defining_role_oid: row.defining_role_oid,
    defining_role_name: row.defining_role_name,
    schema_name: row.schema_name,
    object_type: row.object_type,
    acl_sha256: sha256(row.acl_payload),
  }));
}

async function allPublicRoutinesAndViews(client: Client): Promise<OwnedObject[]> {
  // Both callers hold an explicit transaction. Pin name/type resolution for
  // the catalog deparser and temporary-view parser even if the migration role
  // later acquires a per-role or per-database search_path override.
  await client.query("SET LOCAL search_path=pg_catalog,public");
  const result = await client.query<OwnedObject>(ownedObjectsSql);
  for (const object of result.rows) {
    if (object.object_kind !== "view" && object.object_kind !== "materialized_view") continue;
    const relationKind = object.object_kind === "view" ? "v" : "m";
    const statement = await client.query<{ statement: string }>(`
      SELECT pg_catalog.format(
        'CREATE TEMPORARY VIEW %I AS %s',
        'context_use_restore_view_fingerprint',
        pg_catalog.pg_get_viewdef(relation.oid,false)
      ) AS statement
      FROM pg_catalog.pg_class AS relation
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid=relation.relnamespace
      WHERE namespace.nspname=$1 AND relation.relname=$2 AND relation.relkind=$3
    `, [object.schema_name, object.object_name, relationKind]);
    if (statement.rowCount !== 1 || !statement.rows[0]) {
      throw new Error(`Could not canonicalize restore ownership view ${objectKey(object)}`);
    }
    await client.query(statement.rows[0].statement);
    const canonical = await client.query<{ definition: string }>(`
      SELECT pg_catalog.pg_get_viewdef(relation.oid,false) AS definition
      FROM pg_catalog.pg_class AS relation
      WHERE relation.relnamespace=pg_catalog.pg_my_temp_schema()
        AND relation.relname='context_use_restore_view_fingerprint'
        AND relation.relkind='v'
    `);
    await client.query("DROP VIEW pg_temp.context_use_restore_view_fingerprint");
    if (canonical.rowCount !== 1 || !canonical.rows[0]) {
      throw new Error(`Could not read canonical restore ownership view ${objectKey(object)}`);
    }
    const payload = JSON.parse(object.definition_payload) as Record<string, unknown>;
    // pg_get_viewdef is not necessarily idempotent: the first pg_dump replay
    // can add redundant output aliases to UNION branches. Parse/deparse once
    // through a temporary view so both the pre-restore and replayed relation
    // converge on the same semantic representation. Columns and security
    // options remain independently fingerprinted in the payload.
    payload.definition = canonical.rows[0].definition;
    object.definition_payload = JSON.stringify({
      columns: payload.columns,
      options: payload.options,
      relkind: payload.relkind,
      definition: payload.definition,
    });
  }
  return result.rows;
}

async function assertNoUnexpectedAdminSecurityDefiners(
  client: Client,
  admin: Administrator,
  expectedKeys: ReadonlySet<string>,
): Promise<void> {
  const result = await client.query<{
    object_kind: OwnedObjectKind;
    schema_name: string;
    object_name: string;
    identity_arguments: string;
    executable_by: string[];
  }>(`
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
      ARRAY[
        CASE WHEN EXISTS (
          SELECT 1
          FROM pg_catalog.aclexplode(COALESCE(
            routine.proacl,
            pg_catalog.acldefault('f',routine.proowner)
          )) AS acl
          WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE'
        ) THEN 'PUBLIC' END
      ]::text[] || COALESCE((
        SELECT pg_catalog.array_agg(role.rolname::text ORDER BY role.rolname::text)
        FROM pg_catalog.pg_roles AS role
        WHERE role.rolname ~ '^context_use_'
          AND pg_catalog.has_function_privilege(role.oid,routine.oid,'EXECUTE')
      ), ARRAY[]::text[]) AS executable_by
    FROM pg_catalog.pg_proc AS routine
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid=routine.pronamespace
    WHERE namespace.nspname='public'
      AND routine.prosecdef
      AND routine.proowner=$1::oid
    ORDER BY routine.proname,pg_catalog.pg_get_function_identity_arguments(routine.oid)
  `, [admin.role_oid]);
  for (const routine of result.rows) {
    const executableBy = routine.executable_by.filter((role): role is string => role !== null);
    if (executableBy.length && !expectedKeys.has(objectKey(routine))) {
      throw new Error(
        `Unexpected migration-admin-owned SECURITY DEFINER routine ${objectKey(routine)} `
        + `is executable by ${executableBy.join(", ")}`,
      );
    }
  }
}

async function assertNoUnexpectedAdminViews(
  client: Client,
  admin: Administrator,
  expectedKeys: ReadonlySet<string>,
): Promise<void> {
  const result = await client.query<{
    object_kind: RelationKind;
    schema_name: string;
    object_name: string;
    identity_arguments: string;
    selectable_by: string[];
  }>(`
    SELECT
      CASE relation.relkind WHEN 'm' THEN 'materialized_view' ELSE 'view' END AS object_kind,
      namespace.nspname::text AS schema_name,
      relation.relname::text AS object_name,
      ''::text AS identity_arguments,
      ARRAY[
        CASE WHEN EXISTS (
          SELECT 1
          FROM pg_catalog.aclexplode(COALESCE(
            relation.relacl,
            pg_catalog.acldefault('r',relation.relowner)
          )) AS acl
          WHERE acl.grantee=0 AND acl.privilege_type='SELECT'
        ) OR EXISTS (
          SELECT 1
          FROM pg_catalog.pg_attribute AS attribute
          CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS acl
          WHERE attribute.attrelid=relation.oid
            AND attribute.attnum>0
            AND NOT attribute.attisdropped
            AND acl.grantee=0
            AND acl.privilege_type='SELECT'
        ) THEN 'PUBLIC' END
      ]::text[] || COALESCE((
        SELECT pg_catalog.array_agg(role.rolname::text ORDER BY role.rolname::text)
        FROM pg_catalog.pg_roles AS role
        WHERE role.rolname ~ '^context_use_'
          AND (
            pg_catalog.has_table_privilege(role.oid,relation.oid,'SELECT')
            OR pg_catalog.has_any_column_privilege(role.oid,relation.oid,'SELECT')
          )
      ), ARRAY[]::text[]) AS selectable_by
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid=relation.relnamespace
    WHERE namespace.nspname='public'
      AND relation.relkind IN ('v','m')
      AND relation.relowner=$1::oid
    ORDER BY relation.relname
  `, [admin.role_oid]);
  for (const view of result.rows) {
    const selectableBy = view.selectable_by.filter((role): role is string => role !== null);
    if (selectableBy.length && !expectedKeys.has(objectKey(view))) {
      throw new Error(
        `Unexpected migration-admin-owned view ${objectKey(view)} `
        + `is selectable by ${selectableBy.join(", ")}`,
      );
    }
  }
}

function manifestObjects(objects: readonly OwnedObject[]): ManifestObject[] {
  return objects.map((object) => ({
    object_kind: object.object_kind,
    schema_name: object.schema_name,
    object_name: object.object_name,
    identity_arguments: object.identity_arguments,
    owner_role_oid: object.owner_role_oid,
    owner_role_name: object.owner_role_name,
    definition_sha256: sha256(object.definition_payload),
    acl_sha256: sha256(object.acl_payload),
  }));
}

function validateUniqueObjects(objects: readonly ManifestObject[]): void {
  const keys = new Set<string>();
  for (const object of objects) {
    const key = objectKey(object);
    if (keys.has(key)) throw new Error(`Duplicate restore ownership identity ${key}`);
    keys.add(key);
    if (!SHA256_PATTERN.test(object.definition_sha256) || !SHA256_PATTERN.test(object.acl_sha256)) {
      throw new Error(`Invalid restore ownership fingerprint for ${key}`);
    }
  }
}

async function lockContract(client: Client): Promise<void> {
  await client.query("SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('context-use:restore-ownership',0))");
}

/**
 * Snapshot the release's exact privileged routine/view ownership immediately
 * before a plain --no-owner restore. The private schema is deliberately not a
 * migration and must be excluded from every Context Use pg_dump.
 */
export async function prepareRestoreOwnership(
  client: Client,
  migrations: readonly RestoreOwnershipMigration[],
): Promise<number> {
  validateMigrations(migrations);
  await client.query("BEGIN");
  try {
    await lockContract(client);
    if (await restoreOwnershipContractPending(client)) {
      throw new Error("A restore ownership contract is already pending and must be reused or reconciled");
    }
    await client.query("SET LOCAL search_path=pg_catalog,public");
    const admin = await administrator(client);
    await assertSafePublicSchemaForPreparation(client);
    const current = await allPublicRoutinesAndViews(client);
    const contextUseOwned = current.filter(({ owner_role_name }) => owner_role_name.startsWith("context_use_"));
    if (!contextUseOwned.length) throw new Error("No Context Use-owned routines or views were found to protect");

    const objects = manifestObjects(contextUseOwned);
    validateUniqueObjects(objects);
    const roleOids = [...new Set(objects.map(({ owner_role_oid }) => owner_role_oid))].sort();
    const currentRoles = await roleStates(client, roleOids);
    if (currentRoles.length !== roleOids.length) throw new Error("A restore ownership role disappeared during preparation");
    for (const role of currentRoles) assertLeastPrivilegeOwnerRole(role);
    const roles: ManifestRole[] = currentRoles.map((role) => ({
      role_oid: role.role_oid,
      role_name: role.role_name,
      state_sha256: sha256(normalizedRoleState(role)),
    }));
    await assertSafeDefaultAclsForPreparation(client, admin, roleOids);
    const publicSchema = await publicSchemaState(client);
    const defaultAcls = await defaultAclStates(client, [admin.role_oid, ...roleOids]);
    const defaultAclKeys = new Set(defaultAcls.map(defaultAclKey));
    if (defaultAclKeys.size !== defaultAcls.length
        || defaultAcls.some(({ acl_sha256 }) => !SHA256_PATTERN.test(acl_sha256))) {
      throw new Error("Restore ownership default ACL state is duplicate or invalid");
    }
    const manifestSha256 = restoreOwnershipManifestChecksum(
      roles,
      objects,
      migrations,
      publicSchema,
      defaultAcls,
    );

    await client.query(`CREATE SCHEMA ${RESTORE_OWNERSHIP_SCHEMA} AUTHORIZATION CURRENT_USER`);
    await client.query(`
      CREATE TABLE ${RESTORE_OWNERSHIP_SCHEMA}.manifest (
        singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
        contract_version integer NOT NULL CHECK (contract_version=${CONTRACT_VERSION}),
        preparer_role_oid oid NOT NULL,
        preparer_role_name name NOT NULL,
        object_count integer NOT NULL CHECK (object_count>0),
        role_count integer NOT NULL CHECK (role_count>0),
        migration_count integer NOT NULL CHECK (migration_count>0),
        default_acl_count integer NOT NULL CHECK (default_acl_count>=0),
        public_schema_owner_oid oid NOT NULL,
        public_schema_owner_name name NOT NULL,
        public_schema_acl_sha256 text NOT NULL CHECK (public_schema_acl_sha256 ~ '^[a-f0-9]{64}$'),
        manifest_sha256 text NOT NULL CHECK (manifest_sha256 ~ '^[a-f0-9]{64}$'),
        prepared_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp()
      );
      CREATE TABLE ${RESTORE_OWNERSHIP_SCHEMA}.roles (
        role_oid oid PRIMARY KEY,
        role_name name NOT NULL UNIQUE,
        state_sha256 text NOT NULL CHECK (state_sha256 ~ '^[a-f0-9]{64}$'),
        UNIQUE (role_oid,role_name)
      );
      CREATE TABLE ${RESTORE_OWNERSHIP_SCHEMA}.objects (
        object_kind text NOT NULL CHECK (object_kind IN (
          'function','procedure','aggregate','window_function','view','materialized_view'
        )),
        schema_name name NOT NULL CHECK (schema_name='public'),
        object_name name NOT NULL,
        identity_arguments text NOT NULL,
        owner_role_oid oid NOT NULL REFERENCES ${RESTORE_OWNERSHIP_SCHEMA}.roles(role_oid),
        owner_role_name name NOT NULL,
        definition_sha256 text NOT NULL CHECK (definition_sha256 ~ '^[a-f0-9]{64}$'),
        acl_sha256 text NOT NULL CHECK (acl_sha256 ~ '^[a-f0-9]{64}$'),
        PRIMARY KEY (object_kind,schema_name,object_name,identity_arguments),
        FOREIGN KEY (owner_role_oid,owner_role_name)
          REFERENCES ${RESTORE_OWNERSHIP_SCHEMA}.roles(role_oid,role_name)
      );
      CREATE TABLE ${RESTORE_OWNERSHIP_SCHEMA}.migrations (
        version text PRIMARY KEY,
        checksum text NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$')
      );
      CREATE TABLE ${RESTORE_OWNERSHIP_SCHEMA}.default_acls (
        defining_role_oid oid NOT NULL,
        defining_role_name name NOT NULL,
        schema_name text NOT NULL CHECK (schema_name IN ('','public')),
        object_type text NOT NULL CHECK (length(object_type)=1),
        acl_sha256 text NOT NULL CHECK (acl_sha256 ~ '^[a-f0-9]{64}$'),
        PRIMARY KEY (defining_role_oid,schema_name,object_type)
      );
      CREATE FUNCTION ${RESTORE_OWNERSHIP_SCHEMA}.${RESET_DEFAULT_ACLS_FUNCTION}()
      RETURNS void
      LANGUAGE plpgsql
      VOLATILE
      SET search_path=pg_catalog
      AS $reset_default_acls$${RESET_DEFAULT_ACLS_BODY}$reset_default_acls$;
      CREATE FUNCTION ${RESTORE_OWNERSHIP_SCHEMA}.${CONTRACT_FINGERPRINT_FUNCTION}()
      RETURNS text
      LANGUAGE sql
      STABLE
      SET search_path=pg_catalog
      AS $contract_fingerprint$${CONTRACT_FINGERPRINT_BODY}$contract_fingerprint$;
    `);
    // A migration-admin default ACL may grant newly-created schemas or tables
    // to arbitrary roles. Scrub every explicit non-owner principal before any
    // retained rows are written, then validate the exact owner-only ACL shape.
    await client.query(`
      REVOKE ALL ON SCHEMA ${RESTORE_OWNERSHIP_SCHEMA} FROM PUBLIC;
      REVOKE ALL ON ALL TABLES IN SCHEMA ${RESTORE_OWNERSHIP_SCHEMA} FROM PUBLIC;
      REVOKE ALL ON FUNCTION ${RESTORE_OWNERSHIP_SCHEMA}.${CONTRACT_FINGERPRINT_FUNCTION}() FROM PUBLIC;
      REVOKE ALL ON FUNCTION ${RESTORE_OWNERSHIP_SCHEMA}.${RESET_DEFAULT_ACLS_FUNCTION}() FROM PUBLIC;
      DO $restore_contract$
      DECLARE principal name;
      BEGIN
        FOR principal IN
          SELECT role.rolname FROM pg_catalog.pg_roles AS role WHERE role.rolname<>current_user
        LOOP
          EXECUTE pg_catalog.format(
            'REVOKE ALL PRIVILEGES ON SCHEMA %I FROM %I',
            '${RESTORE_OWNERSHIP_SCHEMA}',principal
          );
          EXECUTE pg_catalog.format(
            'REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA %I FROM %I',
            '${RESTORE_OWNERSHIP_SCHEMA}',principal
          );
          EXECUTE pg_catalog.format(
            'REVOKE ALL PRIVILEGES ON FUNCTION %I.%I() FROM %I',
            '${RESTORE_OWNERSHIP_SCHEMA}','${CONTRACT_FINGERPRINT_FUNCTION}',principal
          );
          EXECUTE pg_catalog.format(
            'REVOKE ALL PRIVILEGES ON FUNCTION %I.%I() FROM %I',
            '${RESTORE_OWNERSHIP_SCHEMA}','${RESET_DEFAULT_ACLS_FUNCTION}',principal
          );
        END LOOP;
      END
      $restore_contract$;
    `);

    for (const role of roles) {
      await client.query(`
        INSERT INTO ${RESTORE_OWNERSHIP_SCHEMA}.roles(role_oid,role_name,state_sha256)
        VALUES ($1::oid,$2,$3)
      `, [role.role_oid, role.role_name, role.state_sha256]);
    }
    for (const object of objects) {
      await client.query(`
        INSERT INTO ${RESTORE_OWNERSHIP_SCHEMA}.objects(
          object_kind,schema_name,object_name,identity_arguments,
          owner_role_oid,owner_role_name,definition_sha256,acl_sha256
        ) VALUES ($1,$2,$3,$4,$5::oid,$6,$7,$8)
      `, [
        object.object_kind,
        object.schema_name,
        object.object_name,
        object.identity_arguments,
        object.owner_role_oid,
        object.owner_role_name,
        object.definition_sha256,
        object.acl_sha256,
      ]);
    }
    for (const migration of migrations) {
      await client.query(`
        INSERT INTO ${RESTORE_OWNERSHIP_SCHEMA}.migrations(version,checksum) VALUES ($1,$2)
      `, [migration.version, migration.checksum]);
    }
    for (const acl of defaultAcls) {
      await client.query(`
        INSERT INTO ${RESTORE_OWNERSHIP_SCHEMA}.default_acls(
          defining_role_oid,defining_role_name,schema_name,object_type,acl_sha256
        ) VALUES ($1::oid,$2,$3,$4,$5)
      `, [
        acl.defining_role_oid,
        acl.defining_role_name,
        acl.schema_name,
        acl.object_type,
        acl.acl_sha256,
      ]);
    }
    await client.query(`
      INSERT INTO ${RESTORE_OWNERSHIP_SCHEMA}.manifest(
        contract_version,preparer_role_oid,preparer_role_name,
        object_count,role_count,migration_count,default_acl_count,
        public_schema_owner_oid,public_schema_owner_name,public_schema_acl_sha256,
        manifest_sha256
      ) VALUES ($1,$2::oid,$3,$4,$5,$6,$7,$8::oid,$9,$10,$11)
    `, [
      CONTRACT_VERSION,
      admin.role_oid,
      admin.role_name,
      objects.length,
      roles.length,
      migrations.length,
      defaultAcls.length,
      publicSchema.owner_role_oid,
      publicSchema.owner_role_name,
      publicSchema.acl_sha256,
      manifestSha256,
    ]);
    await validateContractRelations(client, admin);
    await client.query("COMMIT");
    return objects.length;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export async function restoreOwnershipContractPending(client: Client): Promise<boolean> {
  const schema = await client.query<{ schema_oid: string | null }>(`
    SELECT pg_catalog.to_regnamespace($1)::text AS schema_oid
  `, [RESTORE_OWNERSHIP_SCHEMA]);
  return schema.rows[0]?.schema_oid !== null;
}

async function validateContractRelations(client: Client, admin: Administrator): Promise<void> {
  const relationAclSql = normalizedAclSql("c.relacl", "c.relowner", "r");
  const defaultRelationAclSql = normalizedAclSql(
    "pg_catalog.acldefault('r',c.relowner)",
    "c.relowner",
  );
  const relations = await client.query<{
    relation_name: string;
    relation_kind: string;
    owner_role_oid: string;
    owner_role_name: string;
    acl_is_owner_only: boolean;
    has_column_acl: boolean;
  }>(`
    SELECT c.relname::text AS relation_name,c.relkind::text AS relation_kind,
      owner.oid::text AS owner_role_oid,owner.rolname::text AS owner_role_name,
      CASE WHEN c.relkind='r'
        THEN ${relationAclSql}=${defaultRelationAclSql}
        ELSE c.relacl IS NULL
      END AS acl_is_owner_only,
      EXISTS (
        SELECT 1 FROM pg_catalog.pg_attribute AS attribute
        WHERE attribute.attrelid=c.oid AND attribute.attacl IS NOT NULL
      ) AS has_column_acl
    FROM pg_catalog.pg_class AS c
    JOIN pg_catalog.pg_namespace AS n ON n.oid=c.relnamespace
    JOIN pg_catalog.pg_roles AS owner ON owner.oid=c.relowner
    WHERE n.nspname=$1
    ORDER BY c.relname
  `, [RESTORE_OWNERSHIP_SCHEMA]);
  const expected = [
    ["default_acls", "r"],
    ["default_acls_pkey", "i"],
    ["manifest", "r"],
    ["manifest_pkey", "i"],
    ["migrations", "r"],
    ["migrations_pkey", "i"],
    ["objects", "r"],
    ["objects_pkey", "i"],
    ["roles", "r"],
    ["roles_pkey", "i"],
    ["roles_role_name_key", "i"],
    ["roles_role_oid_role_name_key", "i"],
  ] as const;
  if (relations.rows.length !== expected.length
      || relations.rows.some((row, index) => row.relation_name !== expected[index]?.[0]
        || row.relation_kind !== expected[index]?.[1]
        || row.owner_role_oid !== admin.role_oid
        || row.owner_role_name !== admin.role_name
        || !row.acl_is_owner_only
        || row.has_column_acl)) {
    throw new Error(
      "Restore ownership contract relations are missing, unexpected, not migration-admin owned, or accessible to another principal",
    );
  }
  const schemaAclSql = normalizedAclSql("namespace.nspacl", "namespace.nspowner", "n");
  const defaultSchemaAclSql = normalizedAclSql(
    "pg_catalog.acldefault('n',namespace.nspowner)",
    "namespace.nspowner",
  );
  const schema = await client.query<{
    owner_role_oid: string;
    owner_role_name: string;
    acl_is_owner_only: boolean;
  }>(`
    SELECT owner.oid::text AS owner_role_oid,owner.rolname::text AS owner_role_name,
      ${schemaAclSql}=${defaultSchemaAclSql} AS acl_is_owner_only
    FROM pg_catalog.pg_namespace AS namespace
    JOIN pg_catalog.pg_roles AS owner ON owner.oid=namespace.nspowner
    WHERE namespace.nspname=$1
  `, [RESTORE_OWNERSHIP_SCHEMA]);
  if (schema.rowCount !== 1
      || schema.rows[0]?.owner_role_oid !== admin.role_oid
      || schema.rows[0]?.owner_role_name !== admin.role_name
      || !schema.rows[0]?.acl_is_owner_only) {
    throw new Error("Restore ownership contract schema is not private and migration-admin owned");
  }
  const fingerprint = await client.query<{
    routine_name: string;
    owner_role_oid: string;
    owner_role_name: string;
    prosrc: string;
    routine_kind: string;
    security_definer: boolean;
    leakproof: boolean;
    volatility: string;
    language_name: string;
    identity_arguments: string;
    result_type: string;
    config: string[] | null;
    acl_is_owner_only: boolean;
  }>(`
    SELECT routine.proname::text AS routine_name,
      owner.oid::text AS owner_role_oid,owner.rolname::text AS owner_role_name,
      routine.prosrc,
      routine.prokind::text AS routine_kind,routine.prosecdef AS security_definer,
      routine.proleakproof AS leakproof,routine.provolatile::text AS volatility,
      language.lanname::text AS language_name,
      pg_catalog.pg_get_function_identity_arguments(routine.oid) AS identity_arguments,
      pg_catalog.pg_get_function_result(routine.oid) AS result_type,
      routine.proconfig AS config,
      (
        SELECT count(*)=1 AND pg_catalog.bool_and(
          acl.grantor=routine.proowner AND acl.grantee=routine.proowner
          AND acl.privilege_type='EXECUTE' AND NOT acl.is_grantable
        )
        FROM pg_catalog.aclexplode(COALESCE(
          routine.proacl,pg_catalog.acldefault('f',routine.proowner)
        )) AS acl
      ) AS acl_is_owner_only
    FROM pg_catalog.pg_proc AS routine
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid=routine.pronamespace
    JOIN pg_catalog.pg_roles AS owner ON owner.oid=routine.proowner
    JOIN pg_catalog.pg_language AS language ON language.oid=routine.prolang
    WHERE namespace.nspname=$1
  `, [RESTORE_OWNERSHIP_SCHEMA]);
  const expectedRoutines = new Map([
    [CONTRACT_FINGERPRINT_FUNCTION, {
      body: CONTRACT_FINGERPRINT_BODY,
      language: "sql",
      volatility: "s",
      result: "text",
    }],
    [RESET_DEFAULT_ACLS_FUNCTION, {
      body: RESET_DEFAULT_ACLS_BODY,
      language: "plpgsql",
      volatility: "v",
      result: "void",
    }],
  ]);
  if (fingerprint.rowCount !== expectedRoutines.size) {
    throw new Error("Restore ownership contract helper routines are missing or unexpected");
  }
  for (const routine of fingerprint.rows) {
    const expectedRoutine = expectedRoutines.get(routine.routine_name);
    if (!expectedRoutine
        || routine.owner_role_oid !== admin.role_oid
        || routine.owner_role_name !== admin.role_name
        || routine.prosrc !== expectedRoutine.body
        || routine.routine_kind !== "f"
        || routine.security_definer
        || routine.leakproof
        || routine.volatility !== expectedRoutine.volatility
        || routine.language_name !== expectedRoutine.language
        || routine.identity_arguments !== ""
        || routine.result_type !== expectedRoutine.result
        || JSON.stringify(routine.config) !== JSON.stringify(["search_path=pg_catalog"])
        || !routine.acl_is_owner_only) {
      throw new Error("Restore ownership contract helper routine changed or is accessible to another principal");
    }
  }
  const publicAccess = await client.query<{ allowed: boolean }>(`
    SELECT pg_catalog.has_schema_privilege('public',$1,'USAGE')
      OR pg_catalog.has_schema_privilege('public',$1,'CREATE') AS allowed
  `, [RESTORE_OWNERSHIP_SCHEMA]);
  if (publicAccess.rows[0]?.allowed) throw new Error("PUBLIC can access the restore ownership contract");
}

async function readAndValidateContract(
  client: Client,
  admin: Administrator,
  expectedMigrations?: readonly RestoreOwnershipMigration[],
): Promise<RestoreOwnershipContract> {
  await validateContractRelations(client, admin);
  const manifestResult = await client.query<ContractManifest>(`
    SELECT contract_version,preparer_role_oid::text,preparer_role_name::text,
      object_count,role_count,migration_count,default_acl_count,
      public_schema_owner_oid::text,public_schema_owner_name::text,
      public_schema_acl_sha256,manifest_sha256
    FROM ${RESTORE_OWNERSHIP_SCHEMA}.manifest
  `);
  const manifest = manifestResult.rows[0];
  if (manifestResult.rowCount !== 1 || !manifest
      || manifest.contract_version !== CONTRACT_VERSION
      || manifest.preparer_role_oid !== admin.role_oid
      || manifest.preparer_role_name !== admin.role_name
      || !SHA256_PATTERN.test(manifest.public_schema_acl_sha256)
      || !SHA256_PATTERN.test(manifest.manifest_sha256)) {
    throw new Error("Restore ownership contract header is invalid or belongs to another migration administrator");
  }

  const roleResult = await client.query<ManifestRole>(`
    SELECT role_oid::text,role_name::text,state_sha256
    FROM ${RESTORE_OWNERSHIP_SCHEMA}.roles ORDER BY role_oid
  `);
  const objectResult = await client.query<ManifestObject>(`
    SELECT object_kind,schema_name::text,object_name::text,identity_arguments,
      owner_role_oid::text,owner_role_name::text,definition_sha256,acl_sha256
    FROM ${RESTORE_OWNERSHIP_SCHEMA}.objects
    ORDER BY object_kind,schema_name,object_name,identity_arguments
  `);
  const migrationResult = await client.query<RestoreOwnershipMigration>(`
    SELECT version,checksum FROM ${RESTORE_OWNERSHIP_SCHEMA}.migrations ORDER BY version
  `);
  const defaultAclResult = await client.query<RestoreOwnershipDefaultAcl>(`
    SELECT defining_role_oid::text,defining_role_name::text,schema_name,object_type,acl_sha256
    FROM ${RESTORE_OWNERSHIP_SCHEMA}.default_acls
    ORDER BY defining_role_oid,schema_name,object_type
  `);
  const roles = roleResult.rows;
  const objects = objectResult.rows;
  const migrations = migrationResult.rows;
  const defaultAcls = defaultAclResult.rows;
  const publicSchema: RestoreOwnershipPublicSchema = {
    owner_role_oid: manifest.public_schema_owner_oid,
    owner_role_name: manifest.public_schema_owner_name,
    acl_sha256: manifest.public_schema_acl_sha256,
  };
  validateUniqueObjects(objects);
  validateMigrations(migrations);
  if (roles.some(({ state_sha256 }) => !SHA256_PATTERN.test(state_sha256))
      || defaultAcls.some(({ acl_sha256 }) => !SHA256_PATTERN.test(acl_sha256))
      || new Set(defaultAcls.map(defaultAclKey)).size !== defaultAcls.length
      || roles.length !== manifest.role_count
      || objects.length !== manifest.object_count
      || migrations.length !== manifest.migration_count
      || defaultAcls.length !== manifest.default_acl_count
      || restoreOwnershipManifestChecksum(roles, objects, migrations, publicSchema, defaultAcls)
        !== manifest.manifest_sha256) {
    throw new Error("Restore ownership contract count or checksum does not match its retained manifest");
  }

  const currentRoles = await roleStates(client, roles.map(({ role_oid }) => role_oid));
  const currentRoleByOid = new Map(currentRoles.map((role) => [role.role_oid, role]));
  for (const expected of roles) {
    const current = currentRoleByOid.get(expected.role_oid);
    if (!current || current.role_name !== expected.role_name) {
      throw new Error(`Restore ownership role ${expected.role_name} is missing or has a different identity`);
    }
    assertLeastPrivilegeOwnerRole(current);
    if (sha256(normalizedRoleState(current)) !== expected.state_sha256) {
      throw new Error(`Restore ownership role ${expected.role_name} no longer matches its captured state`);
    }
  }
  const protectedRoles = new Map(roles.map((role) => [role.role_oid, role.role_name]));
  for (const acl of defaultAcls) {
    const expectedName = acl.defining_role_oid === admin.role_oid
      ? admin.role_name
      : protectedRoles.get(acl.defining_role_oid);
    if (expectedName !== acl.defining_role_name || !["", "public"].includes(acl.schema_name)) {
      throw new Error(`Restore ownership default ACL has an unexpected defining role: ${defaultAclKey(acl)}`);
    }
  }

  if (expectedMigrations) {
    validateMigrations(expectedMigrations);
    const retained = migrations.map(({ version, checksum }) => ({ version, checksum }))
      .sort((left, right) => left.version.localeCompare(right.version));
    const expected = expectedMigrations.map(({ version, checksum }) => ({ version, checksum }))
      .sort((left, right) => left.version.localeCompare(right.version));
    if (JSON.stringify(retained) !== JSON.stringify(expected)) {
      throw new Error("Pending restore ownership contract belongs to a different migration release");
    }
  }
  return { manifest, roles, objects, migrations, publicSchema, defaultAcls };
}

async function validateCurrentSchemaAndDefaultAcls(
  client: Client,
  contract: RestoreOwnershipContract,
): Promise<void> {
  const currentSchema = await publicSchemaState(client);
  if (JSON.stringify(currentSchema) !== JSON.stringify(contract.publicSchema)) {
    throw new Error("Restored public schema ownership or ACL changed");
  }
  const currentDefaultAcls = await defaultAclStates(client, [
    contract.manifest.preparer_role_oid,
    ...contract.roles.map(({ role_oid }) => role_oid),
  ]);
  const expected = [...contract.defaultAcls].sort((left, right) => defaultAclKey(left).localeCompare(defaultAclKey(right)));
  const current = [...currentDefaultAcls].sort((left, right) => defaultAclKey(left).localeCompare(defaultAclKey(right)));
  if (JSON.stringify(current) !== JSON.stringify(expected)) {
    throw new Error("Restored public/global default ACL state changed");
  }
}

export async function validatePendingRestoreOwnershipForRelease(
  client: Client,
  migrations: readonly RestoreOwnershipMigration[],
): Promise<number> {
  if (!(await restoreOwnershipContractPending(client))) {
    throw new Error("No pending restore ownership contract exists for this restore phase");
  }
  await client.query("BEGIN");
  try {
    await lockContract(client);
    await client.query("SET LOCAL search_path=pg_catalog");
    const admin = await administrator(client);
    const contract = await readAndValidateContract(client, admin, migrations);
    await client.query("COMMIT");
    return contract.objects.length;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function alterOwnerStatement(client: Client, object: ManifestObject): Promise<string> {
  if (object.object_kind === "view" || object.object_kind === "materialized_view") {
    const relationKind = object.object_kind === "view" ? "v" : "m";
    const keyword = object.object_kind === "view" ? "VIEW" : "MATERIALIZED VIEW";
    const result = await client.query<{ statement: string }>(`
      SELECT pg_catalog.format(
        'ALTER ${keyword} %I.%I OWNER TO %I',namespace.nspname,relation.relname,target_owner.rolname
      ) AS statement
      FROM pg_catalog.pg_class AS relation
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid=relation.relnamespace
      CROSS JOIN pg_catalog.pg_roles AS target_owner
      WHERE namespace.nspname=$1
        AND relation.relname=$2
        AND relation.relkind=$3
        AND target_owner.oid=$4::oid
        AND target_owner.rolname=$5
    `, [
      object.schema_name,
      object.object_name,
      relationKind,
      object.owner_role_oid,
      object.owner_role_name,
    ]);
    if (result.rowCount !== 1 || !result.rows[0]) {
      throw new Error(`Could not render restore ownership statement for ${objectKey(object)}`);
    }
    return result.rows[0].statement;
  }

  const routineKinds: Record<RoutineKind, { prokind: string; keyword: string }> = {
    function: { prokind: "f", keyword: "FUNCTION" },
    procedure: { prokind: "p", keyword: "PROCEDURE" },
    aggregate: { prokind: "a", keyword: "AGGREGATE" },
    window_function: { prokind: "w", keyword: "FUNCTION" },
  };
  const { prokind, keyword } = routineKinds[object.object_kind];
  const result = await client.query<{ statement: string }>(`
    SELECT pg_catalog.format(
      'ALTER ${keyword} %I.%I(%s) OWNER TO %I',
      namespace.nspname,routine.proname,
      pg_catalog.pg_get_function_identity_arguments(routine.oid),target_owner.rolname
    ) AS statement
    FROM pg_catalog.pg_proc AS routine
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid=routine.pronamespace
    CROSS JOIN pg_catalog.pg_roles AS target_owner
    WHERE namespace.nspname=$1
      AND routine.proname=$2
      AND pg_catalog.pg_get_function_identity_arguments(routine.oid)=$3
      AND routine.prokind=$4
      AND target_owner.oid=$5::oid
      AND target_owner.rolname=$6
  `, [
    object.schema_name,
    object.object_name,
    object.identity_arguments,
    prokind,
    object.owner_role_oid,
    object.owner_role_name,
  ]);
  if (result.rowCount !== 1 || !result.rows[0]) {
    throw new Error(`Could not render restore ownership statement for ${objectKey(object)}`);
  }
  return result.rows[0].statement;
}

/**
 * Reapply a pending pre-restore manifest after migrations. Nothing is changed
 * until every identity, definition, current owner, and target role validates.
 */
export async function reconcilePendingRestoreOwnership(
  client: Client,
  migrations: readonly RestoreOwnershipMigration[],
): Promise<number> {
  if (!(await restoreOwnershipContractPending(client))) {
    throw new Error("No pending restore ownership contract exists for reconciliation");
  }
  await client.query("BEGIN");
  try {
    await lockContract(client);
    await client.query("SET LOCAL search_path=pg_catalog,public");
    const admin = await administrator(client);
    const contract = await readAndValidateContract(client, admin, migrations);
    const { manifest, objects } = contract;
    await validateCurrentSchemaAndDefaultAcls(client, contract);

    const current = await allPublicRoutinesAndViews(client);
    const currentByKey = new Map(current.map((object) => [objectKey(object), object]));
    const expectedByKey = new Map(objects.map((object) => [objectKey(object), object]));
    for (const object of current.filter(({ owner_role_name }) => owner_role_name.startsWith("context_use_"))) {
      if (!expectedByKey.has(objectKey(object))) {
        throw new Error(`Unexpected Context Use-owned routine or view ${objectKey(object)}`);
      }
    }
    for (const expected of objects) {
      const actual = currentByKey.get(objectKey(expected));
      if (!actual) throw new Error(`Restore ownership target is missing: ${objectKey(expected)}`);
      if (actual.owner_role_oid !== expected.owner_role_oid
          && actual.owner_role_oid !== manifest.preparer_role_oid) {
        throw new Error(`Restore ownership target has an unexpected current owner: ${objectKey(expected)}`);
      }
      if (actual.owner_role_oid === expected.owner_role_oid
          && actual.owner_role_name !== expected.owner_role_name) {
        throw new Error(`Restore ownership target role identity changed: ${objectKey(expected)}`);
      }
      if (actual.owner_role_oid === manifest.preparer_role_oid
          && actual.owner_role_name !== manifest.preparer_role_name) {
        throw new Error(`Restore ownership migration administrator identity changed: ${objectKey(expected)}`);
      }
      const actualDefinitionSha256 = sha256(actual.definition_payload);
      if (actualDefinitionSha256 !== expected.definition_sha256) {
        throw new Error(
          `Restore ownership target definition changed: ${objectKey(expected)} `
          + `(expected ${expected.definition_sha256}, got ${actualDefinitionSha256})`,
        );
      }
      const actualAclSha256 = sha256(actual.acl_payload);
      if (actualAclSha256 !== expected.acl_sha256) {
        throw new Error(
          `Restore ownership target ACL changed: ${objectKey(expected)} `
          + `(expected ${expected.acl_sha256}, got ${actualAclSha256})`,
        );
      }
    }
    const expectedKeys = new Set(expectedByKey.keys());
    await assertNoUnexpectedAdminSecurityDefiners(client, admin, expectedKeys);
    await assertNoUnexpectedAdminViews(client, admin, expectedKeys);

    const alterStatements: string[] = [];
    for (const object of objects) alterStatements.push(await alterOwnerStatement(client, object));
    for (const statement of alterStatements) await client.query(statement);

    const reconciled = await allPublicRoutinesAndViews(client);
    const reconciledByKey = new Map(reconciled.map((object) => [objectKey(object), object]));
    for (const expected of objects) {
      const actual = reconciledByKey.get(objectKey(expected));
      if (!actual || actual.owner_role_oid !== expected.owner_role_oid
          || actual.owner_role_name !== expected.owner_role_name
          || sha256(actual.definition_payload) !== expected.definition_sha256
          || sha256(actual.acl_payload) !== expected.acl_sha256) {
        throw new Error(`Restore ownership verification failed: ${objectKey(expected)}`);
      }
    }
    await validateCurrentSchemaAndDefaultAcls(client, contract);
    await assertNoUnexpectedAdminSecurityDefiners(client, admin, new Set());
    await assertNoUnexpectedAdminViews(client, admin, new Set());

    await client.query(`DROP SCHEMA ${RESTORE_OWNERSHIP_SCHEMA} CASCADE`);
    await client.query("COMMIT");
    return objects.length;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
