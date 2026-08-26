import { MCP_SCOPE } from "@context-use/shared";
import { createLocalJWKSet, type JSONWebKeySet, jwtVerify } from "jose";
import { z } from "zod";
import { auth, ensureNangoOAuthClient, touchLiveOwnerSession } from "../auth.ts";
import { ownerUserId } from "../owner.ts";
import type { AuthClientRepository } from "../repositories/auth-client-repository.ts";

const nangoAccessTokenSchema = z
  .object({
    active: z.literal(true),
    azp: z.string(),
    client_id: z.string(),
    iss: z.string(),
    principal_type: z.literal("nango_dashboard_owner"),
    scope: z.string(),
    sid: z.string().min(1).max(512),
    sub: z.string(),
  })
  .passthrough();

const mcpAccessTokenSchema = z
  .object({
    azp: z.string().min(1).max(512),
    client_id: z.string().min(1).max(512),
    principal_type: z.literal("mcp_agent"),
    scope: z.string(),
    sid: z.string().min(1).max(512),
    sub: z.literal(ownerUserId),
  })
  .passthrough();

export type TokenAuthorizationResult =
  | { state: "authorized"; clientId?: string }
  | { state: "unauthorized" }
  | { state: "unavailable" };

export class AuthAuthorizationService {
  constructor(
    private readonly dependencies: {
      clients: Pick<AuthClientRepository, "hasActiveMcpLineage">;
      issuer: string;
      mcpResource: string;
      nangoClientId: string;
      nangoClientSecret: string;
      appOrigin: string;
    },
  ) {}

  async authorizeNango(token: string): Promise<TokenAuthorizationResult> {
    await ensureNangoOAuthClient();
    let value: unknown;
    try {
      const oauthApi = auth.api as unknown as {
        oauth2Introspect(input: {
          asResponse: false;
          headers: Headers;
          request: Request;
          body: { token: string; token_type_hint: string };
        }): Promise<unknown>;
      };
      const headers = new Headers({
        authorization: `Basic ${Buffer.from(
          `${this.dependencies.nangoClientId}:${this.dependencies.nangoClientSecret}`,
        ).toString("base64")}`,
      });
      value = await oauthApi.oauth2Introspect({
        asResponse: false,
        headers,
        request: new Request(`${this.dependencies.appOrigin}/api/auth/oauth2/introspect`, {
          method: "POST",
          headers,
        }),
        body: { token, token_type_hint: "access_token" },
      });
    } catch (error) {
      if (error instanceof Error && error.name === "APIError") {
        const statusCode = Number((error as Error & { statusCode?: unknown }).statusCode);
        return Number.isFinite(statusCode) && statusCode >= 500
          ? { state: "unavailable" }
          : { state: "unauthorized" };
      }
      throw error;
    }

    const introspection = nangoAccessTokenSchema.safeParse(value);
    if (
      !introspection.success ||
      introspection.data.client_id !== this.dependencies.nangoClientId ||
      introspection.data.azp !== this.dependencies.nangoClientId ||
      introspection.data.iss !== this.dependencies.issuer ||
      introspection.data.sub !== ownerUserId ||
      !exactNangoScopes(introspection.data.scope) ||
      !(await touchLiveOwnerSession(introspection.data.sid))
    ) {
      return { state: "unauthorized" };
    }
    return { state: "authorized" };
  }

  async authorizeMcpBearer(token: string): Promise<TokenAuthorizationResult> {
    const access = await this.verifiedMcpAccessToken(token);
    if (
      !access ||
      !(await this.activeMcpLineage({ clientId: access.client_id, sessionId: access.sid }))
    ) {
      return { state: "unauthorized" };
    }
    return { state: "authorized", clientId: access.client_id };
  }

  async authorizeMcpLineage({
    clientId,
    sessionId,
  }: {
    clientId: string;
    sessionId: string;
  }): Promise<TokenAuthorizationResult> {
    return (await this.activeMcpLineage({ clientId, sessionId }))
      ? { state: "authorized" }
      : { state: "unauthorized" };
  }

  private async verifiedMcpAccessToken(token: string) {
    try {
      const jwks = await auth.api.getJwks({ asResponse: false });
      const verified = await jwtVerify(token, createLocalJWKSet(jwks as JSONWebKeySet), {
        issuer: this.dependencies.issuer,
        audience: this.dependencies.mcpResource,
        algorithms: ["EdDSA"],
      });
      const audiences =
        typeof verified.payload.aud === "string" ? [verified.payload.aud] : verified.payload.aud;
      if (audiences?.length !== 1 || audiences[0] !== this.dependencies.mcpResource) {
        return null;
      }
      const parsed = mcpAccessTokenSchema.safeParse(verified.payload);
      if (!parsed.success || parsed.data.azp !== parsed.data.client_id) {
        return null;
      }
      const scopes = parsed.data.scope.split(/\s+/).filter(Boolean);
      return scopes.includes(MCP_SCOPE) ? parsed.data : null;
    } catch {
      return null;
    }
  }

  private async activeMcpLineage({
    clientId,
    sessionId,
  }: {
    clientId: string;
    sessionId: string;
  }): Promise<boolean> {
    return (
      (await this.dependencies.clients.hasActiveMcpLineage({
        clientId,
        ownerUserId,
        sessionId,
        scope: MCP_SCOPE,
        resource: this.dependencies.mcpResource,
      })) && (await touchLiveOwnerSession(sessionId))
    );
  }
}

function exactNangoScopes(scope: string): boolean {
  const scopes = scope.split(" ").filter(Boolean);
  return (
    scopes.length === 2 &&
    new Set(scopes).size === 2 &&
    scopes.includes("openid") &&
    scopes.includes("email")
  );
}
