import {
  oauthProviderAuthServerMetadata,
  oauthProviderOpenIdConfigMetadata,
} from "@better-auth/oauth-provider";
import { Elysia } from "elysia";
import { auth } from "../../../auth.ts";
import { withCodexIssuerCompatibility } from "../../../oauth-metadata.ts";
import { browserAuthRequest } from "../boundary.ts";

const authServerMetadata = oauthProviderAuthServerMetadata(auth as never);
const openIdMetadata = oauthProviderOpenIdConfigMetadata(auth as never);

export const AuthWellKnownController = new Elysia()
  .get("/.well-known/oauth-authorization-server", ({ request }) =>
    withCodexIssuerCompatibility(authServerMetadata(browserAuthRequest({ request }))),
  )
  .get("/.well-known/openid-configuration", ({ request }) =>
    withCodexIssuerCompatibility(openIdMetadata(browserAuthRequest({ request }))),
  );
