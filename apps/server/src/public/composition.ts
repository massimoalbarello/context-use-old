import { createPool } from "@context-use/database";
import { PublicRepository } from "@context-use/database/publication";
import { createSecurityHeaders } from "#http/security-headers.ts";
import { createMarkdownRenderer } from "#markdown/renderer.ts";
import { createPublicStorageBroker } from "#storage/client/storage-broker-client.ts";
import { createPublicApp } from "./app.ts";
import type { PublicConfig } from "./config.ts";
import { createPublicController } from "./routes/controller.ts";
import { PublicAssetService } from "./services/asset-service.ts";
import { PublicDiscoveryService } from "./services/discovery-service.ts";
import { PublicLandingService } from "./services/landing-service.ts";
import { PublicPageService } from "./services/page-service.ts";

export function composePublicApp(config: PublicConfig) {
  const pool = createPool(config.PUBLIC_DATABASE_URL, {
    application_name: "context-use-public",
  });
  const securityHeaders = createSecurityHeaders(config.ASSET_ORIGIN);
  const publicData = new PublicRepository(pool);
  const storage = createPublicStorageBroker({
    socketPath: config.STORAGE_SOCKET_PATH,
    token: config.STORAGE_PUBLIC_TOKEN,
  });
  const shared = {
    siteOrigin: config.APP_ORIGIN,
    assetOrigin: config.ASSET_ORIGIN,
    securityHeaders,
  };
  return {
    app: createPublicApp({
      routes: createPublicController({
        assets: new PublicAssetService({
          routes: publicData,
          storage,
          assetOrigin: config.ASSET_ORIGIN,
          securityHeaders,
        }),
        discovery: new PublicDiscoveryService({
          pages: publicData,
          storage,
          ...shared,
        }),
        landing: new PublicLandingService({
          entrypoint: publicData,
          storage,
          siteOrigin: config.APP_ORIGIN,
          securityHeaders,
        }),
        pages: new PublicPageService({
          routes: publicData,
          storage,
          markdown: createMarkdownRenderer({
            appOrigin: config.APP_ORIGIN,
            assetOrigin: config.ASSET_ORIGIN,
          }),
          ...shared,
        }),
        securityHeaders,
      }),
      securityHeaders,
    }),
    close: () => pool.end(),
  };
}

export type PublicRuntime = ReturnType<typeof composePublicApp>;
