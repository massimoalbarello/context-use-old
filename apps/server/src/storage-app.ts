import { chmod, unlink } from "node:fs/promises";
import {
  AssetRepository,
  BlobMaintenanceRepository,
  createPool,
} from "@context-use/database";
import { StoragePublicationRepository } from "@context-use/database/publication";
import { config } from "./config.ts";
import { createStorageBrokerApp } from "./routes/storage/controller.ts";
import { reconcileDocumentLinks } from "./services/storage-maintenance-service.ts";
import { S3Storage } from "./storage.ts";
import { disableStreamingRequestIdleTimeout } from "./streaming-timeout.ts";

export { createStorageBrokerApp } from "./routes/storage/controller.ts";
export { reconcileDocumentLinks } from "./services/storage-maintenance-service.ts";
export { materializePublicationArtifact } from "./services/storage-publication-service.ts";

const storage = new S3Storage(undefined, {
  region: config.AWS_REGION,
  bucket: config.ASSET_BUCKET,
  kmsKeyId: config.KMS_KEY_ID || null,
});
const pool = createPool(config.STORAGE_DATABASE_URL, {
  application_name: "context-use-storage-boundary",
});
const privateAssets = new AssetRepository(pool);
const publications = new StoragePublicationRepository(pool);
const blobMaintenance = new BlobMaintenanceRepository(pool);

export const storageApp = createStorageBrokerApp({
  storage,
  privateAssets,
  publications,
  tokens: {
    dashboard: config.STORAGE_DASHBOARD_TOKEN,
    mcp: config.STORAGE_MCP_TOKEN,
    public: config.STORAGE_PUBLIC_TOKEN,
  },
});

let maintenanceRunning = false;

export async function maintainDocumentObjects(): Promise<void> {
  if (maintenanceRunning) {
    return;
  }
  maintenanceRunning = true;
  try {
    const result = await reconcileDocumentLinks({ storage, maintenance: blobMaintenance });
    for (const failure of result.failures) {
      console.error("object_link_index_failed", {
        revisionId: failure.revisionId,
        ...(failure.error instanceof Error
          ? { name: failure.error.name, message: failure.error.message }
          : { type: typeof failure.error }),
      });
    }
  } finally {
    maintenanceRunning = false;
  }
}

export async function listenStorageSocket(): Promise<void> {
  const socketPath = config.STORAGE_SOCKET_PATH;
  await unlink(socketPath).catch(() => undefined);
  Bun.serve({
    unix: socketPath,
    maxRequestBodySize: 5_500_000_000,
    fetch(request, server) {
      if (
        ["GET", "PUT"].includes(request.method) &&
        [
          "/private/blob",
          "/private/markdown-blob",
          "/private/publication-artifact",
        ].includes(new URL(request.url).pathname)
      ) {
        disableStreamingRequestIdleTimeout(server, request);
      }
      return storageApp.handle(request);
    },
  });
  await chmod(socketPath, 0o660);
  console.info("context-use storage broker listening on unix socket");
  void runMaintenance();
  setInterval(runMaintenance, 1_000).unref();
}

function runMaintenance(): void {
  void maintainDocumentObjects().catch((error: unknown) => {
    console.error(
      "blob_maintenance_failed",
      error instanceof Error
        ? { name: error.name, message: error.message }
        : { type: typeof error },
    );
  });
}
