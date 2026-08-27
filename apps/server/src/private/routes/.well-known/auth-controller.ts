import {
  oauthProviderAuthServerMetadata,
  oauthProviderOpenIdConfigMetadata,
} from "@better-auth/oauth-provider";
import { Elysia } from "elysia";
import type { AuthEngine } from "#private/auth/auth-engine.ts";
import { withCodexIssuerCompatibility } from "#private/auth/oauth-metadata.ts";
import { browserAuthRequest } from "#private/auth/owner-authorizer.ts";

export function createAuthWellKnownController({ auth }: Pick<AuthEngine, "auth">) {
  const authServerMetadata = oauthProviderAuthServerMetadata(auth as never);
  const openIdMetadata = oauthProviderOpenIdConfigMetadata(auth as never);
  return new Elysia()
    .get("/.well-known/oauth-authorization-server", ({ request }) =>
      withCodexIssuerCompatibility(authServerMetadata(browserAuthRequest({ request }))),
    )
    .get("/.well-known/openid-configuration", ({ request }) =>
      withCodexIssuerCompatibility(openIdMetadata(browserAuthRequest({ request }))),
    );
}
