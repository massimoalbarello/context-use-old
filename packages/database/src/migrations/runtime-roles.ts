import type { Client } from "pg";

function isDuplicateRole(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "42710";
}

export async function ensurePrivateRuntimeRole(client: Client): Promise<void> {
  const existing = await client.query(
    "SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='context_use_private'",
  );
  if (existing.rowCount) {
    return;
  }

  try {
    await client.query(`
      CREATE ROLE context_use_private
        LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS
    `);
  } catch (error) {
    if (!isDuplicateRole(error)) {
      throw error;
    }
  }
}
