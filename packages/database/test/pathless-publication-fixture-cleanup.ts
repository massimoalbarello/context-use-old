import type { Client } from "pg";

async function selectIds(
  client: Client,
  query: string,
  values: unknown[],
): Promise<string[]> {
  return (await client.query<{ id: string }>(query, values)).rows.map(({ id }) => id);
}

function unique(values: Iterable<string>): string[] {
  return [...new Set(values)];
}

/**
 * Removes only the durable graph rooted at committed publication test sources.
 * Replica mode is deliberate: production guards make the history immutable,
 * while the disposable integration database must not leak one suite's graph
 * into later corpus/reset suites.
 */
export async function cleanupPathlessPublicationFixtures(
  client: Client,
  sourceDocumentIds: Iterable<string>,
  options: {
    extraIntentIds?: Iterable<string>;
    credentialIds?: Iterable<string>;
    userIds?: Iterable<string>;
  } = {},
): Promise<void> {
  const documentIds = unique(sourceDocumentIds);
  const extraIntentIds = unique(options.extraIntentIds ?? []);
  const credentialIds = unique(options.credentialIds ?? []);
  const userIds = unique(options.userIds ?? []);
  if (
    documentIds.length === 0
    && extraIntentIds.length === 0
    && credentialIds.length === 0
    && userIds.length === 0
  ) return;

  const publicIds = unique(await selectIds(
    client,
    `SELECT public_id AS id FROM public_resources
     WHERE document_id=ANY($1::uuid[]) OR original_document_id=ANY($1::uuid[])
     UNION SELECT candidate_public_id FROM pathless_publication_intents
     WHERE target_document_id=ANY($1::uuid[]) AND candidate_public_id IS NOT NULL
     UNION SELECT public_id FROM pathless_publication_adoptions
     WHERE source_document_id=ANY($1::uuid[])`,
    [documentIds],
  ));
  const revisionIds = unique(await selectIds(
    client,
    `SELECT id FROM hypermedia_document_revisions
     WHERE document_id=ANY($1::uuid[])
     UNION SELECT id FROM knowledge_page_versions WHERE page_id=ANY($1::uuid[])
     UNION SELECT expected_revision_id FROM pathless_publication_intents
     WHERE target_document_id=ANY($1::uuid[]) AND expected_revision_id IS NOT NULL
     UNION SELECT source_revision_id FROM pathless_publication_adoptions
     WHERE source_document_id=ANY($1::uuid[]) AND source_revision_id IS NOT NULL`,
    [documentIds],
  ));
  const intentIds = unique([
    ...extraIntentIds,
    ...await selectIds(
      client,
      `SELECT id FROM pathless_publication_intents
       WHERE target_document_id=ANY($1::uuid[])
       UNION SELECT id FROM publication_intents WHERE target_id=ANY($1::uuid[])
       UNION SELECT id FROM page_deletion_intents WHERE page_id=ANY($1::uuid[])`,
      [documentIds],
    ),
  ]);
  const adoptionIds = unique(await selectIds(
    client,
    `SELECT id FROM pathless_publication_adoptions
     WHERE source_document_id=ANY($1::uuid[])`,
    [documentIds],
  ));
  const runIds = unique(await selectIds(
    client,
    `SELECT migration_run_id AS id FROM directory_hub_migrations
     WHERE document_id=ANY($1::uuid[])
     UNION SELECT run_id FROM corpus_page_migration_plans
     WHERE document_id=ANY($1::uuid[])
        OR source_revision_id=ANY($2::uuid[])
        OR rewrite_revision_id=ANY($2::uuid[])
     UNION SELECT run_id FROM corpus_migration_automation_plans
     WHERE instructions_document_id=ANY($1::uuid[])
        OR state_document_id=ANY($1::uuid[])
     UNION SELECT run_id FROM corpus_migration_completions
     WHERE output_document_id=ANY($1::uuid[])
        OR output_revision_id=ANY($2::uuid[])`,
    [documentIds, revisionIds],
  ));
  const artifactIds = unique(await selectIds(
    client,
    `SELECT artifact_id AS id FROM public_page_artifacts
     WHERE source_document_id=ANY($1::uuid[]) OR public_id=ANY($2::uuid[])
     UNION SELECT artifact_id FROM public_asset_artifacts
     WHERE source_document_id=ANY($1::uuid[]) OR public_id=ANY($2::uuid[])
     UNION SELECT artifact_id FROM published_page_artifacts
     WHERE page_id=ANY($1::uuid[])
     UNION SELECT candidate_artifact_id FROM pathless_publication_intents
     WHERE id=ANY($3::uuid[]) AND candidate_artifact_id IS NOT NULL
     UNION SELECT candidate_artifact_id FROM pathless_publication_adoptions
     WHERE id=ANY($4::uuid[])
     UNION SELECT artifact_id FROM pathless_publication_artifact_staging
     WHERE intent_id=ANY($3::uuid[])
     UNION SELECT artifact_id FROM pathless_publication_adoption_staging
     WHERE adoption_id=ANY($4::uuid[])`,
    [documentIds, publicIds, intentIds, adoptionIds],
  ));
  const conflictIds = unique([
    ...documentIds,
    ...revisionIds,
    ...publicIds,
    ...artifactIds,
  ]);

  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL session_replication_role=replica");
    await client.query(
      `UPDATE pathless_publication_settings
       SET entrypoint_public_id=NULL,updated_at=NULL
       WHERE entrypoint_public_id=ANY($1::uuid[])`,
      [publicIds],
    );
    await client.query(
      `UPDATE public_knowledge_settings
       SET entrypoint_page_id=NULL,updated_at=clock_timestamp()
       WHERE entrypoint_page_id=ANY($1::uuid[])`,
      [documentIds],
    );
    await client.query(
      "DELETE FROM confirmation_challenges WHERE intent_id=ANY($1::uuid[])",
      [intentIds],
    );
    await client.query(
      `DELETE FROM pathless_publication_object_claims
       WHERE (allocation_kind='pathless_intent' AND allocation_id=ANY($1::uuid[]))
          OR (allocation_kind='pathless_adoption' AND allocation_id=ANY($2::uuid[]))`,
      [intentIds, adoptionIds],
    );
    await client.query(
      "DELETE FROM pathless_publication_artifact_staging WHERE intent_id=ANY($1::uuid[])",
      [intentIds],
    );
    await client.query(
      "DELETE FROM pathless_publication_adoption_staging WHERE adoption_id=ANY($1::uuid[])",
      [adoptionIds],
    );
    await client.query("DELETE FROM page_publications WHERE public_id=ANY($1::uuid[])", [publicIds]);
    await client.query("DELETE FROM asset_publications WHERE public_id=ANY($1::uuid[])", [publicIds]);
    await client.query(
      `DELETE FROM public_representation_token_reservations
       WHERE artifact_id=ANY($1::uuid[])`,
      [artifactIds],
    );
    await client.query("DELETE FROM public_page_artifacts WHERE artifact_id=ANY($1::uuid[])", [artifactIds]);
    await client.query("DELETE FROM public_asset_artifacts WHERE artifact_id=ANY($1::uuid[])", [artifactIds]);
    await client.query("DELETE FROM pathless_publication_intents WHERE id=ANY($1::uuid[])", [intentIds]);
    await client.query("DELETE FROM publication_intents WHERE id=ANY($1::uuid[])", [intentIds]);
    await client.query("DELETE FROM knowledge_export_intents WHERE id=ANY($1::uuid[])", [intentIds]);
    await client.query("DELETE FROM page_deletion_intents WHERE id=ANY($1::uuid[])", [intentIds]);
    await client.query(
      "DELETE FROM publication_intent_id_reservations WHERE intent_id=ANY($1::uuid[])",
      [intentIds],
    );
    await client.query("DELETE FROM pathless_publication_adoptions WHERE id=ANY($1::uuid[])", [adoptionIds]);
    await client.query(
      `DELETE FROM public_artifact_id_reservations
       WHERE artifact_id=ANY($1::uuid[])
          OR allocation_id=ANY($2::uuid[])
          OR allocation_id=ANY($3::uuid[])`,
      [artifactIds, intentIds, adoptionIds],
    );
    await client.query("DELETE FROM public_route_aliases WHERE public_id=ANY($1::uuid[])", [publicIds]);
    await client.query(
      `DELETE FROM public_namespace_conflicts
       WHERE namespace_uuid=ANY($1::uuid[]) OR public_id=ANY($2::uuid[])`,
      [conflictIds, publicIds],
    );
    await client.query("DELETE FROM public_visibility_generations WHERE public_id=ANY($1::uuid[])", [publicIds]);
    await client.query("DELETE FROM public_resources WHERE public_id=ANY($1::uuid[])", [publicIds]);

    await client.query(
      `DELETE FROM automation_registry
       WHERE instructions_document_id=ANY($1::uuid[])
          OR state_document_id=ANY($1::uuid[])`,
      [documentIds],
    );
    await client.query(
      `DELETE FROM operational_document_replacements
       WHERE source_document_id=ANY($1::uuid[])
          OR agents_occupant_document_id=ANY($1::uuid[])
          OR replacement_document_id=ANY($1::uuid[])
          OR state_source_document_id=ANY($1::uuid[])
          OR state_replacement_document_id=ANY($1::uuid[])`,
      [documentIds],
    );
    await client.query(
      `DELETE FROM directory_hub_migrations
       WHERE document_id=ANY($1::uuid[]) OR migration_run_id=ANY($2::uuid[])`,
      [documentIds, runIds],
    );
    await client.query("DELETE FROM corpus_migration_completions WHERE run_id=ANY($1::uuid[])", [runIds]);
    await client.query("DELETE FROM corpus_migration_automation_plans WHERE run_id=ANY($1::uuid[])", [runIds]);
    await client.query("DELETE FROM corpus_page_migration_plans WHERE run_id=ANY($1::uuid[])", [runIds]);
    await client.query("DELETE FROM corpus_directory_migration_plans WHERE run_id=ANY($1::uuid[])", [runIds]);
    await client.query("DELETE FROM corpus_migration_inventory WHERE run_id=ANY($1::uuid[])", [runIds]);
    await client.query("DELETE FROM corpus_migration_runs WHERE id=ANY($1::uuid[])", [runIds]);

    await client.query(
      `DELETE FROM document_links
       WHERE source_revision_id=ANY($1::uuid[])
          OR target_document_id=ANY($2::uuid[])`,
      [revisionIds, documentIds],
    );
    await client.query(
      `DELETE FROM knowledge_asset_links
       WHERE source_version_id=ANY($1::uuid[])
          OR target_asset_id=ANY($2::uuid[])`,
      [revisionIds, documentIds],
    );
    await client.query("DELETE FROM pathless_knowledge_search_chunks WHERE document_id=ANY($1::uuid[])", [documentIds]);
    await client.query("DELETE FROM pathless_knowledge_search WHERE document_id=ANY($1::uuid[])", [documentIds]);
    await client.query("DELETE FROM knowledge_revision_contracts WHERE document_id=ANY($1::uuid[])", [documentIds]);
    await client.query("DELETE FROM published_page_artifacts WHERE page_id=ANY($1::uuid[])", [documentIds]);
    await client.query("DELETE FROM knowledge_page_changes WHERE page_id=ANY($1::uuid[])", [documentIds]);
    await client.query("DELETE FROM knowledge_page_versions WHERE page_id=ANY($1::uuid[])", [documentIds]);
    await client.query("DELETE FROM hypermedia_document_revisions WHERE document_id=ANY($1::uuid[])", [documentIds]);
    await client.query("DELETE FROM knowledge_pages WHERE id=ANY($1::uuid[])", [documentIds]);
    await client.query("DELETE FROM assets WHERE id=ANY($1::uuid[])", [documentIds]);
    await client.query("DELETE FROM hypermedia_documents WHERE id=ANY($1::uuid[])", [documentIds]);
    await client.query(
      `DELETE FROM publication_target_generations
       WHERE target_document_id=ANY($1::uuid[])`,
      [documentIds],
    );
    await client.query("DELETE FROM legacy_public_directory_prefixes WHERE directory_id=ANY($1::uuid[])", [documentIds]);
    await client.query("DELETE FROM knowledge_directories WHERE id=ANY($1::uuid[])", [documentIds]);
    if (credentialIds.length > 0) {
      await client.query(
        `DELETE FROM passkey WHERE "credentialID"=ANY($1::text[])`,
        [credentialIds],
      );
    }
    if (userIds.length > 0) {
      await client.query(`DELETE FROM "user" WHERE id=ANY($1::text[])`, [userIds]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
