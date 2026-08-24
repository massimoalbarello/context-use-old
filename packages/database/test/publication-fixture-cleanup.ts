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
export async function cleanupPublicationFixtures(
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
     UNION SELECT candidate_public_id FROM publication_intents
     WHERE target_document_id=ANY($1::uuid[]) AND candidate_public_id IS NOT NULL`,
    [documentIds],
  ));
  const revisionIds = unique(await selectIds(
    client,
    `SELECT id FROM hypermedia_document_revisions
     WHERE document_id=ANY($1::uuid[])
     UNION SELECT id FROM knowledge_page_versions WHERE page_id=ANY($1::uuid[])
     UNION SELECT expected_revision_id FROM publication_intents
     WHERE target_document_id=ANY($1::uuid[]) AND expected_revision_id IS NOT NULL`,
    [documentIds],
  ));
  const intentIds = unique([
    ...extraIntentIds,
    ...await selectIds(
      client,
      `SELECT id FROM publication_intents
       WHERE target_document_id=ANY($1::uuid[])
       UNION SELECT id FROM page_deletion_intents WHERE page_id=ANY($1::uuid[])`,
      [documentIds],
    ),
  ]);
  const artifactIds = unique(await selectIds(
    client,
    `SELECT artifact_id AS id FROM public_page_artifacts
     WHERE source_document_id=ANY($1::uuid[]) OR public_id=ANY($2::uuid[])
     UNION SELECT artifact_id FROM public_asset_artifacts
     WHERE source_document_id=ANY($1::uuid[]) OR public_id=ANY($2::uuid[])
     UNION SELECT artifact_id FROM retained_page_artifacts
     WHERE page_id=ANY($1::uuid[])
     UNION SELECT candidate_artifact_id FROM publication_intents
     WHERE id=ANY($3::uuid[]) AND candidate_artifact_id IS NOT NULL
     UNION SELECT artifact_id FROM publication_artifact_staging
     WHERE intent_id=ANY($3::uuid[])`,
    [documentIds, publicIds, intentIds],
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
      `UPDATE publication_settings
       SET entrypoint_public_id=NULL,updated_at=NULL
       WHERE entrypoint_public_id=ANY($1::uuid[])`,
      [publicIds],
    );
    await client.query(
      "DELETE FROM confirmation_challenges WHERE intent_id=ANY($1::uuid[])",
      [intentIds],
    );
    await client.query(
      `DELETE FROM publication_object_claims
       WHERE allocation_id=ANY($1::uuid[])`,
      [intentIds],
    );
    await client.query(
      "DELETE FROM publication_artifact_staging WHERE intent_id=ANY($1::uuid[])",
      [intentIds],
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
    await client.query("DELETE FROM publication_intents WHERE id=ANY($1::uuid[])", [intentIds]);
    await client.query("DELETE FROM knowledge_export_intents WHERE id=ANY($1::uuid[])", [intentIds]);
    await client.query("DELETE FROM page_deletion_intents WHERE id=ANY($1::uuid[])", [intentIds]);
    await client.query(
      "DELETE FROM publication_intent_id_reservations WHERE intent_id=ANY($1::uuid[])",
      [intentIds],
    );
    await client.query(
      `DELETE FROM public_artifact_id_reservations
       WHERE artifact_id=ANY($1::uuid[])
          OR allocation_id=ANY($2::uuid[])`,
      [artifactIds, intentIds],
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
    await client.query("DELETE FROM knowledge_search_chunks WHERE document_id=ANY($1::uuid[])", [documentIds]);
    await client.query("DELETE FROM knowledge_search WHERE document_id=ANY($1::uuid[])", [documentIds]);
    await client.query("DELETE FROM knowledge_revision_contracts WHERE document_id=ANY($1::uuid[])", [documentIds]);
    await client.query("DELETE FROM retained_page_artifacts WHERE page_id=ANY($1::uuid[])", [documentIds]);
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
