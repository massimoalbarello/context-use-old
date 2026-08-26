import type { KnowledgeBundleRepository } from "@context-use/database";
import type { DashboardPrincipal } from "../auth-client.ts";
import type { issueConfirmationOptions } from "../confirmation-client.ts";
import {
  materializeFullKnowledgeBundle,
  validateFullKnowledgeBundle,
} from "../knowledge-bundle.ts";
import type { BrokeredStorage } from "../storage-client.ts";
import { importPartKey, importStatusUrl } from "./dashboard-knowledge-bundle-paths.ts";

export class DashboardKnowledgeImportsService {
  private readonly preparations = new Set<string>();

  constructor(
    private readonly dependencies: {
      bundles: KnowledgeBundleRepository;
      storage: BrokeredStorage;
      issueConfirmation: typeof issueConfirmationOptions;
    },
  ) {}

  async availability() {
    return { available: await this.dependencies.bundles.acceptsFullImport() };
  }

  async create({
    filename,
    sizeBytes,
    principal,
  }: {
    filename: string;
    sizeBytes: number;
    principal: DashboardPrincipal;
  }) {
    if (!(await this.dependencies.bundles.acceptsFullImport())) {
      return { state: "instance_not_fresh" as const };
    }
    const job = await this.dependencies.bundles.createImport(
      { ownerUserId: principal.userId, sessionId: principal.sessionId },
      { filename, totalBytes: sizeBytes },
    );
    return {
      state: "created" as const,
      import: {
        import_id: job.id,
        part_size: job.part_size,
        total_parts: job.total_parts,
        uploaded_parts: [],
        status_url: importStatusUrl(job.id),
      },
    };
  }

  async uploadPart({
    importId,
    partNumber,
    sizeBytes,
    contentHash,
    body,
    principal,
  }: {
    importId: string;
    partNumber: number;
    sizeBytes: number;
    contentHash: string;
    body: ReadableStream<Uint8Array> | null;
    principal: DashboardPrincipal;
  }) {
    const job = await this.dependencies.bundles.importStatus(importId);
    if (
      !job ||
      job.owner_user_id !== principal.userId ||
      job.session_id !== principal.sessionId ||
      job.status !== "uploading" ||
      partNumber >= job.total_parts
    ) {
      return { state: "not_found" as const };
    }
    const expectedBytes =
      partNumber === job.total_parts - 1
        ? Number(job.total_bytes) - partNumber * job.part_size
        : job.part_size;
    if (sizeBytes !== expectedBytes) {
      return { state: "part_size_mismatch" as const };
    }
    const objectKey = importPartKey({ importId, partNumber });
    await this.dependencies.storage.writeImportPart({
      importId,
      partNumber,
      blobKey: objectKey,
      sizeBytes,
      contentHash,
      body,
    });
    await this.dependencies.bundles.recordImportPart(importId, {
      part_number: partNumber,
      object_key: objectKey,
      size_bytes: sizeBytes,
      content_hash: contentHash,
    });
    return { state: "uploaded" as const };
  }

  async validate({ importId, principal }: { importId: string; principal: DashboardPrincipal }) {
    await this.dependencies.bundles.beginImportValidation(importId, {
      ownerUserId: principal.userId,
      sessionId: principal.sessionId,
    });
    this.startValidation(importId);
    return { status: "validating" as const, status_url: importStatusUrl(importId) };
  }

  async status({ importId, principal }: { importId: string; principal: DashboardPrincipal }) {
    let job = await this.dependencies.bundles.importStatus(importId);
    if (!job || job.owner_user_id !== principal.userId || job.session_id !== principal.sessionId) {
      return null;
    }
    if (job.status === "validating" && !this.preparations.has(importId)) {
      this.startValidation(importId);
    } else if (job.status === "restoring" && !this.preparations.has(importId)) {
      this.startRestore({ importId, principal });
    }
    job = (await this.dependencies.bundles.importStatus(importId)) ?? job;
    const parts =
      job.status === "uploading" ? await this.dependencies.bundles.importParts(importId) : [];
    return {
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
      ...(job.status === "awaiting_confirmation"
        ? {
            authentication_options: await this.dependencies.issueConfirmation(
              "knowledge_import",
              importId,
            ),
          }
        : {}),
      ...(job.status === "failed" ? { code: job.error_code, message: job.error_message } : {}),
    };
  }

  private startValidation(importId: string): void {
    if (this.preparations.has(importId)) {
      return;
    }
    this.preparations.add(importId);
    void (async () => {
      try {
        const parts = await this.dependencies.bundles.importParts(importId);
        await validateFullKnowledgeBundle({
          importId,
          parts,
          repository: this.dependencies.bundles,
          storage: this.dependencies.storage,
        });
      } catch (error) {
        await this.dependencies.bundles
          .failImport(
            importId,
            "bundle_validation_failed",
            error instanceof Error ? error.message : "The knowledge bundle could not be validated.",
          )
          .catch(() => undefined);
        console.error("knowledge_bundle_validation_failed", errorDetails({ id: importId, error }));
      } finally {
        this.preparations.delete(importId);
      }
    })();
  }

  private startRestore({
    importId,
    principal,
  }: {
    importId: string;
    principal: DashboardPrincipal;
  }): void {
    if (this.preparations.has(importId)) {
      return;
    }
    this.preparations.add(importId);
    void (async () => {
      try {
        const parts = await this.dependencies.bundles.importParts(importId);
        await materializeFullKnowledgeBundle({
          importId,
          parts,
          repository: this.dependencies.bundles,
          storage: this.dependencies.storage,
          principal: { ownerUserId: principal.userId, sessionId: principal.sessionId },
        });
        await Promise.allSettled(
          parts.map((part) =>
            this.dependencies.storage.deleteImportPart(
              importPartKey({ importId, partNumber: part.part_number }),
            ),
          ),
        );
      } catch (error) {
        await this.dependencies.bundles
          .failImport(
            importId,
            "bundle_restore_failed",
            error instanceof Error ? error.message : "The knowledge bundle could not be restored.",
          )
          .catch(() => undefined);
        console.error("knowledge_bundle_restore_failed", errorDetails({ id: importId, error }));
      } finally {
        this.preparations.delete(importId);
      }
    })();
  }
}

function errorDetails({ id, error }: { id: string; error: unknown }) {
  return error instanceof Error
    ? { id, name: error.name, message: error.message }
    : { id, type: typeof error };
}
