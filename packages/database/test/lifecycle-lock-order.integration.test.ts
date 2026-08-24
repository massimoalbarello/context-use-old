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

  test("legacy knowledge reset functions and export columns are retired", async () => {
    const functions = await pool.query<{ name: string | null }>(
      `SELECT to_regprocedure(name)::text AS name
       FROM unnest(ARRAY[
         'clear_knowledge(uuid,text,text,uuid,text,integer,text,text,text,text,text,tsvector,text,text)',
         'clear_knowledge_legacy_implementation(uuid,text,text,uuid,text,integer,text,text,text,text,text,tsvector,text,text)',
         'complete_knowledge_export_download(uuid,text,text)'
       ]) AS name`,
    );
    expect(functions.rows).toEqual([{ name: null }, { name: null }, { name: null }]);
    const columns = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema='public' AND table_name='knowledge_export_intents'
         AND column_name IN ('reset_requested','download_completed_at','reset_completed_at')`,
    );
    expect(columns.rows).toEqual([]);
  });

  test("corpus migration and publication adoption control planes are retired", async () => {
    const retired = await pool.query<{ relation: string | null; routine: string | null }>(
      `SELECT to_regclass('public.corpus_migration_runs')::text AS relation,
         to_regprocedure('public.lock_corpus_migration_audit_tables()')::text
           AS routine`,
    );
    expect(retired.rows[0]).toEqual({ relation: null, routine: null });
  });
});
