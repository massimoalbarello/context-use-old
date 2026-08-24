import { afterAll, describe, expect, test } from "bun:test";
import { Pool } from "pg";
import { disposableDatabaseUrl } from "../src/disposable-database.ts";

const databaseUrl = await disposableDatabaseUrl();
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("knowledge lifecycle lock ordering", () => {
  const pool = new Pool({ connectionString: databaseUrl });

  afterAll(async () => {
    await pool.end();
  });

  test("publication confirmation takes the shared transition before intent reads, target locking and publication mutation", async () => {
    const definition = (await pool.query<{ definition: string }>(
      `SELECT pg_get_functiondef(
         'confirm_publication_intent(uuid,text,text,text,integer,integer)'::regprocedure
       ) AS definition`,
    )).rows[0]!.definition;
    const transition = definition.indexOf("pg_advisory_xact_lock_shared");
    const intentRead = definition.indexOf("FROM publication_intent_id_reservations", transition);
    const document = definition.indexOf("lock_publication_context", intentRead);
    const pageMutation = definition.indexOf("DELETE FROM page_publications", document);
    const assetMutation = definition.indexOf("DELETE FROM asset_publications", pageMutation);
    expect(transition).toBeGreaterThan(-1);
    expect(intentRead).toBeGreaterThan(transition);
    expect(document).toBeGreaterThan(intentRead);
    expect(pageMutation).toBeGreaterThan(document);
    expect(assetMutation).toBeGreaterThan(pageMutation);
  });

});
