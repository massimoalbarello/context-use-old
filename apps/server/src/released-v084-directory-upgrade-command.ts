import {
  createPool,
  prepareReleasedV084DirectoryUpgrade,
} from "@context-use/database";
import { BrokeredMarkdownObjectStore } from "./markdown-object-store.ts";
import { BrokeredStorage } from "./storage-client.ts";

export async function runReleasedV084DirectoryUpgradeCommand(): Promise<void> {
  const migrationUrl = process.env.MIGRATOR_DATABASE_URL;
  if (!migrationUrl) throw new Error("MIGRATOR_DATABASE_URL is required");
  const parsed = new URL(migrationUrl);
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)
      || decodeURIComponent(parsed.username) !== "postgres") {
    throw new Error("MIGRATOR_DATABASE_URL must use only postgres");
  }
  const production = process.env.NODE_ENV === "production";
  const socketPath = process.env.STORAGE_SOCKET_PATH
    ?? (production ? undefined : "/tmp/context-use-storage.sock");
  const token = process.env.STORAGE_DASHBOARD_TOKEN
    ?? (production ? undefined : "development-storage-dashboard-token");
  if (!socketPath || !token) {
    throw new Error("Released v0.1.84 directory upgrade requires the dashboard storage capability");
  }

  const pool = createPool(migrationUrl, {
    application_name: "context-use-released-v0.1.84-directory-upgrade",
  });
  try {
    const storage = new BrokeredStorage({ socketPath, token });
    const result = await prepareReleasedV084DirectoryUpgrade(
      pool,
      new BrokeredMarkdownObjectStore(storage),
    );
    console.log(JSON.stringify({
      event: result.applicable
        ? "released_v0_1_84_directory_upgrade_completed"
        : "released_v0_1_84_directory_upgrade_not_applicable",
      converted: result.converted,
    }));
  } finally {
    await pool.end();
  }
}

if (import.meta.main) {
  try {
    await runReleasedV084DirectoryUpgradeCommand();
  } catch (error) {
    console.error(JSON.stringify({
      event: "released_v0_1_84_directory_upgrade_failed",
      error_name: error instanceof Error ? error.name : typeof error,
      message: error instanceof Error ? error.message : "Unknown failure",
    }));
    process.exitCode = 1;
  }
}
