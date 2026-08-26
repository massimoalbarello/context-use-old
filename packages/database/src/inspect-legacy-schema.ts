import { Client } from "pg";
import { inspectLegacySchema } from "./legacy-schema.ts";

const databaseUrl = process.env.MIGRATOR_DATABASE_URL ?? process.env.DATABASE_ADMIN_URL;
if (!databaseUrl) {
  throw new Error("MIGRATOR_DATABASE_URL or DATABASE_ADMIN_URL is required");
}

const client = new Client({
  connectionString: databaseUrl,
  application_name: "context-use-legacy-schema-inspector",
});
await client.connect();
try {
  const inspection = await inspectLegacySchema(client);
  console.info(JSON.stringify(inspection, null, 2));
  if (inspection.state === "unsupported") {
    process.exitCode = 2;
  }
} finally {
  await client.end();
}
