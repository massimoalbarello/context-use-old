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

  test("publication confirmation takes the shared transition before intent reads and either target mutation", async () => {
    const definition = (await pool.query<{ definition: string }>(
      `SELECT pg_get_functiondef(
         'confirm_publication_intent(uuid,text,text,text,integer,integer)'::regprocedure
       ) AS definition`,
    )).rows[0]!.definition;
    const transition = definition.indexOf("pg_advisory_xact_lock_shared");
    const intentRead = definition.indexOf("FROM publication_intents", transition);
    const document = definition.indexOf("lock_operational_document", intentRead);
    const pageMutation = definition.indexOf("UPDATE knowledge_pages", document);
    const assetMutation = definition.indexOf("UPDATE assets", pageMutation);
    expect(transition).toBeGreaterThan(-1);
    expect(intentRead).toBeGreaterThan(transition);
    expect(document).toBeGreaterThan(intentRead);
    expect(pageMutation).toBeGreaterThan(document);
    expect(assetMutation).toBeGreaterThan(pageMutation);
  });

  test("legacy reset preflights authority before taking the exclusive transition and checking v2 state", async () => {
    const definition = (await pool.query<{ definition: string }>(
      `SELECT pg_get_functiondef(
         'clear_knowledge(uuid,text,text,uuid,text,integer,text,text,text,text,text,tsvector,text,text)'::regprocedure
       ) AS definition`,
    )).rows[0]!.definition;
    const intentRead = definition.indexOf("FROM knowledge_export_intents");
    const transition = definition.indexOf("pg_advisory_xact_lock(", intentRead);
    const v2Gate = definition.indexOf("FROM public_artifact_id_reservations", transition);
    const delegate = definition.indexOf("clear_knowledge_legacy_implementation", v2Gate);
    expect(intentRead).toBeGreaterThan(-1);
    expect(transition).toBeGreaterThan(intentRead);
    expect(v2Gate).toBeGreaterThan(transition);
    expect(delegate).toBeGreaterThan(v2Gate);
  });

  test("corpus inventory locks retain the legacy relation order through the narrow routing helper", async () => {
    for (const functionName of [
      "lock_corpus_migration_audit_tables()",
      "lock_corpus_migration_hub_apply_tables()",
    ]) {
      const definition = (await pool.query<{ definition: string }>(
        "SELECT pg_get_functiondef($1::regprocedure) AS definition",
        [functionName],
      )).rows[0]!.definition;
      const privatePrefix = definition.indexOf("LOCK TABLE knowledge_directories");
      const routing = definition.indexOf("lock_public_routing_", privatePrefix);
      const publicSuffix = definition.indexOf("LOCK TABLE public_projection_state", routing);
      expect(privatePrefix).toBeGreaterThan(-1);
      expect(routing).toBeGreaterThan(privatePrefix);
      expect(publicSuffix).toBeGreaterThan(routing);
    }
  });
});
