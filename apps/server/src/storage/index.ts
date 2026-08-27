import { chmod, unlink } from "node:fs/promises";
import { disableStreamingRequestIdleTimeout } from "#http/streaming-timeout.ts";
import { composeStorageApp } from "./composition.ts";
import { loadStorageConfig } from "./config.ts";

const config = loadStorageConfig(process.env);
const runtime = composeStorageApp(config);

await unlink(config.STORAGE_SOCKET_PATH).catch(() => undefined);
Bun.serve({
  unix: config.STORAGE_SOCKET_PATH,
  maxRequestBodySize: 5_500_000_000,
  // biome-ignore lint/complexity/useMaxParams: Bun's server callback signature is framework-owned.
  fetch(request, server) {
    if (
      ["GET", "PUT"].includes(request.method) &&
      ["/private/blob", "/private/markdown-blob", "/private/publication-artifact"].includes(
        new URL(request.url).pathname,
      )
    ) {
      disableStreamingRequestIdleTimeout(server, request);
    }
    return runtime.app.handle(request);
  },
});
await chmod(config.STORAGE_SOCKET_PATH, 0o660);
console.info("context-use storage broker listening on unix socket");

const maintain = () => {
  void runtime.maintainDocumentObjects().catch((error: unknown) => {
    console.error(
      "blob_maintenance_failed",
      error instanceof Error
        ? { name: error.name, message: error.message }
        : { type: typeof error },
    );
  });
};
maintain();
setInterval(maintain, 1_000).unref();
