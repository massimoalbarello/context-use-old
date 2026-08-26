import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import {
  adoptLegacySchema,
  LEGACY_ADOPTION_CONFIRMATION,
  LEGACY_ADOPTION_ENV,
} from "./adopt-legacy-schema.ts";
import { loadMigrationStreams } from "./migrations/catalog.ts";

const ADOPT_PENDING_RESTORE_ENV = "CONTEXT_USE_ADOPT_PENDING_RESTORE";

if (process.env[LEGACY_ADOPTION_ENV] !== LEGACY_ADOPTION_CONFIRMATION) {
  throw new Error(
    `Refusing legacy schema adoption without ${LEGACY_ADOPTION_ENV}=${LEGACY_ADOPTION_CONFIRMATION}`,
  );
}
const databaseUrl = process.env.MIGRATOR_DATABASE_URL ?? process.env.DATABASE_ADMIN_URL;
if (!databaseUrl) {
  throw new Error("MIGRATOR_DATABASE_URL or DATABASE_ADMIN_URL is required");
}

const client = new Client({
  connectionString: databaseUrl,
  application_name: "context-use-legacy-schema-adopter",
});
const migrationsDirectory = join(dirname(fileURLToPath(import.meta.url)), "../migrations");
const targetMigrationStreams = await loadMigrationStreams({ directory: migrationsDirectory });
const applicationMigration = targetMigrationStreams.application.find(
  ({ version }) => version === "001_application_schema.sql",
);
if (!applicationMigration) {
  throw new Error("Target migration catalog has no application schema");
}
await client.connect();
try {
  console.info(
    JSON.stringify(
      await adoptLegacySchema({
        client,
        targetMigrationStreams,
        applicationMigrationSql: applicationMigration.sql,
        allowPendingRestore: process.env[ADOPT_PENDING_RESTORE_ENV] === "true",
      }),
      null,
      2,
    ),
  );
} finally {
  await client.end();
}
