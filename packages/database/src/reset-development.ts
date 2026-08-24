import { Client } from "pg";

export const DEVELOPMENT_RESET_TABLES = [
  "page_publications",
  "asset_publications",
  "public_page_artifacts",
  "public_asset_artifacts",
  "public_representation_token_reservations",
  "publication_object_claims",
  "publication_artifact_staging",
  "publication_intents",
  "publication_intent_id_reservations",
  "public_artifact_id_reservations",
  "hypermedia_bootstrap_allocations",
  "publication_settings",
  "public_visibility_generations",
  "publication_target_generations",
  "public_namespace_conflicts",
  "knowledge_search_chunks",
  "knowledge_search",
  "knowledge_revision_contracts",
  "automation_registry",
  "confirmation_challenges",
  "knowledge_export_intents",
  "page_deletion_intents",
  "retained_page_artifacts",
  "public_route_aliases",
  "public_resources",
  "knowledge_settings",
  "document_links",
  "source_record_search_chunks",
  "source_records",
  "hypermedia_document_revisions",
  "hypermedia_documents",
  "knowledge_asset_links",
  "knowledge_page_changes",
  "knowledge_page_versions",
  "knowledge_pages",
  "assets",
] as const;

export function developmentResetSql(): string {
  return `
    TRUNCATE TABLE ${DEVELOPMENT_RESET_TABLES.join(", ")} RESTART IDENTITY;
    INSERT INTO publication_settings(
      singleton,entrypoint_public_id,updated_at
    ) VALUES (true,NULL,clock_timestamp());
    INSERT INTO knowledge_settings(singleton) VALUES (true);
  `;
}

async function resetDevelopmentData(): Promise<void> {
  if (process.env.CONTEXT_USE_DEVELOPMENT_RESET !== "preserve-auth") {
    throw new Error("Refusing to reset data without CONTEXT_USE_DEVELOPMENT_RESET=preserve-auth");
  }
  const migrationUrl = process.env.MIGRATOR_DATABASE_URL ?? process.env.DATABASE_ADMIN_URL;
  if (!migrationUrl) throw new Error("MIGRATOR_DATABASE_URL or DATABASE_ADMIN_URL is required");
  const target = new URL(migrationUrl);
  if (process.env.NODE_ENV === "production" || target.hostname !== "postgres" || target.username !== "postgres") {
    throw new Error("Development reset requires the local Compose PostgreSQL administrator");
  }

  const client = new Client({ connectionString: migrationUrl, application_name: "context-use-development-reset" });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query(developmentResetSql());
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }
}

if (import.meta.main) await resetDevelopmentData();
