import { Client } from "pg";
import {
  adoptLegacySchema,
  LEGACY_ADOPTION_CONFIRMATION,
  LEGACY_ADOPTION_ENV,
} from "./adopt-legacy-schema.ts";

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
await client.connect();
try {
  console.info(JSON.stringify(await adoptLegacySchema({ client }), null, 2));
} finally {
  await client.end();
}
