import { describe, expect, test } from "bun:test";
import {
  knowledgePrepareForceTemplate,
  knowledgePreparationFailure,
  knowledgePrepareTemplateName,
  isolatedCorpusDatabaseUrl,
} from "./corpus-migration-command.ts";
import { CorpusMigrationBlockedError } from "./corpus-migration.ts";
import { PathlessPublicationAdoptionError } from "./pathless-publication-adoption.ts";

describe("knowledge preparation command", () => {
  test("root bootstrap uses the isolated preparation entrypoint", async () => {
    const manifest = await Bun.file(new URL("../../../package.json", import.meta.url)).json() as {
      scripts?: Record<string, string>;
    };
    expect(manifest.scripts?.["db:bootstrap"]).toBe(
      "bun apps/server/src/corpus-migration-command.ts",
    );
    expect(manifest.scripts?.["db:bootstrap"]).not.toContain("template-command.ts");
  });

  test("opens only the isolated corpus database credential", async () => {
    const source = await Bun.file(new URL("./corpus-migration-command.ts", import.meta.url)).text();
    expect(source).toContain("process.env.CORPUS_DATABASE_URL");
    expect(source).not.toContain("process.env.DATABASE_URL");
  });

  test("rejects a missing, malformed, or dashboard-role corpus URL", () => {
    expect(() => isolatedCorpusDatabaseUrl(undefined)).toThrow(
      "CORPUS_DATABASE_URL is required",
    );
    expect(() => isolatedCorpusDatabaseUrl("not a URL")).toThrow(
      "CORPUS_DATABASE_URL must use only context_use_corpus",
    );
    expect(() => isolatedCorpusDatabaseUrl(
      "postgres-evil://context_use_corpus:secret@postgres:5432/context_use",
    )).toThrow("CORPUS_DATABASE_URL must use only context_use_corpus");
    expect(() => isolatedCorpusDatabaseUrl(
      "postgres://context_use_dashboard:secret@postgres:5432/context_use",
    )).toThrow("CORPUS_DATABASE_URL must use only context_use_corpus");
    expect(isolatedCorpusDatabaseUrl(
      "postgres://context_use_corpus:secret@postgres:5432/context_use",
    )).toContain("context_use_corpus");
  });

  test("treats an empty deployment template setting as the shipped default", () => {
    expect(knowledgePrepareTemplateName(undefined, undefined)).toBe("default");
    expect(knowledgePrepareTemplateName(undefined, "")).toBe("default");
    expect(knowledgePrepareTemplateName(undefined, "   ")).toBe("default");
    expect(knowledgePrepareTemplateName(undefined, "evaluation")).toBe("evaluation");
    expect(knowledgePrepareTemplateName("explicit", "evaluation")).toBe("explicit");
  });

  test("accepts only an explicit boolean force setting", () => {
    expect(knowledgePrepareForceTemplate(undefined)).toBe(false);
    expect(knowledgePrepareForceTemplate("")).toBe(false);
    expect(knowledgePrepareForceTemplate(" false ")).toBe(false);
    expect(knowledgePrepareForceTemplate("TRUE")).toBe(true);
    expect(() => knowledgePrepareForceTemplate("yes")).toThrow(
      "CONTEXT_USE_FORCE_TEMPLATE must be true or false",
    );
  });

  test("reports exact audited blockers without serializing operational bodies or object keys", () => {
    expect(knowledgePreparationFailure(new CorpusMigrationBlockedError([{
      code: "operational_contract_conflict",
      item_kind: "page",
      item_id: "11111111-1111-4111-8111-111111111111",
      detail: "Required operational document conflicts with the default contract",
    }]))).toEqual({
      event: "knowledge_corpus_preparation_blocked",
      blockers: [{
        code: "operational_contract_conflict",
        item_kind: "page",
        item_id: "11111111-1111-4111-8111-111111111111",
        detail: "Required operational document conflicts with the default contract",
      }],
    });
  });

  test("reports an exact adoption checkpoint without leaking storage evidence", () => {
    const sourceDocumentId = "11111111-1111-4111-8111-111111111111";
    const adoptionId = "22222222-2222-4222-8222-222222222222";
    const cause = Object.assign(new Error("object key must not escape"), { code: "55000" });
    expect(knowledgePreparationFailure(new PathlessPublicationAdoptionError({
      operation: "materialize",
      adoptionKind: "directory_hub",
      sourceDocumentId,
      adoptionId,
      cause,
    }))).toEqual({
      event: "pathless_publication_adoption_failed",
      operation: "materialize",
      adoption_kind: "directory_hub",
      source_document_id: sourceDocumentId,
      adoption_id: adoptionId,
      database_code: "55000",
    });
  });
});
