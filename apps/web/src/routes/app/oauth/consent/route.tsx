import { createRoute } from "@tanstack/react-router";
import { appRoute } from "../../route.tsx";

export const oauthConsentRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "oauth/consent",
});
