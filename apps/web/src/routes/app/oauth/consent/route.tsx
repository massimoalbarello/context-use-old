import { createRoute } from "@tanstack/react-router";
import { OAuthConsent } from "../../../../components/OAuthConsent.tsx";
import { appRoute } from "../../route.tsx";

export const oauthConsentRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "oauth/consent",
  component: OAuthConsent,
});
