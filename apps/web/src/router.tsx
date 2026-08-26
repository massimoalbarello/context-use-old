import { createRouter } from "@tanstack/react-router";
import { legacyAssetRoute } from "./routes/app/assets/$objectId/route.tsx";
import { automationsRoute } from "./routes/app/automations/route.tsx";
import { historyRoute } from "./routes/app/history/route.tsx";
import { appIndexRoute } from "./routes/app/index.tsx";
import { legacyMcpRoute } from "./routes/app/mcp/route.tsx";
import { oauthConsentRoute } from "./routes/app/oauth/consent/route.tsx";
import { objectRoute } from "./routes/app/objects/$objectId/route.tsx";
import { newObjectRoute } from "./routes/app/objects/new/route.tsx";
import { legacyPageRoute } from "./routes/app/pages/$objectId/route.tsx";
import { legacyRecordRoute } from "./routes/app/records/$objectId/route.tsx";
import { appRoute } from "./routes/app/route.tsx";
import { settingsRoute } from "./routes/app/settings/route.tsx";
import { rootRoute } from "./routes/root.tsx";

const appRouteTree = appRoute.addChildren([
  appIndexRoute,
  settingsRoute,
  automationsRoute,
  historyRoute,
  oauthConsentRoute,
  newObjectRoute,
  objectRoute,
  legacyMcpRoute,
  legacyPageRoute,
  legacyAssetRoute,
  legacyRecordRoute,
]);

export const router = createRouter({ routeTree: rootRoute.addChildren([appRouteTree]) });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
