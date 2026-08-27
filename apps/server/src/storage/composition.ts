import { AssetRepository, BlobMaintenanceRepository, createPool } from "@context-use/database";
import { StoragePublicationRepository } from "@context-use/database/publication";
import { createS3ObjectStorage } from "#storage/repositories/s3-object-storage.ts";
import { reconcileDocumentLinks } from "#storage/services/maintenance-service.ts";
import { createStorageApp } from "./app.ts";
import type { StorageConfig } from "./config.ts";

export function composeStorageApp(config: StorageConfig) {
  const storage = createS3ObjectStorage({
    region: config.AWS_REGION,
    bucket: config.ASSET_BUCKET,
    kmsKeyId: config.KMS_KEY_ID || null,
    ...(config.S3_ENDPOINT ? { endpoint: config.S3_ENDPOINT } : {}),
    forcePathStyle: config.S3_FORCE_PATH_STYLE === "true",
    ...(config.AWS_CREDENTIALS_FILE ? { credentialsFile: config.AWS_CREDENTIALS_FILE } : {}),
  });
  const pool = createPool(config.STORAGE_DATABASE_URL, {
    application_name: "context-use-storage",
  });
  const maintenance = new BlobMaintenanceRepository(pool);
  let maintenanceRunning = false;

  return {
    app: createStorageApp({
      storage,
      privateAssets: new AssetRepository(pool),
      publications: new StoragePublicationRepository(pool),
      tokens: {
        private: config.STORAGE_PRIVATE_TOKEN,
        public: config.STORAGE_PUBLIC_TOKEN,
      },
    }),
    async maintainDocumentObjects(): Promise<void> {
      if (maintenanceRunning) {
        return;
      }
      maintenanceRunning = true;
      try {
        const result = await reconcileDocumentLinks({ storage, maintenance });
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
    },
    async close(): Promise<void> {
      storage.close();
      await pool.end();
    },
  };
}

export type StorageRuntime = ReturnType<typeof composeStorageApp>;
