import { describe, expect, test } from "bun:test";
import { DEVELOPMENT_RESET_TABLES, developmentResetSql } from "./reset-development.ts";

describe("development data reset", () => {
  test("clears knowledge state without touching owner authentication", () => {
    expect(DEVELOPMENT_RESET_TABLES).toContain("knowledge_pages");
    expect(DEVELOPMENT_RESET_TABLES).toContain("assets");
    expect(DEVELOPMENT_RESET_TABLES).toContain("source_records");
    expect(DEVELOPMENT_RESET_TABLES).toContain("source_record_search_chunks");
    expect(DEVELOPMENT_RESET_TABLES).toContain("pathless_knowledge_search_chunks");
    expect(DEVELOPMENT_RESET_TABLES).toContain("hypermedia_documents");
    expect(DEVELOPMENT_RESET_TABLES).toContain("public_resources");

    const sql = developmentResetSql().toLowerCase();
    for (const protectedTable of ["user", "session", "account", "passkey", "oauthclient"]) {
      expect(sql).not.toContain(`truncate table ${protectedTable}`);
      expect(DEVELOPMENT_RESET_TABLES).not.toContain(protectedTable as never);
    }
  });

  test("clears every pathless publication table in the same explicit truncate", () => {
    const pathlessPublicationTables = [
      "public_artifact_id_reservations",
      "public_representation_token_reservations",
      "pathless_publication_intents",
      "publication_intent_id_reservations",
      "pathless_publication_artifact_staging",
      "public_page_artifacts",
      "public_asset_artifacts",
      "page_publications",
      "asset_publications",
      "pathless_publication_settings",
      "public_visibility_generations",
      "publication_target_generations",
      "pathless_publication_adoption_staging",
      "pathless_publication_adoptions",
      "public_namespace_conflicts",
    ] as const;

    for (const table of pathlessPublicationTables) {
      expect(DEVELOPMENT_RESET_TABLES).toContain(table);
    }
    const sql = developmentResetSql();
    const truncateStatements = sql.match(/TRUNCATE TABLE[\s\S]*?;/gi) ?? [];
    expect(truncateStatements).toHaveLength(1);
    for (const table of pathlessPublicationTables) {
      expect(truncateStatements[0]).toContain(table);
    }
    expect(truncateStatements[0]?.toUpperCase()).not.toContain("CASCADE");
  });

  test("recreates the root required by the default template", () => {
    expect(developmentResetSql()).toContain("INSERT INTO knowledge_directories");
    expect(developmentResetSql()).toContain("gen_random_uuid(),''");
    expect(developmentResetSql()).toContain("INSERT INTO knowledge_settings(singleton)");
    expect(developmentResetSql()).toContain("INSERT INTO public_projection_state(singleton)");
    expect(developmentResetSql()).toContain("INSERT INTO pathless_publication_settings(");
    expect(developmentResetSql()).toContain("VALUES (true,NULL,NULL)");
  });
});
