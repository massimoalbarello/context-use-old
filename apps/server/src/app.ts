import { resolve } from "node:path";
import {
  AutomationRegistryRepository,
  DocumentAssetRepository,
  KnowledgeDocumentRepository,
  KnowledgeExportRepository,
  PrivateDocumentCatalogRepository,
  type KnowledgeExportAsset,
  type KnowledgeExportSnapshot,
  PageDeletionRepository,
  PublicationRepository,
  PublicEntrypointRepository,
  SourceRecordRepository,
  createPool,
  extractDocumentLinks,
  mapConcurrently,
} from "@context-use/database";
import {
  archiveKnowledgeDocumentSchema,
  createKnowledgeDocumentSchema,
  publicationEntrypointSchema,
  publicationIntentSchema,
  updateKnowledgeDocumentSchema,
} from "@context-use/shared";
import { Elysia } from "elysia";
import { z } from "zod";
import { authorizeDashboardRequest } from "./auth-client.ts";
import { forwardDashboardAuthRoute } from "./auth-dashboard-gateway.ts";
import { assetContentResponse } from "./asset-content.ts";
import { config, production } from "./config.ts";
import {
  claimConfirmedExport,
  issueConfirmationOptions,
} from "./confirmation-client.ts";
import { dashboardServices } from "./dashboard-services.ts";
import {
  dashboardDocumentCatalogPage,
  dashboardDocumentNeighborhood,
  dashboardDocumentSummary,
  parseDashboardDocumentCatalogQuery,
  parseDashboardDocumentNeighborhoodQuery,
} from "./dashboard-document-discovery.ts";
import { dashboardSourceRecord } from "./dashboard-source-records.ts";
import {
  dashboardKnowledgeDocument,
  dashboardKnowledgeRevision,
  dashboardKnowledgeRevisionDelta,
  dashboardRepublicationReview,
} from "./dashboard-knowledge-documents.ts";
import { bodyJson, json, problem, routeError } from "./http.ts";
import { publicationWarnings, renderMarkdown } from "./markdown.ts";
import {
  SecurityError,
  requestMatchesOrigin,
  securityHeaders,
} from "./security.ts";
import { AssetIntegrityError, type GeneratedObjectMetadata } from "./storage.ts";
import { BrokeredStorage } from "./storage-client.ts";
import { BrokeredMarkdownObjectStore } from "./markdown-object-store.ts";
import { streamKnowledgeExport } from "./knowledge-export.ts";
import { MAX_KNOWLEDGE_ARCHIVE_BYTES } from "./knowledge-zip.ts";
import { disableStreamingRequestIdleTimeout } from "./streaming-timeout.ts";

const dashboardPool = createPool(config.DATABASE_URL);
const storage = new BrokeredStorage({
  socketPath: config.STORAGE_SOCKET_PATH,
  token: config.STORAGE_DASHBOARD_TOKEN,
});
const markdownObjects = new BrokeredMarkdownObjectStore(storage);

const dashboardKnowledgeDocuments = new KnowledgeDocumentRepository(dashboardPool, markdownObjects);
const pageDeletions = new PageDeletionRepository(dashboardPool);
const dashboardAssets = new DocumentAssetRepository(dashboardPool);
const publications = new PublicationRepository(dashboardPool);
const publicEntrypoint = new PublicEntrypointRepository(dashboardPool);
const knowledgeExports = new KnowledgeExportRepository(dashboardPool, markdownObjects);
const dashboardDocumentCatalog = new PrivateDocumentCatalogRepository(dashboardPool);
const dashboardAutomations = new AutomationRegistryRepository(dashboardPool);
const dashboardSourceRecords = new SourceRecordRepository(dashboardPool, markdownObjects);

async function dashboardAssetPublication(asset: {
  document_id: string;
  filename: string;
  content_type: string;
  size_bytes: string | number;
  content_hash: string;
  created_at: Date | string;
}) {
  const status = await publications.status("asset", asset.document_id);
  return {
    id: asset.document_id,
    filename: asset.filename,
    content_type: asset.content_type,
    size_bytes: Number(asset.size_bytes),
    content_hash: asset.content_hash,
    created_at: asset.created_at,
    public_id: status.public_id,
    published: status.active,
  };
}

class KnowledgeExportBuildError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number,
    readonly code: string,
  ) {
    super(message);
  }
}

type KnowledgeExportFailure = { message: string; httpStatus: number; code: string };
type KnowledgeExportPreparation =
  | { status: "processing" }
  | ({ status: "failed" } & KnowledgeExportFailure);

const exportPreparations = new Map<string, KnowledgeExportPreparation>();

function stagedExportKey(intentId: string): string {
  return `exports/${intentId}.zip`;
}

async function ownerRequest(request: Request, mutation: boolean | "upload" = false) {
  if (!requestMatchesOrigin(request, config.APP_ORIGIN)) throw new SecurityError("Not found", 404);
  const principal = await authorizeDashboardRequest(request, mutation === "upload" ? "upload" : mutation ? "json" : "read");
  if (!principal) throw new SecurityError("Dashboard session required", 401);
  return principal;
}

function privateDocumentResolvers() {
  return {
    document: async (id: string) => {
      const document = await dashboardDocumentCatalog.get(id);
      if (!document || document.lifecycle !== "active") return { available: false as const };
      if (document.document_kind === "asset") {
        return {
          available: true as const,
          representation: "asset" as const,
          href: `/api/dashboard/assets/${id}/content`,
          contentType: document.content_type ?? "application/octet-stream",
        };
      }
      return {
        available: true as const,
        representation: document.document_kind === "record" ? "record" as const : "page" as const,
        href: `/app/documents/${id}`,
      };
    },
  };
}

async function dashboardKnowledgeDocumentResponse(documentId: string) {
  const [document, publicationStatus] = await Promise.all([
    dashboardKnowledgeDocuments.get(documentId),
    publications.status("page", documentId),
  ]);
  if (!document) return null;
  const renderedHtml = await renderMarkdown(
    document.body_markdown,
    privateDocumentResolvers(),
  );
  return dashboardKnowledgeDocument(document, renderedHtml, {
    published_revision_id: publicationStatus.active
      ? publicationStatus.published_revision_id
      : null,
    published_revision_number: publicationStatus.active
      ? publicationStatus.published_revision_number
      : null,
    public_url: publicationStatus.active && publicationStatus.public_id
      ? `${config.APP_ORIGIN}/p/${publicationStatus.public_id}`
      : null,
  });
}

type PreviewTarget = {
  kind: "page" | "asset" | "record" | "document";
  id: string;
  label: string;
  public: boolean;
  href: string | null;
  contentType: string | null;
};

function publicationPreviewTargets(
  publishingPage: { id: string; title: string },
) {
  const cache = new Map<string, Promise<PreviewTarget>>();
  const resolveTarget = (id: string): Promise<PreviewTarget> => {
    const cached = cache.get(id);
    if (cached) return cached;
    const pending = (async (): Promise<PreviewTarget> => {
      if (id === publishingPage.id) {
        return {
          kind: "page",
          id,
          label: publishingPage.title,
          public: true,
          // The permanent public UUID is allocated when the owner starts the
          // publication intent, after this read-only preview.
          href: "#",
          contentType: null,
        };
      }
      const document = await dashboardDocumentCatalog.get(id);
      if (!document || document.lifecycle !== "active") {
        return {
          kind: "document",
          id,
          label: "Missing document",
          public: false,
          href: null,
          contentType: null,
        };
      }
      if (document.document_kind === "asset") {
        const status = await publications.status("asset", id);
        return {
          kind: "asset",
          id,
          label: document.filename ?? "Asset",
          public: status.active,
          href: status.active && status.public_id
            ? `${config.ASSET_ORIGIN}/a/${status.public_id}`
            : null,
          contentType: document.content_type,
        };
      }
      if (document.document_kind === "knowledge") {
        const status = await publications.status("page", id);
        return {
          kind: "page",
          id,
          label: document.title ?? "Knowledge document",
          public: status.active,
          href: status.active && status.public_id
            ? `/p/${status.public_id}`
            : null,
          contentType: null,
        };
      }
      return {
        kind: "record",
        id,
        label: document.title ?? "Source record",
        public: false,
        href: null,
        contentType: null,
      };
    })();
    cache.set(id, pending);
    return pending;
  };
  return {
    resolveTarget,
    markdownResolvers: {
      document: async (id: string) => {
        const target = await resolveTarget(id);
        return target.public && target.href
          ? target.kind === "asset"
            ? {
                available: true as const,
                representation: "asset" as const,
                href: target.href,
                contentType: target.contentType ?? "application/octet-stream",
              }
            : { available: true as const, representation: "page" as const, href: target.href }
          : { available: false as const };
      },
    },
  };
}

async function unavailableExportAssets(assets: Array<Pick<KnowledgeExportAsset, "document_id" | "filename" | "s3_object_key" | "size_bytes" | "content_hash">>): Promise<string[]> {
  const missing: string[] = [];
  const concurrency = 8;
  for (let index = 0; index < assets.length; index += concurrency) {
    const batch = assets.slice(index, index + concurrency);
    const verified = await Promise.all(batch.map((asset) => storage.verify(
      asset.s3_object_key,
      Number(asset.size_bytes),
      asset.content_hash,
    )));
    verified.forEach((available, offset) => {
      if (!available) {
        const asset = batch[offset]!;
        missing.push(`${asset.filename} (${asset.document_id})`);
      }
    });
  }
  return missing;
}

function exportSize(snapshot: KnowledgeExportSnapshot): number {
  return snapshot.pages.reduce((total, page) => (
    total
    + Buffer.byteLength(page.title)
    + Buffer.byteLength(page.summary)
    + Buffer.byteLength(page.body_markdown)
  ), 0)
    + snapshot.assets.reduce((total, asset) => total + Number(asset.size_bytes), 0);
}

function exportStatusUrl(intentId: string): string {
  return `/api/dashboard/knowledge-exports/${encodeURIComponent(intentId)}/status`;
}

function exportDownloadUrl(intentId: string): string {
  return `/api/dashboard/knowledge-exports/${encodeURIComponent(intentId)}/download`;
}

function exportFilename(): string {
  const date = new Date().toISOString().slice(0, 10);
  return `context-use-export-${date}.zip`;
}

type KnowledgeExportSource = {
  sizeBytes: number;
  assets: Array<Pick<KnowledgeExportAsset, "document_id" | "filename" | "s3_object_key" | "size_bytes" | "content_hash">>;
  stream: ReadableStream<Uint8Array>;
};

async function knowledgeExportSource(): Promise<KnowledgeExportSource> {
  const snapshot = await knowledgeExports.currentSnapshot();
  return {
    sizeBytes: exportSize(snapshot),
    assets: snapshot.assets,
    stream: streamKnowledgeExport(snapshot, storage),
  };
}

async function buildKnowledgeExport(intentId: string): Promise<GeneratedObjectMetadata> {
  const source = await knowledgeExportSource();
  if (source.sizeBytes > MAX_KNOWLEDGE_ARCHIVE_BYTES) {
    throw new KnowledgeExportBuildError(
      "Knowledge changed after confirmation and the current export is now larger than 5 GiB. Remove some active assets and try again.",
      413,
      "export_too_large",
    );
  }
  const missing = await unavailableExportAssets(source.assets);
  if (missing.length) {
    const examples = missing.slice(0, 3).join(", ");
    const remaining = missing.length > 3 ? ` and ${missing.length - 3} more` : "";
    throw new KnowledgeExportBuildError(
      `Export stopped because current knowledge includes ${missing.length} asset file${missing.length === 1 ? " that is" : "s that are"} missing or failed integrity verification: ${examples}${remaining}`,
      409,
      "asset_incomplete",
    );
  }
  return storage.writeGenerated(stagedExportKey(intentId), source.stream);
}

function startKnowledgeExportPreparation(
  intentId: string,
): void {
  if (exportPreparations.has(intentId)) return;
  exportPreparations.set(intentId, { status: "processing" });
  void buildKnowledgeExport(intentId).then(() => {
    exportPreparations.delete(intentId);
  }).catch((error: unknown) => {
    const failure: KnowledgeExportFailure = error instanceof KnowledgeExportBuildError
      ? { message: error.message, httpStatus: error.httpStatus, code: error.code }
      : {
          message: "The knowledge archive could not be prepared. Start a new export and try again.",
          httpStatus: 500,
          code: "export_preparation_failed",
        };
    exportPreparations.set(intentId, { status: "failed", ...failure });
    if (!(error instanceof KnowledgeExportBuildError)) {
      console.error("knowledge_export_preparation_failed", error instanceof Error
        ? { intentId, name: error.name, message: error.message }
        : { intentId, type: typeof error });
    }
  });
}

type PreparedKnowledgeExport =
  | { status: "processing" }
  | ({ status: "failed" } & KnowledgeExportFailure)
  | { status: "ready"; staged: GeneratedObjectMetadata };

async function ensureKnowledgeExport(
  intentId: string,
  onStart: () => Promise<void>,
): Promise<PreparedKnowledgeExport> {
  const staged = await storage.inspectGenerated(stagedExportKey(intentId));
  if (staged) return { status: "ready", staged };
  const preparation = exportPreparations.get(intentId);
  if (preparation) return preparation;
  await onStart();
  startKnowledgeExportPreparation(intentId);
  return { status: "processing" };
}

function processingExportResponse(intentId: string): Response {
  return json({
    status: "processing",
    status_url: exportStatusUrl(intentId),
  }, 202);
}

function readyExportBody(
  intentId: string,
  staged: GeneratedObjectMetadata,
) {
  return {
    status: "ready",
    download_url: exportDownloadUrl(intentId),
    filename: exportFilename(),
    size_bytes: staged.sizeBytes,
  };
}

const emptyObjectSchema = z.object({}).strict();

const webRoot = resolve(config.WEB_DIST);
function webFile(path: string): Bun.BunFile | null {
  const resolved = resolve(webRoot, path);
  if (!resolved.startsWith(`${webRoot}/`)) return null;
  return Bun.file(resolved);
}

export const app = new Elysia({ serve: { maxRequestBodySize: 5_500_000_000 } })
  .onError(({ error, code }) => code === "NOT_FOUND"
    ? new Response("Not found", { status: 404, headers: securityHeaders })
    : routeError(error))
  .get("/api/health", () => json({ status: "ok", version: "0.1.84", service: "dashboard" }))
  .get("/api/dashboard/session", ({ request }) => forwardDashboardAuthRoute(request))
  .get("/api/dashboard/csrf", ({ request }) => forwardDashboardAuthRoute(request))
  .post("/api/dashboard/passkey-enrollment-intents", ({ request }) => forwardDashboardAuthRoute(request), { parse: "none" })
  .post("/api/dashboard/passkey-enrollment-intents/:id/confirm", ({ request }) => forwardDashboardAuthRoute(request), { parse: "none" })
  .post("/api/dashboard/passkeys/:id/removal-intents", ({ request }) => forwardDashboardAuthRoute(request), { parse: "none" })
  .post("/api/dashboard/passkeys/:id/remove", ({ request }) => forwardDashboardAuthRoute(request), { parse: "none" })
  .post("/api/dashboard/publications/confirm", ({ request }) => forwardDashboardAuthRoute(request), { parse: "none" })
  .post("/api/dashboard/knowledge-exports/confirm", ({ request }) => forwardDashboardAuthRoute(request), { parse: "none" })
  .post("/api/dashboard/page-deletions/confirm", ({ request }) => forwardDashboardAuthRoute(request), { parse: "none" })
  .get("/api/dashboard/private-mcp-clients", ({ request }) => forwardDashboardAuthRoute(request))
  .get("/api/dashboard/oauth-client-preview", ({ request }) => forwardDashboardAuthRoute(request))
  .delete("/api/dashboard/oauth-clients/:clientId", ({ request }) => forwardDashboardAuthRoute(request))

  .get("/api/dashboard/mcp-endpoint", async ({ request }) => {
    await ownerRequest(request);
    return json({
      knowledge_url: config.MCP_RESOURCE,
    });
  })
  .get("/api/dashboard/services", async ({ request }) => {
    await ownerRequest(request);
    return json({ services: dashboardServices(config) });
  })
  .get("/app", async () => {
    const file = webFile("index.html");
    return file && await file.exists() ? new Response(file, { headers: { ...securityHeaders, "content-type": "text/html; charset=utf-8" } }) : problem("Dashboard build not found", 503);
  })
  .get("/app/*", async () => {
    const file = webFile("index.html");
    return file && await file.exists() ? new Response(file, { headers: { ...securityHeaders, "content-type": "text/html; charset=utf-8" } }) : problem("Dashboard build not found", 503);
  })
  .get("/assets/*", async ({ params }) => {
    const path = (params as Record<string, string>)["*"] ?? "";
    const file = webFile(`assets/${path}`);
    if (!file || !(await file.exists())) return new Response("Not found", { status: 404, headers: securityHeaders });
    return new Response(file, { headers: { ...securityHeaders, "cache-control": "public, max-age=31536000, immutable" } });
  })

  .post("/api/dashboard/knowledge-export-intents", async ({ request }) => {
    const principal = await ownerRequest(request, true);
    emptyObjectSchema.parse(await bodyJson(request));
    const exportPrincipal = { ownerUserId: principal.userId, sessionId: principal.sessionId };
    const intent = await knowledgeExports.createIntent(exportPrincipal);
    await Promise.allSettled(intent.discarded_export_ids.map((id) => {
      exportPreparations.delete(id);
      return storage.deleteGenerated(stagedExportKey(id));
    }));
    if (intent.total_bytes > MAX_KNOWLEDGE_ARCHIVE_BYTES) {
      await knowledgeExports.discard(intent.id, exportPrincipal);
      return problem(
        "Knowledge exports are limited to 5 GiB. Remove some active assets and try again.",
        413,
        "export_too_large",
      );
    }
    let missing: string[];
    try {
      missing = await unavailableExportAssets(await knowledgeExports.assets());
    } catch (error) {
      await knowledgeExports.discard(intent.id, exportPrincipal);
      throw error;
    }
    if (missing.length) {
      await knowledgeExports.discard(intent.id, exportPrincipal);
      const examples = missing.slice(0, 3).join(", ");
      const remaining = missing.length > 3 ? ` and ${missing.length - 3} more` : "";
      return problem(
        `Export stopped because ${missing.length} asset file${missing.length === 1 ? " is" : "s are"} missing or failed integrity verification: ${examples}${remaining}`,
        409,
        "asset_incomplete",
      );
    }
    let authenticationOptions: unknown;
    try {
      authenticationOptions = await issueConfirmationOptions("knowledge_export", intent.id);
    } catch (error) {
      await knowledgeExports.discard(intent.id, exportPrincipal);
      throw error;
    }
    return json({
      intent: { id: intent.id, expires_at: intent.expires_at },
      summary: {
        page_count: intent.page_count,
        asset_count: intent.asset_count,
        total_bytes: intent.total_bytes,
      },
      authentication_options: authenticationOptions,
    }, 201);
  })
  .delete("/api/dashboard/knowledge-export-intents/:id", async ({ request, params }) => {
    const principal = await ownerRequest(request, true);
    emptyObjectSchema.parse(await bodyJson(request));
    await knowledgeExports.discard(z.string().uuid().parse(params.id), {
      ownerUserId: principal.userId,
      sessionId: principal.sessionId,
    });
    return json({ cancelled: true });
  })
  .get("/api/dashboard/knowledge-exports/:id/status", async ({ request, params }) => {
    const principal = await ownerRequest(request);
    const intentId = z.string().uuid().parse(params.id);
    const intent = await knowledgeExports.getIntent(intentId);
    if (!intent || intent.owner_user_id !== principal.userId || intent.session_id !== principal.sessionId) {
      return problem("Knowledge export intent not found", 404, "not_found");
    }
    if (!intent.confirmed_at || new Date(intent.expires_at).getTime() <= Date.now()) {
      return problem("A fresh passkey confirmation is required", 403, "passkey_required");
    }
    const preparation = await ensureKnowledgeExport(
      intentId,
      () => claimConfirmedExport(intentId, principal),
    );
    if (preparation.status === "ready") {
      return json(readyExportBody(intentId, preparation.staged));
    }
    if (preparation.status === "failed") {
      return json({
        status: "failed",
        message: preparation.message,
        code: preparation.code,
      });
    }
    return json({ status: "processing", status_url: exportStatusUrl(intentId) }, 202);
  })
  .get("/api/dashboard/knowledge-exports/:id/download", async ({ request, params, server }) => {
    disableStreamingRequestIdleTimeout(server, request);
    if (!requestMatchesOrigin(request, config.APP_ORIGIN)) throw new SecurityError("Not found", 404);
    const principal = await authorizeDashboardRequest(request, "download");
    if (!principal) throw new SecurityError("Dashboard session required", 401);
    const intentId = z.string().uuid().parse(params.id);
    const intent = await knowledgeExports.getIntent(intentId);
    if (!intent || intent.owner_user_id !== principal.userId || intent.session_id !== principal.sessionId) {
      return problem("Knowledge export intent not found", 404, "not_found");
    }
    if (!intent.confirmed_at || new Date(intent.expires_at).getTime() <= Date.now()) {
      return problem("A fresh passkey confirmation is required", 403, "passkey_required");
    }
    const objectKey = stagedExportKey(intentId);
    const preparation = await ensureKnowledgeExport(
      intentId,
      () => claimConfirmedExport(intentId, principal),
    );
    if (preparation.status === "failed") {
      return problem(preparation.message, preparation.httpStatus, preparation.code);
    }
    if (preparation.status === "processing") return processingExportResponse(intentId);
    await claimConfirmedExport(intentId, principal);
    const response = await assetContentResponse(request, {
      filename: exportFilename(),
      content_type: "application/zip",
      size_bytes: preparation.staged.sizeBytes,
      content_hash: preparation.staged.contentHash,
    }, storage, false, objectKey);
    return response;
  })
  .get("/api/dashboard/documents", async ({ request, query }) => {
    await ownerRequest(request);
    const parsed = parseDashboardDocumentCatalogQuery(query);
    const page = parsed.query
      ? await dashboardDocumentCatalog.search(parsed.query, parsed.options)
      : await dashboardDocumentCatalog.list(parsed.options);
    return json(dashboardDocumentCatalogPage(page));
  })
  .get("/api/dashboard/automations", async ({ request }) => {
    await ownerRequest(request);
    const registrations = await dashboardAutomations.listActive();
    return json({
      automations: await Promise.all(registrations.map(async (registration) => {
        const instructions = await dashboardDocumentCatalog.get(registration.instructions_document_id);
        return {
          id: registration.id,
          name: registration.name,
          instructions: instructions ? dashboardDocumentSummary(instructions) : null,
        };
      })),
    });
  })
  .post("/api/dashboard/documents", async ({ request }) => {
    const principal = await ownerRequest(request, true);
    const input = createKnowledgeDocumentSchema.parse(await bodyJson(request));
    const created = await dashboardKnowledgeDocuments.create(input, {
      kind: "dashboard",
      subject: principal.userId,
    });
    const response = await dashboardKnowledgeDocumentResponse(created.document_id);
    return response ? json(response, 201) : problem("Document was not retained", 409, "write_conflict");
  })
  .get("/api/dashboard/documents/:id", async ({ request, params }) => {
    await ownerRequest(request);
    const document = await dashboardDocumentCatalog.get(z.string().uuid().parse(params.id));
    return document
      ? json(dashboardDocumentSummary(document))
      : problem("Document not found", 404, "not_found");
  })
  .get("/api/dashboard/source-records/:id", async ({ request, params }) => {
    await ownerRequest(request);
    const record = await dashboardSourceRecords.get(z.string().uuid().parse(params.id));
    if (!record) return problem("Source record not found", 404, "not_found");
    const renderedHtml = record.body_markdown === null
      ? ""
      : await renderMarkdown(record.body_markdown, privateDocumentResolvers());
    return json(dashboardSourceRecord(record, renderedHtml));
  })
  .get("/api/dashboard/documents/:id/neighborhood", async ({ request, params, query }) => {
    await ownerRequest(request);
    const neighborhood = await dashboardDocumentCatalog.neighborhood(
      z.string().uuid().parse(params.id),
      parseDashboardDocumentNeighborhoodQuery(query),
    );
    return neighborhood
      ? json(dashboardDocumentNeighborhood(neighborhood))
      : problem("Document not found", 404, "not_found");
  })
  .get("/api/dashboard/knowledge-documents/:id", async ({ request, params }) => {
    await ownerRequest(request);
    const document = await dashboardKnowledgeDocumentResponse(z.string().uuid().parse(params.id));
    return document ? json(document) : problem("Knowledge document not found", 404, "not_found");
  })
  .get("/api/dashboard/knowledge-documents/:id/publication-preview", async ({ request, params }) => {
    await ownerRequest(request);
    const documentId = z.string().uuid().parse(params.id);
    const [document, status] = await Promise.all([
      dashboardKnowledgeDocuments.get(documentId),
      publications.status("page", documentId),
    ]);
    if (!document || document.archived_at) {
      return problem("Active knowledge document not found", 404, "not_found");
    }
    const preview = publicationPreviewTargets({ id: documentId, title: document.title });
    const renderedHtml = await renderMarkdown(
      document.body_markdown,
      preview.markdownResolvers,
    );
    const references = await Promise.all(
      extractDocumentLinks(document.body_markdown).map(preview.resolveTarget),
    );
    let republication = null;
    if (status.active && status.published_revision_number !== null) {
      const [published, candidate, history] = await Promise.all([
        dashboardKnowledgeDocuments.revision(documentId, status.published_revision_number),
        dashboardKnowledgeDocuments.revision(documentId, document.revision_number),
        dashboardKnowledgeDocuments.history(documentId, { limit: 100 }),
      ]);
      if (!published || !candidate) {
        return problem("Published revision evidence is unavailable", 409, "publication_state_invalid");
      }
      republication = await dashboardRepublicationReview(
        published,
        candidate,
        history.revisions,
      );
    }
    return json({
      page_id: document.document_id,
      version_id: document.current_revision_id,
      version_number: document.revision_number,
      title: document.title,
      summary: document.summary,
      rendered_html: renderedHtml,
      current_public_url: status.active && status.public_id
        ? `${config.APP_ORIGIN}/p/${status.public_id}`
        : null,
      warnings: publicationWarnings(
        document.body_markdown,
        [document.title, document.summary],
      ),
      references: references.map(({ contentType: _contentType, href: publicUrl, ...reference }) => ({
        ...reference,
        public_url: publicUrl === "#" ? null : publicUrl,
      })),
      republication,
    });
  })
  .put("/api/dashboard/knowledge-documents/:id", async ({ request, params }) => {
    const principal = await ownerRequest(request, true);
    const documentId = z.string().uuid().parse(params.id);
    const input = updateKnowledgeDocumentSchema.parse(await bodyJson(request));
    const updated = await dashboardKnowledgeDocuments.update(documentId, input, {
      kind: "dashboard",
      subject: principal.userId,
    });
    if (!updated) return problem("Knowledge document not found", 404, "not_found");
    const response = await dashboardKnowledgeDocumentResponse(documentId);
    return response ? json(response) : problem("Document update was not retained", 409, "write_conflict");
  })
  .post("/api/dashboard/knowledge-documents/:id/archive", async ({ request, params }) => {
    const principal = await ownerRequest(request, true);
    const documentId = z.string().uuid().parse(params.id);
    const input = archiveKnowledgeDocumentSchema.parse(await bodyJson(request));
    const archived = await dashboardKnowledgeDocuments.archive(documentId, input, {
      kind: "dashboard",
      subject: principal.userId,
    });
    if (!archived) return problem("Knowledge document not found", 404, "not_found");
    const response = await dashboardKnowledgeDocumentResponse(documentId);
    return response ? json(response) : problem("Document archive was not retained", 409, "write_conflict");
  })
  .post("/api/dashboard/knowledge-documents/:id/deletion-intents", async ({ request, params }) => {
    const principal = await ownerRequest(request, true);
    emptyObjectSchema.parse(await bodyJson(request));
    const documentId = z.string().uuid().parse(params.id);
    const [document, publication] = await Promise.all([
      dashboardKnowledgeDocuments.get(documentId),
      publications.status("page", documentId),
    ]);
    if (!document) return problem("Knowledge document not found", 404, "not_found");
    if (!document.archived_at || publication.active) {
      return problem("Only archived, unpublished knowledge documents can be permanently deleted", 409, "document_not_deletable");
    }
    const intent = await pageDeletions.createIntent(documentId, {
      ownerUserId: principal.userId,
      sessionId: principal.sessionId,
    });
    if (!intent) {
      return problem("Knowledge document is no longer eligible for permanent deletion", 409, "document_not_deletable");
    }
    const authenticationOptions = await issueConfirmationOptions("page_deletion", intent.id);
    return json({ intent, authentication_options: authenticationOptions }, 201);
  })
  .get("/api/dashboard/knowledge-documents/:id/history", async ({ request, params, query }) => {
    await ownerRequest(request);
    const history = await dashboardKnowledgeDocuments.history(
      z.string().uuid().parse(params.id),
      {
        ...(query.before === undefined ? {} : {
          before_revision_number: z.coerce.number().int().positive().parse(query.before),
        }),
        limit: query.limit === undefined
          ? 100
          : z.coerce.number().int().min(1).max(100).parse(query.limit),
      },
    );
    return json({
      revisions: history.revisions.map(dashboardKnowledgeRevision),
      has_more: history.has_more,
    });
  })
  .get("/api/dashboard/knowledge-documents/:id/versions/:version/diff", async ({ request, params, query }) => {
    await ownerRequest(request);
    const documentId = z.string().uuid().parse(params.id);
    const revisionNumber = z.coerce.number().int().positive().parse(params.version);
    const previousRevisionNumber = query.from === undefined
      ? null
      : z.coerce.number().int().positive().parse(query.from);
    if (previousRevisionNumber !== null && previousRevisionNumber >= revisionNumber) {
      return problem("The comparison revision must be earlier than the selected revision", 422, "invalid_comparison");
    }
    const [previous, current] = await Promise.all([
      previousRevisionNumber === null
        ? Promise.resolve(null)
        : dashboardKnowledgeDocuments.revision(documentId, previousRevisionNumber),
      dashboardKnowledgeDocuments.revision(documentId, revisionNumber),
    ]);
    if (!current) return problem("Revision not found", 404, "not_found");
    if (previousRevisionNumber !== null && !previous) {
      return problem("Comparison revision not found", 404, "not_found");
    }
    return json({
      page_id: documentId,
      comparison: { from_version: previousRevisionNumber, to_version: revisionNumber },
      ...await dashboardKnowledgeRevisionDelta(previous, current),
    });
  })
  .get("/api/dashboard/knowledge-changes", async ({ request, query }) => {
    await ownerRequest(request);
    const before = typeof query.before === "string"
      ? z.string().regex(/^cu-page-changes-v1\.[0-9a-z]+$/).parse(query.before)
      : undefined;
    const limit = query.limit === undefined
      ? 50
      : z.coerce.number().int().min(1).max(100).parse(query.limit);
    return json(await dashboardKnowledgeDocuments.recentChanges({
      ...(before ? { before } : {}),
      limit,
    }));
  })
  .get("/api/dashboard/assets", async ({ request }) => {
    await ownerRequest(request);
    return json(await mapConcurrently(
      await dashboardAssets.list(),
      8,
      dashboardAssetPublication,
    ));
  })
  // Keep large dashboard recovery uploads on the raw streaming path too.
  .put("/api/dashboard/assets/:id/content", async ({ request, params }) => {
    if (!requestMatchesOrigin(request, config.APP_ORIGIN)) throw new SecurityError("Not found", 404);
    const principal = await authorizeDashboardRequest(request, "upload");
    if (!principal) throw new SecurityError("Dashboard session required", 401);
    const asset = await dashboardAssets.getForStorage(z.string().uuid().parse(params.id));
    if (!asset) return problem("Asset not found", 404, "not_found");
    const expectedSize = Number(asset.size_bytes);
    const suppliedSize = request.headers.get("content-length");
    if (suppliedSize !== null && (!/^\d+$/.test(suppliedSize) || Number(suppliedSize) !== expectedSize)) {
      return problem("Asset size mismatch", 422, "integrity_error");
    }
    if (request.headers.get("content-type")?.toLowerCase() !== asset.content_type.toLowerCase()) {
      return problem("Asset content type mismatch", 422, "integrity_error");
    }
    if (!request.body && expectedSize !== 0) return problem("Asset size mismatch", 422, "integrity_error");
    try {
      await storage.write({
        id: asset.document_id,
        objectKey: asset.object_key,
        filename: asset.filename,
        contentType: asset.content_type,
        sizeBytes: expectedSize,
        contentHash: asset.content_hash,
      }, request.body);
    } catch (error) {
      if (error instanceof AssetIntegrityError) return problem(error.message, 422, "integrity_error");
      throw error;
    }
    return json({ uploaded: true });
  }, { parse: "none" })
  .get("/api/dashboard/assets/:id/status", async ({ request, params }) => {
    await ownerRequest(request);
    const asset = await dashboardAssets.getForStorage(z.string().uuid().parse(params.id));
    if (!asset) return problem("Asset not found", 404, "not_found");
    const publicationStatus = await publications.status("asset", asset.document_id);
    return json({
      content_available: await storage.verify(
        asset.object_key,
        Number(asset.size_bytes),
        asset.content_hash,
      ),
      public_url: publicationStatus.active && publicationStatus.public_id
        ? `${config.ASSET_ORIGIN}/a/${publicationStatus.public_id}`
        : null,
      published: publicationStatus.active,
    });
  })
  .get("/api/dashboard/assets/:id/content", async ({ request, params }) => {
    await ownerRequest(request);
    const asset = await dashboardAssets.getForStorage(z.string().uuid().parse(params.id));
    if (!asset) return problem("Asset not found", 404, "not_found");
    return assetContentResponse(request, asset, storage, true, asset.object_key);
  })
  .delete("/api/dashboard/assets/:id", async ({ request, params }) => {
    await ownerRequest(request, true);
    const objectKey = await dashboardAssets.delete(z.string().uuid().parse(params.id));
    if (!objectKey) return problem("Published or referenced asset cannot be deleted", 409, "asset_in_use");
    await storage.delete(objectKey);
    return json({ deleted: true });
  })

  .post("/api/dashboard/publication-intents", async ({ request }) => {
    const principal = await ownerRequest(request, true);
    const input = publicationIntentSchema.parse(await bodyJson(request));
    const suppliedIntentId = request.headers.get("x-publication-intent-id");
    const intentId = suppliedIntentId === null
      ? undefined
      : z.string().uuid().parse(suppliedIntentId);
    const intent = await publications.begin(input, {
      ownerUserId: principal.userId,
      sessionId: principal.sessionId,
    }, intentId);
    if (intent.action === "publish") {
      await storage.materializePublicationArtifact(intent.id);
    }
    const authenticationOptions = await issueConfirmationOptions("publication", intent.id);
    return json({ intent, authentication_options: authenticationOptions }, 201);
  })
  .delete("/api/dashboard/publication-intents/:id", async ({ request, params }) => {
    const principal = await ownerRequest(request, true);
    await publications.cancel(z.string().uuid().parse(params.id), {
      ownerUserId: principal.userId,
      sessionId: principal.sessionId,
    });
    return json({ cancelled: true });
  })
  .get("/api/dashboard/publication-entrypoint", async ({ request }) => {
    await ownerRequest(request);
    return json({ entrypoint: await publicEntrypoint.get() });
  })
  .get("/api/dashboard/publication-entrypoint/candidates", async ({ request }) => {
    await ownerRequest(request);
    return json({
      candidates: (await publicEntrypoint.candidates()).map(({
        representation_token: _representationToken,
        ...candidate
      }) => candidate),
    });
  })
  .put("/api/dashboard/publication-entrypoint", async ({ request }) => {
    await ownerRequest(request, true);
    const input = publicationEntrypointSchema.parse(await bodyJson(request));
    return json({ entrypoint: await publicEntrypoint.set(input) });
  });

if (production) {
  console.info("security_mode", {
    dashboard_auth: "cookie-only",
    publication_confirmation: "separate-service",
  });
}
