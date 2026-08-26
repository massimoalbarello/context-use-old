import type { Client } from "pg";
import {
  configuredExistingRolePasswords,
  MIGRATION_ROLE_PASSWORD_ENV,
} from "../migration-state.ts";

export async function configureMigrationRolePasswords({
  client,
  environment,
}: {
  client: Client;
  environment: NodeJS.ProcessEnv;
}): Promise<void> {
  const existingPasswordRoles = await client.query<{ rolname: string }>(
    "SELECT rolname::text FROM pg_roles WHERE rolname::text=ANY($1::text[])",
    [Object.keys(MIGRATION_ROLE_PASSWORD_ENV)],
  );
  for (const { role, password } of configuredExistingRolePasswords(
    environment,
    existingPasswordRoles.rows.map(({ rolname }) => rolname),
  )) {
    const literal = password.replaceAll("'", "''");
    await client.query(`ALTER ROLE ${role} LOGIN PASSWORD '${literal}'`);
  }
}
