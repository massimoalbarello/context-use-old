import { describe, expect, test } from "bun:test";
import {
  assertLeastPrivilegeOwnerRole,
  restoreOwnershipManifestChecksum,
  restoreOwnershipPhase,
  restoreOwnershipPreparationRequested,
  restoreOwnershipReconciliationRequested,
  type RestoreOwnerRoleState,
} from "./restore-ownership.ts";

function ownerRole(overrides: Partial<RestoreOwnerRoleState> = {}): RestoreOwnerRoleState {
  return {
    role_oid: "12345",
    role_name: "context_use_boundary_owner",
    rolsuper: false,
    rolinherit: false,
    rolcreaterole: false,
    rolcreatedb: false,
    rolcanlogin: false,
    rolreplication: false,
    rolbypassrls: false,
    rolconfig: ["search_path=pg_catalog, public"],
    memberships: [],
    ...overrides,
  };
}

describe("restore ownership preparation flag", () => {
  test("is explicit and rejects ambiguous truthy values", () => {
    expect(restoreOwnershipPreparationRequested(undefined)).toBe(false);
    expect(restoreOwnershipPreparationRequested("")).toBe(false);
    expect(restoreOwnershipPreparationRequested("true")).toBe(true);
    for (const value of ["1", "TRUE", "false", "yes"]) {
      expect(() => restoreOwnershipPreparationRequested(value)).toThrow("must be exactly");
    }
  });

  test("requires an exact, mutually-exclusive restore phase", () => {
    expect(restoreOwnershipPhase(undefined, undefined)).toBeNull();
    expect(restoreOwnershipPhase("true", undefined)).toBe("prepare");
    expect(restoreOwnershipPhase(undefined, "true")).toBe("reconcile");
    expect(() => restoreOwnershipPhase("true", "true")).toThrow("mutually exclusive");
    expect(() => restoreOwnershipReconciliationRequested("1")).toThrow("must be exactly");
  });
});

describe("restore owner role boundary", () => {
  test("accepts only isolated Context Use owner roles", () => {
    expect(() => assertLeastPrivilegeOwnerRole(ownerRole())).not.toThrow();
    expect(() => assertLeastPrivilegeOwnerRole(ownerRole({ role_name: "context_use_dashboard" })))
      .toThrow("not an approved owner identity");

    for (const override of [
      { rolsuper: true },
      { rolinherit: true },
      { rolcreaterole: true },
      { rolcreatedb: true },
      { rolcanlogin: true },
      { rolreplication: true },
      { rolbypassrls: true },
      { memberships: ["member-of:postgres:set=true:inherit=true:admin=false"] },
    ] satisfies Array<Partial<RestoreOwnerRoleState>>) {
      expect(() => assertLeastPrivilegeOwnerRole(ownerRole(override))).toThrow("isolated NOLOGIN");
    }
  });

  test("binds exact roles, identities, and definition fingerprints into one checksum", () => {
    const role = { role_oid: "12345", role_name: "context_use_boundary_owner", state_sha256: "a".repeat(64) };
    const object = {
      object_kind: "function" as const,
      schema_name: "public",
      object_name: "checked_boundary",
      identity_arguments: "uuid, text",
      owner_role_oid: role.role_oid,
      owner_role_name: role.role_name,
      definition_sha256: "b".repeat(64),
      acl_sha256: "c".repeat(64),
    };
    const migration = { version: "001.sql", checksum: "d".repeat(64) };
    const publicSchema = {
      owner_role_oid: "6171",
      owner_role_name: "pg_database_owner",
      acl_sha256: "e".repeat(64),
    };
    const defaultAcl = {
      defining_role_oid: "10",
      defining_role_name: "postgres",
      schema_name: "public",
      object_type: "S",
      acl_sha256: "f".repeat(64),
    };
    const checksum = restoreOwnershipManifestChecksum(
      [role],
      [object],
      [migration],
      publicSchema,
      [defaultAcl],
    );
    expect(checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(restoreOwnershipManifestChecksum(
      [role],
      [{ ...object, definition_sha256: "0".repeat(64) }],
      [migration],
      publicSchema,
      [defaultAcl],
    ))
      .not.toBe(checksum);
    expect(restoreOwnershipManifestChecksum(
      [role],
      [{ ...object, acl_sha256: "1".repeat(64) }],
      [migration],
      publicSchema,
      [defaultAcl],
    )).not.toBe(checksum);
    expect(restoreOwnershipManifestChecksum(
      [{ ...role, role_name: "context_use_reset_owner" }],
      [object],
      [migration],
      publicSchema,
      [defaultAcl],
    ))
      .not.toBe(checksum);
    expect(restoreOwnershipManifestChecksum(
      [role],
      [object],
      [{ ...migration, checksum: "2".repeat(64) }],
      publicSchema,
      [defaultAcl],
    ))
      .not.toBe(checksum);
    expect(restoreOwnershipManifestChecksum(
      [role],
      [object],
      [migration],
      { ...publicSchema, acl_sha256: "3".repeat(64) },
      [defaultAcl],
    ))
      .not.toBe(checksum);
    expect(restoreOwnershipManifestChecksum(
      [role],
      [object],
      [migration],
      publicSchema,
      [{ ...defaultAcl, acl_sha256: "4".repeat(64) }],
    ))
      .not.toBe(checksum);
  });
});
