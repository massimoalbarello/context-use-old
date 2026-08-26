import { afterAll, describe, expect, test } from "bun:test";
import { Client } from "pg";
import { disposableDatabaseUrl } from "../src/disposable-database.ts";
import { inspectLegacySchema, LEGACY_AUTH_STRUCTURE_FINGERPRINT } from "../src/legacy-schema.ts";

const databaseUrl = await disposableDatabaseUrl();
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("legacy schema inspection", () => {
  const client = new Client({ connectionString: databaseUrl });

  afterAll(async () => client.end());

  test("recognizes the fully migrated v0.1.97 database without reading row data", async () => {
    await client.connect();
    expect(await inspectLegacySchema(client)).toEqual({
      state: "legacy-v0.1.97",
      authStructureFingerprint: LEGACY_AUTH_STRUCTURE_FINGERPRINT,
    });
  });
});
