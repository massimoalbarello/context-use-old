export type MigrationDescriptor = {
  version: string;
  checksum: string;
};

export type AppliedMigration = {
  version: string;
  checksum: string | null;
};

export const MIGRATION_ROLE_PASSWORD_ENV = {
  context_use_auth: "DB_AUTH_PASSWORD",
  context_use_dashboard: "DB_DASHBOARD_PASSWORD",
  context_use_corpus: "DB_CORPUS_PASSWORD",
  context_use_mcp: "DB_MCP_PASSWORD",
  context_use_public: "DB_PUBLIC_PASSWORD",
  context_use_confirmation: "DB_CONFIRMATION_PASSWORD",
  context_use_storage: "DB_STORAGE_PASSWORD",
  context_use_backup: "DB_BACKUP_PASSWORD",
} as const;

export function configuredExistingRolePasswords(
  environment: Readonly<Record<string, string | undefined>>,
  existingRoleNames: Iterable<string>,
): Array<{ role: keyof typeof MIGRATION_ROLE_PASSWORD_ENV; password: string }> {
  const existing = new Set(existingRoleNames);
  const roles = Object.keys(MIGRATION_ROLE_PASSWORD_ENV) as Array<
    keyof typeof MIGRATION_ROLE_PASSWORD_ENV
  >;
  return roles.flatMap((role) => {
    const variable = MIGRATION_ROLE_PASSWORD_ENV[role];
    const password = environment[variable];
    return password && existing.has(role) ? [{ role, password }] : [];
  });
}

export function assertMigrationState(
  files: MigrationDescriptor[],
  applied: AppliedMigration[],
  existingRelations: string[],
  baseline = "001_create_auth_schema.sql",
): void {
  const current = new Map(files.map((file) => [file.version, file.checksum]));
  const unknown = applied.filter(({ version }) => !current.has(version)).map(({ version }) => version);
  if (unknown.length) {
    throw new Error(
      `Database contains migrations that are not part of this schema: ${unknown.join(", ")}. `
      + "This release requires a fresh database.",
    );
  }

  const baselineApplied = applied.some(({ version }) => version === baseline);
  if (current.has(baseline) && !baselineApplied && (applied.length || existingRelations.length)) {
    const reason = applied.length
      ? `unrecognized migrations: ${applied.map(({ version }) => version).join(", ")}`
      : `existing relations: ${existingRelations.join(", ")}`;
    throw new Error(`${baseline} can only be applied to a fresh database; found ${reason}`);
  }

  for (const migration of applied) {
    const expected = current.get(migration.version)!;
    if (!migration.checksum) {
      throw new Error(
        `Database migration ${migration.version} has no recorded checksum. `
        + "This release requires a fresh database.",
      );
    }
    if (migration.checksum !== expected) {
      throw new Error(
        `Database migration ${migration.version} does not match this release. `
        + "This release requires a fresh database.",
      );
    }
  }
}
