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

  test("removed filesystem and cutover APIs stay absent from the live catalog", async () => {
    const state = await pool.query<{
      directories: string | null;
      path_column_count: string;
      cutover_state: string | null;
      cutover_finalizer: string | null;
      cutover_verifier: string | null;
      legacy_aliases: string | null;
      roles: string[];
      historical_triggers: string;
    }>(`
      SELECT
        to_regclass('public.knowledge_directories')::text AS directories,
        (
          SELECT count(*)::text FROM information_schema.columns
          WHERE table_schema='public' AND column_name='current_path'
        ) AS path_column_count,
        to_regclass('public.hypermedia_cutover_state')::text AS cutover_state,
        to_regprocedure('public.finalize_hypermedia_cutover()')::text AS cutover_finalizer,
        to_regprocedure('public.list_hypermedia_cutover_blockers()')::text AS cutover_verifier,
        to_regclass('public.public_route_aliases')::text AS legacy_aliases,
        enum_range(NULL::private_document_operational_role)::text[] AS roles,
        (
          SELECT count(*)::text FROM pg_trigger
          WHERE NOT tgisinternal AND tgname ~ '_(zz)?(028|029|037|040)(_|$)'
        ) AS historical_triggers
    `);
    expect(state.rows).toEqual([{
      directories: null,
      path_column_count: "0",
      cutover_state: null,
      cutover_finalizer: null,
      cutover_verifier: null,
      legacy_aliases: "public_route_aliases",
      roles: ["global_guide", "automation_instructions", "automation_state"],
      historical_triggers: "0",
    }]);

    const sourceLinks = (await pool.query<{ definition: string }>(
      `SELECT pg_get_functiondef('replace_document_links(uuid,uuid[])'::regprocedure)
         AS definition`,
    )).rows[0]!.definition;
    expect(sourceLinks).not.toContain("immediately preceding application release");
    expect(sourceLinks).not.toContain("p_target_document_ids := '{}'::uuid[]");
  });

});
