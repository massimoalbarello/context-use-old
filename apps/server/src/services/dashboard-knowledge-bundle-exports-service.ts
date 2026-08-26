import type { KnowledgeBundleRepository } from "@context-use/database";
import type { DashboardPrincipal } from "../auth-client.ts";
import type {
  claimConfirmedBundleExport,
  issueConfirmationOptions,
} from "../confirmation-client.ts";
import { streamFullKnowledgeBundle } from "../knowledge-bundle.ts";
import type { BrokeredStorage } from "../storage-client.ts";
import {
  bundleFilename,
  exportDownloadUrl,
  exportStatusUrl,
  stagedBundleKey,
} from "./dashboard-knowledge-bundle-paths.ts";

type ExportAccessResult<Result> =
  | { state: "found"; result: Result }
  | { state: "not_found" }
  | { state: "passkey_required" };

export class DashboardKnowledgeBundleExportsService {
  private readonly preparations = new Set<string>();

  constructor(
    private readonly dependencies: {
      bundles: KnowledgeBundleRepository;
      storage: BrokeredStorage;
      issueConfirmation: typeof issueConfirmationOptions;
      claimConfirmedExport: typeof claimConfirmedBundleExport;
    },
  ) {}

  async create(principal: DashboardPrincipal) {
    const exportPrincipal = { ownerUserId: principal.userId, sessionId: principal.sessionId };
    const intent = await this.dependencies.bundles.createExportIntent(exportPrincipal);
    await Promise.allSettled(
      intent.discarded_export_ids.map((intentId) =>
        this.dependencies.storage.deleteBundle(stagedBundleKey(intentId)),
      ),
    );
    try {
      const authenticationOptions = await this.dependencies.issueConfirmation(
        "knowledge_export",
        intent.id,
      );
      return {
        intent: { id: intent.id, expires_at: intent.expires_at },
        summary: {
          page_count: intent.page_count,
          asset_count: intent.asset_count,
          estimated_bytes: intent.estimated_bytes,
        },
        authentication_options: authenticationOptions,
        status_url: exportStatusUrl(intent.id),
      };
    } catch (error) {
      await this.dependencies.bundles.discardExportIntent(intent.id, exportPrincipal);
      throw error;
    }
  }

  async status({
    intentId,
    principal,
  }: {
    intentId: string;
    principal: DashboardPrincipal;
  }): Promise<
    ExportAccessResult<{ body: NonNullable<ReturnType<typeof bundleStatusBody>>; ready: boolean }>
  > {
    const access = await this.access({ intentId, principal });
    if (access.state !== "found") {
      return access;
    }
    let status = await this.dependencies.bundles.exportStatus(intentId);
    if (!status) {
      return { state: "not_found" };
    }
    if (
      ["pending", "snapshotting", "processing"].includes(status.status) &&
      !this.preparations.has(intentId)
    ) {
      const staged = await this.dependencies.storage.inspectBundle(stagedBundleKey(intentId));
      if (staged) {
        await this.dependencies.bundles.completeExport(
          intentId,
          staged.sizeBytes,
          staged.contentHash,
        );
        status = await this.dependencies.bundles.exportStatus(intentId);
      } else {
        this.start({ intentId, principal });
      }
    }
    const body = bundleStatusBody(status);
    return body
      ? { state: "found", result: { body, ready: status?.status === "ready" } }
      : { state: "not_found" };
  }

  async download({
    intentId,
    principal,
  }: {
    intentId: string;
    principal: DashboardPrincipal;
  }): Promise<
    ExportAccessResult<{
      filename: string;
      sizeBytes: number;
      contentHash: string;
      objectKey: string;
    }>
  > {
    const access = await this.access({ intentId, principal });
    if (access.state !== "found") {
      return access;
    }
    const status = await this.dependencies.bundles.exportStatus(intentId);
    if (status?.status !== "ready" || !status.bundle_sha256) {
      return { state: "not_found" };
    }
    await this.dependencies.claimConfirmedExport(intentId, principal);
    return {
      state: "found",
      result: {
        filename: bundleFilename(),
        sizeBytes: Number(status.bundle_size_bytes),
        contentHash: status.bundle_sha256,
        objectKey: stagedBundleKey(intentId),
      },
    };
  }

  private async access({
    intentId,
    principal,
  }: {
    intentId: string;
    principal: DashboardPrincipal;
  }): Promise<ExportAccessResult<true>> {
    const intent = await this.dependencies.bundles.exportIntent(intentId);
    if (
      !intent ||
      intent.owner_user_id !== principal.userId ||
      intent.session_id !== principal.sessionId
    ) {
      return { state: "not_found" };
    }
    if (!intent.confirmed_at || new Date(intent.expires_at).getTime() <= Date.now()) {
      return { state: "passkey_required" };
    }
    return { state: "found", result: true };
  }

  private start({
    intentId,
    principal,
  }: {
    intentId: string;
    principal: DashboardPrincipal;
  }): void {
    if (this.preparations.has(intentId)) {
      return;
    }
    this.preparations.add(intentId);
    void (async () => {
      try {
        await this.dependencies.claimConfirmedExport(intentId, principal);
        await this.dependencies.bundles.captureExport(intentId, {
          ownerUserId: principal.userId,
          sessionId: principal.sessionId,
        });
        const metadata = await this.dependencies.storage.writeBundle(
          stagedBundleKey(intentId),
          streamFullKnowledgeBundle({
            intentId,
            repository: this.dependencies.bundles,
            storage: this.dependencies.storage,
          }),
        );
        await this.dependencies.bundles.completeExport(
          intentId,
          metadata.sizeBytes,
          metadata.contentHash,
        );
      } catch (error) {
        await this.dependencies.bundles
          .failExport(
            intentId,
            "bundle_export_failed",
            "The full knowledge bundle could not be prepared. Start a new export and try again.",
          )
          .catch(() => undefined);
        console.error("knowledge_bundle_export_failed", errorDetails({ id: intentId, error }));
      } finally {
        this.preparations.delete(intentId);
      }
    })();
  }
}

function bundleStatusBody(status: Awaited<ReturnType<KnowledgeBundleRepository["exportStatus"]>>) {
  if (!status) {
    return null;
  }
  return {
    status: status.status,
    phase: status.phase,
    records_completed: Number(status.records_completed),
    records_total: Number(status.records_total),
    blobs_completed: Number(status.objects_completed),
    blobs_total: Number(status.objects_total),
    bytes_completed: Number(status.bytes_completed),
    bytes_total: Number(status.bytes_total),
    ...(status.status === "ready"
      ? {
          download_url: exportDownloadUrl(status.intent_id),
          filename: bundleFilename(),
          size_bytes: Number(status.bundle_size_bytes),
        }
      : {}),
    ...(status.status === "failed"
      ? { code: status.error_code, message: status.error_message }
      : {}),
  };
}

function errorDetails({ id, error }: { id: string; error: unknown }) {
  return error instanceof Error
    ? { id, name: error.name, message: error.message }
    : { id, type: typeof error };
}
