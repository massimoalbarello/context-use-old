import { resolve } from "node:path";
import {
  AutomationRegistryRepository,
  AssetRepository,
  KnowledgePageRepository,
  KnowledgeBundleRepository,
  KNOWLEDGE_BUNDLE_PART_SIZE,
  PrivateObjectCatalogRepository,
  PageDeletionRepository,
  PublicationRepository,
  PublicEntrypointRepository,
  SourceRecordRepository,
  createPool,
  extractObjectLinks,
  mapConcurrently,
  normalizeLegacyObjectLinks,
} from "@context-use/database";
import {
  archiveSourceRecordSchema,
  archivePageSchema,
  createPageSchema,
  deleteSourceRecordSchema,
  publicationEntrypointSchema,
  publicationIntentSchema,
  updatePageSchema,
} from "@context-use/shared";
import { Elysia } from "elysia";
import { z } from "zod";
import { authorizeDashboardRequest, type DashboardPrincipal } from "./auth-client.ts";
import { forwardDashboardAuthRoute } from "./auth-dashboard-gateway.ts";
import { assetContentResponse } from "./asset-content.ts";
import { config, production } from "./config.ts";
import {
  claimConfirmedBundleExport,
  issueConfirmationOptions,
} from "./confirmation-client.ts";
import { dashboardServices } from "./dashboard-services.ts";
import {
  dashboardObjectCatalogPage,
  dashboardObjectNeighborhood,
  dashboardObjectSummary,
  parseDashboardObjectCatalogQuery,
  parseDashboardObjectNeighborhoodQuery,
} from "./dashboard-object-discovery.ts";
import { dashboardSourceRecord } from "./dashboard-source-records.ts";
import {
  dashboardPage,
  dashboardPageRevision,
  dashboardPageRevisionDelta,
  dashboardRepublicationReview,
} from "./dashboard-pages.ts";
import { bodyJson, json, problem, routeError } from "./http.ts";
import { publicationWarnings, renderMarkdown } from "./markdown.ts";
import {
  SecurityError,
  requestMatchesOrigin,
  securityHeaders,
} from "./security.ts";
import { AssetIntegrityError } from "./storage.ts";
import { BrokeredStorage } from "./storage-client.ts";
import { BrokeredMarkdownBlobStore } from "./markdown-blob-store.ts";
import {
  KNOWLEDGE_BUNDLE_CONTENT_TYPE,
  materializeFullKnowledgeBundle,
  streamFullKnowledgeBundle,
  validateFullKnowledgeBundle,
} from "./knowledge-bundle.ts";
import { disableStreamingRequestIdleTimeout } from "./streaming-timeout.ts";

const dashboardPool = createPool(config.DATABASE_URL);
const storage = new BrokeredStorage({
  socketPath: config.STORAGE_SOCKET_PATH,
  token: config.STORAGE_DASHBOARD_TOKEN,
});
const markdownBlobs = new BrokeredMarkdownBlobStore(storage);

const dashboardPages = new KnowledgePageRepository(dashboardPool, markdownBlobs);
const pageDeletions = new PageDeletionRepository(dashboardPool);
const dashboardAssets = new AssetRepository(dashboardPool);
const publications = new PublicationRepository(dashboardPool);
const publicEntrypoint = new PublicEntrypointRepository(dashboardPool);
const knowledgeBundles = new KnowledgeBundleRepository(dashboardPool);
const dashboardObjectCatalog = new PrivateObjectCatalogRepository(dashboardPool);
const dashboardAutomations = new AutomationRegistryRepository(dashboardPool);
const dashboardSourceRecords = new SourceRecordRepository(dashboardPool, markdownBlobs);

async function dashboardAssetPublication(asset: {
  object_id: string;
  filename: string;
  content_type: string;
  size_bytes: string | number;
  content_hash: string;
  created_at: Date | string;
}) {
  const status = await publications.status("asset", asset.object_id);
  return {
    id: asset.object_id,
    filename: asset.filename,
    content_type: asset.content_type,
    size_bytes: Number(asset.size_bytes),
    content_hash: asset.content_hash,
    created_at: asset.created_at,
    public_id: status.public_id,
    published: status.active,
  };
}

const bundlePreparations = new Set<string>();
const importPreparations = new Set<string>();

function stagedBundleKey(intentId: string): string {
  return `bundles/${intentId}.cuse`;
}

function importPartKey(importId: string, partNumber: number): string {
  return `imports/${importId}/parts/${partNumber}`;
}

async function ownerRequest(request: Request, mutation: boolean | "upload" = false) {
  if (!requestMatchesOrigin(request, config.APP_ORIGIN)) throw new SecurityError("Not found", 404);
  const principal = await authorizeDashboardRequest(request, mutation === "upload" ? "upload" : mutation ? "json" : "read");
  if (!principal) throw new SecurityError("Dashboard session required", 401);
  return principal;
}

function privateObjectResolvers() {
  return {
    object: async (id: string) => {
      const object = await dashboardObjectCatalog.get(id);
      if (!object || object.lifecycle !== "active") return { available: false as const };
      if (object.object_kind === "asset") {
        return {
          available: true as const,
          representation: "asset" as const,
          href: `/api/dashboard/assets/${id}/content`,
          contentType: object.content_type ?? "application/octet-stream",
        };
      }
      return {
        available: true as const,
        representation: object.object_kind === "record" ? "record" as const : "page" as const,
        href: `/app/objects/${id}`,
      };
    },
  };
}

async function dashboardPageResponse(objectId: string) {
  const [page, publicationStatus] = await Promise.all([
    dashboardPages.get(objectId),
    publications.status("page", objectId),
  ]);
  if (!page) return null;
  const renderedHtml = await renderMarkdown(
    page.body_markdown,
    privateObjectResolvers(),
  );
  return dashboardPage(page, renderedHtml, {
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
  kind: "page" | "asset" | "record" | "object";
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
      const object = await dashboardObjectCatalog.get(id);
      if (!object || object.lifecycle !== "active") {
        return {
          kind: "object",
          id,
          label: "Missing object",
          public: false,
          href: null,
          contentType: null,
        };
      }
      if (object.object_kind === "asset") {
        const status = await publications.status("asset", id);
        return {
          kind: "asset",
          id,
          label: object.filename ?? "Asset",
          public: status.active,
          href: status.active && status.public_id
            ? `${config.ASSET_ORIGIN}/a/${status.public_id}`
            : null,
          contentType: object.content_type,
        };
      }
      if (object.object_kind === "page") {
        const status = await publications.status("page", id);
        return {
          kind: "page",
          id,
          label: object.title ?? "Page",
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
        label: object.title ?? "Source record",
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
      object: async (id: string) => {
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

function fullExportStatusUrl(intentId: string): string {
  return `/api/dashboard/knowledge-bundles/${encodeURIComponent(intentId)}/status`;
}

function fullExportDownloadUrl(intentId: string): string {
  return `/api/dashboard/knowledge-bundles/${encodeURIComponent(intentId)}/download`;
}

function bundleFilename(): string {
  return `context-use-knowledge-${new Date().toISOString().slice(0, 10)}.cuse`;
}

function startFullKnowledgeExport(
  intentId: string,
  principal: DashboardPrincipal,
): void {
  if (bundlePreparations.has(intentId)) return;
  bundlePreparations.add(intentId);
  void (async () => {
    try {
      await claimConfirmedBundleExport(intentId, principal);
      await knowledgeBundles.captureExport(intentId, {
        ownerUserId: principal.userId,
        sessionId: principal.sessionId,
      });
      const metadata = await storage.writeBundle(
        stagedBundleKey(intentId),
        streamFullKnowledgeBundle({ intentId, repository: knowledgeBundles, storage }),
      );
      await knowledgeBundles.completeExport(intentId, metadata.sizeBytes, metadata.contentHash);
    } catch (error) {
      await knowledgeBundles.failExport(
        intentId,
        "bundle_export_failed",
        "The full knowledge bundle could not be prepared. Start a new export and try again.",
      ).catch(() => undefined);
      console.error("knowledge_bundle_export_failed", error instanceof Error
        ? { intentId, name: error.name, message: error.message }
        : { intentId, type: typeof error });
    } finally {
      bundlePreparations.delete(intentId);
    }
  })();
}

function startKnowledgeImportValidation(importId: string): void {
  if (importPreparations.has(importId)) return;
  importPreparations.add(importId);
  void (async () => {
    try {
      const parts = await knowledgeBundles.importParts(importId);
      await validateFullKnowledgeBundle({ importId, parts, repository: knowledgeBundles, storage });
    } catch (error) {
      await knowledgeBundles.failImport(
        importId,
        "bundle_validation_failed",
        error instanceof Error ? error.message : "The knowledge bundle could not be validated.",
      ).catch(() => undefined);
      console.error("knowledge_bundle_validation_failed", error instanceof Error
        ? { importId, name: error.name, message: error.message }
        : { importId, type: typeof error });
    } finally {
      importPreparations.delete(importId);
    }
  })();
}

function startKnowledgeImportRestore(
  importId: string,
  principal: { userId: string; sessionId: string },
): void {
  if (importPreparations.has(importId)) return;
  importPreparations.add(importId);
  void (async () => {
    try {
      const parts = await knowledgeBundles.importParts(importId);
      await materializeFullKnowledgeBundle({
        importId,
        parts,
        repository: knowledgeBundles,
        storage,
        principal: { ownerUserId: principal.userId, sessionId: principal.sessionId },
      });
      await Promise.allSettled(parts.map((part) => storage.deleteImportPart(importPartKey(importId, part.part_number))));
    } catch (error) {
      await knowledgeBundles.failImport(
        importId,
        "bundle_restore_failed",
        error instanceof Error ? error.message : "The knowledge bundle could not be restored.",
      ).catch(() => undefined);
      console.error("knowledge_bundle_restore_failed", error instanceof Error
        ? { importId, name: error.name, message: error.message }
        : { importId, type: typeof error });
    } finally {
      importPreparations.delete(importId);
    }
  })();
}

function bundleStatusBody(status: Awaited<ReturnType<KnowledgeBundleRepository["exportStatus"]>>) {
  if (!status) return null;
  return {
    status: status.status,
    phase: status.phase,
    records_completed: Number(status.records_completed),
    records_total: Number(status.records_total),
    blobs_completed: Number(status.objects_completed),
    blobs_total: Number(status.objects_total),
    bytes_completed: Number(status.bytes_completed),
    bytes_total: Number(status.bytes_total),
    ...(status.status === "ready" ? {
      download_url: fullExportDownloadUrl(status.intent_id),
      filename: bundleFilename(),
      size_bytes: Number(status.bundle_size_bytes),
    } : {}),
    ...(status.status === "failed" ? {
      code: status.error_code,
      message: status.error_message,
    } : {}),
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
  .get("/api/health", () => json({ status: "ok", version: "0.1.96", service: "dashboard" }))
  .get("/api/dashboard/session", ({ request }) => forwardDashboardAuthRoute(request))
  .get("/api/dashboard/csrf", ({ request }) => forwardDashboardAuthRoute(request))
  .post("/api/dashboard/passkey-enrollment-intents", ({ request }) => forwardDashboardAuthRoute(request), { parse: "none" })
  .post("/api/dashboard/passkey-enrollment-intents/:id/confirm", ({ request }) => forwardDashboardAuthRoute(request), { parse: "none" })
  .post("/api/dashboard/passkeys/:id/removal-intents", ({ request }) => forwardDashboardAuthRoute(request), { parse: "none" })
  .post("/api/dashboard/passkeys/:id/remove", ({ request }) => forwardDashboardAuthRoute(request), { parse: "none" })
  .post("/api/dashboard/publications/confirm", ({ request }) => forwardDashboardAuthRoute(request), { parse: "none" })
  .post("/api/dashboard/knowledge-bundle-exports/confirm", ({ request }) => forwardDashboardAuthRoute(request), { parse: "none" })
  .post("/api/dashboard/knowledge-imports/confirm", ({ request }) => forwardDashboardAuthRoute(request), { parse: "none" })
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

  .post("/api/dashboard/knowledge-bundle-export-intents", async ({ request }) => {
    const principal = await ownerRequest(request, true);
    emptyObjectSchema.parse(await bodyJson(request));
    const exportPrincipal = { ownerUserId: principal.userId, sessionId: principal.sessionId };
    const intent = await knowledgeBundles.createExportIntent(exportPrincipal);
    await Promise.allSettled(intent.discarded_export_ids.map((id) => (
      storage.deleteBundle(stagedBundleKey(id))
    )));
    try {
      const authenticationOptions = await issueConfirmationOptions("knowledge_export", intent.id);
      return json({
        intent: { id: intent.id, expires_at: intent.expires_at },
        summary: {
          page_count: intent.page_count,
          asset_count: intent.asset_count,
          estimated_bytes: intent.estimated_bytes,
        },
        authentication_options: authenticationOptions,
        status_url: fullExportStatusUrl(intent.id),
      }, 201);
    } catch (error) {
      await knowledgeBundles.discardExportIntent(intent.id, exportPrincipal);
      throw error;
    }
  })
  .get("/api/dashboard/knowledge-bundles/:id/status", async ({ request, params }) => {
    const principal = await ownerRequest(request);
    const intentId = z.string().uuid().parse(params.id);
    const intent = await knowledgeBundles.exportIntent(intentId);
    if (!intent || intent.owner_user_id !== principal.userId || intent.session_id !== principal.sessionId) {
      return problem("Knowledge bundle export not found", 404, "not_found");
    }
    if (!intent.confirmed_at || new Date(intent.expires_at).getTime() <= Date.now()) {
      return problem("A fresh passkey confirmation is required", 403, "passkey_required");
    }
    let status = await knowledgeBundles.exportStatus(intentId);
    if (!status) return problem("Knowledge bundle export not found", 404, "not_found");
    if (["pending", "snapshotting", "processing"].includes(status.status)
        && !bundlePreparations.has(intentId)) {
      const staged = await storage.inspectBundle(stagedBundleKey(intentId));
      if (staged) {
        await knowledgeBundles.completeExport(intentId, staged.sizeBytes, staged.contentHash);
        status = await knowledgeBundles.exportStatus(intentId);
      } else {
        startFullKnowledgeExport(intentId, principal);
      }
    }
    return json(bundleStatusBody(status), status?.status === "ready" ? 200 : 202);
  })
  .get("/api/dashboard/knowledge-bundles/:id/download", async ({ request, params, server }) => {
    disableStreamingRequestIdleTimeout(server, request);
    if (!requestMatchesOrigin(request, config.APP_ORIGIN)) throw new SecurityError("Not found", 404);
    const principal = await authorizeDashboardRequest(request, "download");
    if (!principal) throw new SecurityError("Dashboard session required", 401);
    const intentId = z.string().uuid().parse(params.id);
    const intent = await knowledgeBundles.exportIntent(intentId);
    const status = await knowledgeBundles.exportStatus(intentId);
    if (!intent || !status || status.status !== "ready"
        || intent.owner_user_id !== principal.userId || intent.session_id !== principal.sessionId) {
      return problem("Knowledge bundle export not found", 404, "not_found");
    }
    if (!intent.confirmed_at || new Date(intent.expires_at).getTime() <= Date.now()) {
      return problem("A fresh passkey confirmation is required", 403, "passkey_required");
    }
    await claimConfirmedBundleExport(intentId, principal);
    return assetContentResponse(request, {
      filename: bundleFilename(),
      content_type: KNOWLEDGE_BUNDLE_CONTENT_TYPE,
      size_bytes: Number(status.bundle_size_bytes),
      content_hash: status.bundle_sha256!,
    }, storage, false, stagedBundleKey(intentId));
  })
  .get("/api/dashboard/knowledge-imports/availability", async ({ request }) => {
    await ownerRequest(request);
    return json({ available: await knowledgeBundles.acceptsFullImport() });
  })
  .post("/api/dashboard/knowledge-imports", async ({ request }) => {
    const principal = await ownerRequest(request, true);
    const input = z.object({
      filename: z.string().min(1).max(1024),
      size_bytes: z.number().int().positive().max(64 * 1024 ** 3),
    }).strict().parse(await bodyJson(request));
    if (!await knowledgeBundles.acceptsFullImport()) {
      return problem(
        "Full knowledge bundles can only be imported into a fresh Context Use instance.",
        409,
        "instance_not_fresh",
      );
    }
    const job = await knowledgeBundles.createImport({
      ownerUserId: principal.userId,
      sessionId: principal.sessionId,
    }, { filename: input.filename, totalBytes: input.size_bytes });
    return json({
      import_id: job.id,
      part_size: job.part_size,
      total_parts: job.total_parts,
      uploaded_parts: [],
      status_url: `/api/dashboard/knowledge-imports/${encodeURIComponent(job.id)}/status`,
    }, 201);
  })
  .put("/api/dashboard/knowledge-imports/:id/parts/:part", async ({ request, params, server }) => {
    disableStreamingRequestIdleTimeout(server, request);
    const principal = await ownerRequest(request, "upload");
    const importId = z.string().uuid().parse(params.id);
    const partNumber = z.coerce.number().int().nonnegative().parse(params.part);
    const job = await knowledgeBundles.importStatus(importId);
    if (!job || job.owner_user_id !== principal.userId || job.session_id !== principal.sessionId
        || job.status !== "uploading" || partNumber >= job.total_parts) {
      return problem("Knowledge import not found", 404, "not_found");
    }
    const expectedBytes = partNumber === job.total_parts - 1
      ? Number(job.total_bytes) - partNumber * job.part_size
      : job.part_size;
    const sizeBytes = Number(request.headers.get("content-length"));
    const contentHash = z.string().regex(/^[a-f0-9]{64}$/)
      .parse(request.headers.get("x-content-sha256"));
    if (sizeBytes !== expectedBytes) return problem("Knowledge import part has the wrong size", 400, "part_size_mismatch");
    const blobKey = importPartKey(importId, partNumber);
    await storage.writeImportPart({
      importId,
      partNumber,
      blobKey,
      sizeBytes,
      contentHash,
      body: request.body,
    });
    await knowledgeBundles.recordImportPart(importId, {
      part_number: partNumber,
      object_key: blobKey,
      size_bytes: sizeBytes,
      content_hash: contentHash,
    });
    return new Response(null, { status: 204, headers: securityHeaders });
  }, { parse: "none" })
  .post("/api/dashboard/knowledge-imports/:id/validate", async ({ request, params }) => {
    const principal = await ownerRequest(request, true);
    emptyObjectSchema.parse(await bodyJson(request));
    const importId = z.string().uuid().parse(params.id);
    await knowledgeBundles.beginImportValidation(importId, {
      ownerUserId: principal.userId,
      sessionId: principal.sessionId,
    });
    startKnowledgeImportValidation(importId);
    return json({
      status: "validating",
      status_url: `/api/dashboard/knowledge-imports/${encodeURIComponent(importId)}/status`,
    }, 202);
  })
  .get("/api/dashboard/knowledge-imports/:id/status", async ({ request, params }) => {
    const principal = await ownerRequest(request);
    const importId = z.string().uuid().parse(params.id);
    let job = await knowledgeBundles.importStatus(importId);
    if (!job || job.owner_user_id !== principal.userId || job.session_id !== principal.sessionId) {
      return problem("Knowledge import not found", 404, "not_found");
    }
    if (job.status === "validating" && !importPreparations.has(importId)) {
      startKnowledgeImportValidation(importId);
    } else if (job.status === "restoring" && !importPreparations.has(importId)) {
      startKnowledgeImportRestore(importId, principal);
    }
    job = await knowledgeBundles.importStatus(importId) ?? job;
    const parts = job.status === "uploading" ? await knowledgeBundles.importParts(importId) : [];
    return json({
      import_id: job.id,
      status: job.status,
      phase: job.phase,
      parts_completed: job.parts_completed,
      total_parts: job.total_parts,
      uploaded_parts: parts.map((part) => part.part_number),
      records_completed: Number(job.records_completed),
      records_total: Number(job.records_total),
      blobs_completed: Number(job.objects_completed),
      blobs_total: Number(job.objects_total),
      bytes_completed: Number(job.bytes_completed),
      bytes_total: Number(job.bytes_total),
      ...(job.status === "awaiting_confirmation" ? {
        authentication_options: await issueConfirmationOptions("knowledge_import", importId),
      } : {}),
      ...(job.status === "failed" ? { code: job.error_code, message: job.error_message } : {}),
    });
  })
  .get("/api/dashboard/objects", async ({ request, query }) => {
    await ownerRequest(request);
    const parsed = parseDashboardObjectCatalogQuery(query);
    const page = parsed.query
      ? await dashboardObjectCatalog.search(parsed.query, parsed.options)
      : await dashboardObjectCatalog.list(parsed.options);
    return json(dashboardObjectCatalogPage(page));
  })
  .get("/api/dashboard/automations", async ({ request }) => {
    await ownerRequest(request);
    const registrations = await dashboardAutomations.listActive();
    return json({
      automations: await Promise.all(registrations.map(async (registration) => {
        const instructions = await dashboardObjectCatalog.get(registration.instructions_document_id);
        return {
          id: registration.id,
          name: registration.name,
          instructions: instructions ? dashboardObjectSummary(instructions) : null,
        };
      })),
    });
  })
  .post("/api/dashboard/objects", async ({ request }) => {
    const principal = await ownerRequest(request, true);
    const input = createPageSchema.parse(await bodyJson(request));
    const created = await dashboardPages.create(input, {
      kind: "dashboard",
      subject: principal.userId,
    });
    const response = await dashboardPageResponse(created.object_id);
    return response ? json(response, 201) : problem("Page was not retained", 409, "write_conflict");
  })
  .get("/api/dashboard/objects/:id", async ({ request, params }) => {
    await ownerRequest(request);
    const object = await dashboardObjectCatalog.get(z.string().uuid().parse(params.id));
    return object
      ? json(dashboardObjectSummary(object))
      : problem("Object not found", 404, "not_found");
  })
  .get("/api/dashboard/source-records/:id", async ({ request, params }) => {
    await ownerRequest(request);
    const record = await dashboardSourceRecords.get(z.string().uuid().parse(params.id));
    if (!record) return problem("Source record not found", 404, "not_found");
    const renderedHtml = record.body_markdown === null
      ? ""
      : await renderMarkdown(record.body_markdown, privateObjectResolvers());
    return json(dashboardSourceRecord(record, renderedHtml));
  })
  .post("/api/dashboard/source-records/:id/archive", async ({ request, params }) => {
    await ownerRequest(request, true);
    const objectId = z.string().uuid().parse(params.id);
    const input = archiveSourceRecordSchema.omit({ object_id: true }).parse(await bodyJson(request));
    const result = await dashboardSourceRecords.archive(objectId, input.expected_revision_id);
    if (result === "not_found") return problem("Source record not found", 404, "not_found");
    if (result === "revision_conflict") {
      return problem("Source record changed; reload it before archiving", 409, "revision_conflict");
    }
    const record = await dashboardSourceRecords.get(objectId);
    if (!record) return problem("Source record not found", 404, "not_found");
    const renderedHtml = record.body_markdown === null
      ? ""
      : await renderMarkdown(record.body_markdown, privateObjectResolvers());
    return json(dashboardSourceRecord(record, renderedHtml));
  })
  .delete("/api/dashboard/source-records/:id", async ({ request, params }) => {
    await ownerRequest(request, true);
    const objectId = z.string().uuid().parse(params.id);
    const input = deleteSourceRecordSchema.omit({ object_id: true }).parse(await bodyJson(request));
    const result = await dashboardSourceRecords.delete(objectId, input.expected_revision_id);
    if (result === "not_found") return problem("Source record not found", 404, "not_found");
    if (result === "revision_conflict") {
      return problem("Source record changed; reload it before deleting", 409, "revision_conflict");
    }
    if (result === "not_archived") {
      return problem("Archive the source record before permanently deleting it", 409, "record_not_archived");
    }
    return json({ object_id: objectId, deleted: true });
  })
  .get("/api/dashboard/objects/:id/neighborhood", async ({ request, params, query }) => {
    await ownerRequest(request);
    const neighborhood = await dashboardObjectCatalog.neighborhood(
      z.string().uuid().parse(params.id),
      parseDashboardObjectNeighborhoodQuery(query),
    );
    return neighborhood
      ? json(dashboardObjectNeighborhood(neighborhood))
      : problem("Object not found", 404, "not_found");
  })
  .get("/api/dashboard/pages/:id", async ({ request, params }) => {
    await ownerRequest(request);
    const page = await dashboardPageResponse(z.string().uuid().parse(params.id));
    return page ? json(page) : problem("Page not found", 404, "not_found");
  })
  .get("/api/dashboard/pages/:id/publication-preview", async ({ request, params }) => {
    await ownerRequest(request);
    const pageId = z.string().uuid().parse(params.id);
    const [page, status] = await Promise.all([
      dashboardPages.get(pageId),
      publications.status("page", pageId),
    ]);
    if (!page || page.archived_at) {
      return problem("Active page not found", 404, "not_found");
    }
    const preview = publicationPreviewTargets({ id: pageId, title: page.title });
    const renderedHtml = await renderMarkdown(
      page.body_markdown,
      preview.markdownResolvers,
    );
    const references = await Promise.all(
      extractObjectLinks(normalizeLegacyObjectLinks(page.body_markdown))
        .map(preview.resolveTarget),
    );
    let republication = null;
    if (status.active && status.published_revision_number !== null) {
      const [published, candidate, history] = await Promise.all([
        dashboardPages.revision(pageId, status.published_revision_number),
        dashboardPages.revision(pageId, page.revision_number),
        dashboardPages.history(pageId, { limit: 100 }),
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
      page_id: page.object_id,
      version_id: page.current_revision_id,
      version_number: page.revision_number,
      title: page.title,
      summary: page.summary,
      rendered_html: renderedHtml,
      current_public_url: status.active && status.public_id
        ? `${config.APP_ORIGIN}/p/${status.public_id}`
        : null,
      warnings: publicationWarnings(
        page.body_markdown,
        [page.title, page.summary],
      ),
      references: references.map(({ contentType: _contentType, href: publicUrl, ...reference }) => ({
        ...reference,
        public_url: publicUrl === "#" ? null : publicUrl,
      })),
      republication,
    });
  })
  .put("/api/dashboard/pages/:id", async ({ request, params }) => {
    const principal = await ownerRequest(request, true);
    const pageId = z.string().uuid().parse(params.id);
    const input = updatePageSchema.parse(await bodyJson(request));
    const updated = await dashboardPages.update(pageId, input, {
      kind: "dashboard",
      subject: principal.userId,
    });
    if (!updated) return problem("Page not found", 404, "not_found");
    const response = await dashboardPageResponse(pageId);
    return response ? json(response) : problem("Page update was not retained", 409, "write_conflict");
  })
  .post("/api/dashboard/pages/:id/archive", async ({ request, params }) => {
    const principal = await ownerRequest(request, true);
    const pageId = z.string().uuid().parse(params.id);
    const input = archivePageSchema.parse(await bodyJson(request));
    const archived = await dashboardPages.archive(pageId, input, {
      kind: "dashboard",
      subject: principal.userId,
    });
    if (!archived) return problem("Page not found", 404, "not_found");
    const response = await dashboardPageResponse(pageId);
    return response ? json(response) : problem("Page archive was not retained", 409, "write_conflict");
  })
  .post("/api/dashboard/pages/:id/deletion-intents", async ({ request, params }) => {
    const principal = await ownerRequest(request, true);
    emptyObjectSchema.parse(await bodyJson(request));
    const pageId = z.string().uuid().parse(params.id);
    const [page, publication] = await Promise.all([
      dashboardPages.get(pageId),
      publications.status("page", pageId),
    ]);
    if (!page) return problem("Page not found", 404, "not_found");
    if (!page.archived_at || publication.active) {
      return problem("Only archived, unpublished pages can be permanently deleted", 409, "page_not_deletable");
    }
    const intent = await pageDeletions.createIntent(pageId, {
      ownerUserId: principal.userId,
      sessionId: principal.sessionId,
    });
    if (!intent) {
      return problem("Page is no longer eligible for permanent deletion", 409, "page_not_deletable");
    }
    const authenticationOptions = await issueConfirmationOptions("page_deletion", intent.id);
    return json({ intent, authentication_options: authenticationOptions }, 201);
  })
  .get("/api/dashboard/pages/:id/history", async ({ request, params, query }) => {
    await ownerRequest(request);
    const history = await dashboardPages.history(
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
      revisions: history.revisions.map(dashboardPageRevision),
      has_more: history.has_more,
    });
  })
  .get("/api/dashboard/pages/:id/versions/:version/diff", async ({ request, params, query }) => {
    await ownerRequest(request);
    const pageId = z.string().uuid().parse(params.id);
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
        : dashboardPages.revision(pageId, previousRevisionNumber),
      dashboardPages.revision(pageId, revisionNumber),
    ]);
    if (!current) return problem("Revision not found", 404, "not_found");
    if (previousRevisionNumber !== null && !previous) {
      return problem("Comparison revision not found", 404, "not_found");
    }
    return json({
      page_id: pageId,
      comparison: { from_version: previousRevisionNumber, to_version: revisionNumber },
      ...await dashboardPageRevisionDelta(previous, current),
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
    return json(await dashboardPages.recentChanges({
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
        id: asset.object_id,
        blobKey: asset.blob_key,
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
    const publicationStatus = await publications.status("asset", asset.object_id);
    return json({
      content_available: await storage.verify(
        asset.blob_key,
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
    return assetContentResponse(request, asset, storage, true, asset.blob_key);
  })
  .delete("/api/dashboard/assets/:id", async ({ request, params }) => {
    await ownerRequest(request, true);
    const blobKey = await dashboardAssets.delete(z.string().uuid().parse(params.id));
    if (!blobKey) return problem("Published or referenced asset cannot be deleted", 409, "asset_in_use");
    await storage.delete(blobKey);
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
