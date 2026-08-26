import { Elysia } from "elysia";
import type { PublicWebService } from "../../services/public-web-service.ts";
import { createPublicAssetController } from "./a/controller.ts";
import { createPublicDiscoveryController } from "./discovery/controller.ts";
import { createPublicHealthController } from "./health/controller.ts";
import { createPublicPageController } from "./p/controller.ts";
import { createPublicLandingController } from "./root/controller.ts";
import { createPublicStylesController } from "./styles/controller.ts";

export function createPublicController(service: PublicWebService) {
  return new Elysia()
    .use(createPublicHealthController(service))
    .use(createPublicAssetController(service))
    .use(createPublicDiscoveryController(service))
    .use(createPublicPageController(service))
    .use(createPublicLandingController(service))
    .use(createPublicStylesController(service));
}
