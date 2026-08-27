import { Elysia } from "elysia";
import type { PublicAssetService } from "#public/services/asset-service.ts";
import type { PublicDiscoveryService } from "#public/services/discovery-service.ts";
import type { PublicLandingService } from "#public/services/landing-service.ts";
import type { PublicPageService } from "#public/services/page-service.ts";
import { createPublicAssetController } from "./a/controller.ts";
import { createPublicDiscoveryController } from "./discovery/controller.ts";
import { createPublicHealthController } from "./health/controller.ts";
import { createPublicPageController } from "./p/controller.ts";
import { createPublicLandingController } from "./root/controller.ts";
import { createPublicStylesController } from "./styles/controller.ts";

export function createPublicController({
  assets,
  discovery,
  landing,
  pages,
  securityHeaders,
}: {
  assets: PublicAssetService;
  discovery: PublicDiscoveryService;
  landing: PublicLandingService;
  pages: PublicPageService;
  securityHeaders: Record<string, string>;
}) {
  return new Elysia()
    .use(createPublicHealthController())
    .use(createPublicAssetController(assets))
    .use(createPublicDiscoveryController(discovery))
    .use(createPublicPageController(pages))
    .use(createPublicLandingController(landing))
    .use(createPublicStylesController(securityHeaders));
}
