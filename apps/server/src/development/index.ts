import { chmod, unlink } from "node:fs/promises";
import { disableStreamingRequestIdleTimeout } from "#http/streaming-timeout.ts";
import { composePrivateApp } from "#private/composition.ts";
import { loadPrivateConfig } from "#private/config.ts";
import { composePublicApp } from "#public/composition.ts";
import { loadPublicConfig } from "#public/config.ts";
import { composeStorageApp } from "#storage/composition.ts";
import { loadStorageConfig } from "#storage/config.ts";
import { createDevelopmentApp } from "./app.ts";

if (process.env.NODE_ENV === "production") {
  throw new Error("The combined development application is forbidden in production");
}

const storageConfig = loadStorageConfig(process.env);
const storage = composeStorageApp(storageConfig);
await unlink(storageConfig.STORAGE_SOCKET_PATH).catch(() => undefined);
Bun.serve({
  unix: storageConfig.STORAGE_SOCKET_PATH,
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
    return storage.app.handle(request);
  },
});
await chmod(storageConfig.STORAGE_SOCKET_PATH, 0o660);

const privateConfig = loadPrivateConfig(process.env);
const publicConfig = loadPublicConfig(process.env);
const privateRuntime = composePrivateApp(privateConfig);
const publicRuntime = composePublicApp(publicConfig);
const app = createDevelopmentApp({
  privateApp: privateRuntime.app,
  publicApp: publicRuntime.app,
});

Bun.serve({
  port: privateConfig.PORT,
  maxRequestBodySize: 5_500_000_000,
  fetch: app.handle,
});

console.info(`context-use development application listening on ${privateConfig.PORT}`);
