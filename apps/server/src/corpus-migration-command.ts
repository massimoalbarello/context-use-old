import { pathToFileURL } from "node:url";
import {
  PathlessPublicationAdoptionRepository,
  createPool,
  formatTemplateResult,
} from "@context-use/database";
import { BrokeredMarkdownObjectStore } from "./markdown-object-store.ts";
import { prepareKnowledgeCorpus } from "./knowledge-prepare.ts";
import { CorpusMigrationBlockedError } from "./corpus-migration.ts";
import { CorpusMigrationObjectError } from "./corpus-migration-execution.ts";
import { BrokeredStorage } from "./storage-client.ts";
import {
  PathlessPublicationAdoptionError,
  adoptRetainedPublications,
} from "./pathless-publication-adoption.ts";

export async function runKnowledgePrepareCommand(options: {
  templateName?: string;
  forceTemplate?: boolean;
} = {}): Promise<void> {
  const production = process.env.NODE_ENV === "production";
  const templateName = knowledgePrepareTemplateName(
    options.templateName,
    process.env.CONTEXT_USE_TEMPLATE_INSTALL,
  );
  const forceTemplate = options.forceTemplate
    ?? knowledgePrepareForceTemplate(process.env.CONTEXT_USE_FORCE_TEMPLATE);
  if (production && templateName !== "default") {
    throw new Error("Production knowledge preparation only supports the default template");
  }
  const corpusDatabaseUrl = isolatedCorpusDatabaseUrl(process.env.CORPUS_DATABASE_URL);
  const socketPath = process.env.STORAGE_SOCKET_PATH
    ?? (production ? undefined : "/tmp/context-use-storage.sock");
  const token = process.env.STORAGE_DASHBOARD_TOKEN
    ?? (production ? undefined : "development-storage-dashboard-token");
  if (!socketPath || !token) {
    throw new Error("Knowledge preparation requires the dashboard storage capability");
  }
  const configuredRoot = process.env.CONTEXT_USE_DEVELOPMENT_TEMPLATE_ROOT;
  const templatesRoot = configuredRoot
    ? pathToFileURL(configuredRoot.endsWith("/") ? configuredRoot : `${configuredRoot}/`)
    : undefined;
  const corpusPool = createPool(corpusDatabaseUrl, {
    application_name: "context-use-knowledge-prepare-corpus",
  });
  const storage = new BrokeredStorage({ socketPath, token });
  try {
    const result = await prepareKnowledgeCorpus({
      corpusPool,
      bodies: new BrokeredMarkdownObjectStore(storage),
      assets: storage,
      templateName,
      forceTemplate,
      ...(templatesRoot ? { templatesRoot } : {}),
    });
    console.log(formatTemplateResult(result.template, !("NO_COLOR" in process.env)));
    console.log(JSON.stringify({
      event: "knowledge_corpus_prepared",
      phase: result.corpus.status.phase,
      counts: result.corpus.status.counts,
      unrecognized_automation_document_ids:
        result.corpus.unrecognized_automation_document_ids,
    }));
    const adoption = await adoptRetainedPublications({
      adoptions: new PathlessPublicationAdoptionRepository(corpusPool),
      storage,
    });
    console.log(JSON.stringify({
      event: "pathless_publications_adopted",
      ...adoption,
    }));
  } finally {
    await corpusPool.end();
  }
}

export function knowledgePrepareTemplateName(
  explicit: string | undefined,
  configured: string | undefined,
): string {
  return explicit ?? (configured?.trim() || "default");
}

export function knowledgePrepareForceTemplate(configured: string | undefined): boolean {
  const value = configured?.trim().toLowerCase();
  if (!value || value === "false") return false;
  if (value === "true") return true;
  throw new Error("CONTEXT_USE_FORCE_TEMPLATE must be true or false");
}

export function isolatedCorpusDatabaseUrl(configured: string | undefined): string {
  if (!configured) {
    throw new Error("CORPUS_DATABASE_URL is required to prepare the knowledge corpus");
  }
  try {
    const parsed = new URL(configured);
    if (!["postgres:", "postgresql:"].includes(parsed.protocol)
        || decodeURIComponent(parsed.username) !== "context_use_corpus") {
      throw new Error("invalid corpus role");
    }
  } catch {
    throw new Error("CORPUS_DATABASE_URL must use only context_use_corpus");
  }
  return configured;
}

export function knowledgePreparationFailure(error: unknown): Record<string, unknown> {
  if (error instanceof PathlessPublicationAdoptionError) {
    return {
      event: "pathless_publication_adoption_failed",
      operation: error.operation,
      ...(error.adoptionKind ? { adoption_kind: error.adoptionKind } : {}),
      ...(error.sourceDocumentId ? { source_document_id: error.sourceDocumentId } : {}),
      ...(error.adoptionId ? { adoption_id: error.adoptionId } : {}),
      ...(error.databaseCode ? { database_code: error.databaseCode } : {}),
    };
  }
  if (error instanceof CorpusMigrationBlockedError) {
    return {
      event: "knowledge_corpus_preparation_blocked",
      blockers: error.blockers.map((blocker) => ({
        code: blocker.code,
        ...(blocker.item_kind ? { item_kind: blocker.item_kind } : {}),
        ...(blocker.item_id ? { item_id: blocker.item_id } : {}),
        detail: blocker.detail,
      })),
    };
  }
  if (error instanceof CorpusMigrationObjectError) {
    return {
      event: "knowledge_corpus_object_failure",
      document_kind: error.documentKind,
      document_id: error.documentId,
      operation: error.operation,
    };
  }
  return {
    event: "knowledge_corpus_preparation_failed",
    error_name: error instanceof Error ? error.name : typeof error,
  };
}

if (import.meta.main) {
  try {
    await runKnowledgePrepareCommand();
  } catch (error) {
    console.error(JSON.stringify(knowledgePreparationFailure(error)));
    process.exitCode = 1;
  }
}
