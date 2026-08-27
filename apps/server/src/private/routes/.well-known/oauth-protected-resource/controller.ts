import { MCP_SCOPES } from "@context-use/shared";
import { Elysia } from "elysia";
import { json } from "#http/responses.ts";

export function createProtectedResourceMetadataController({
  authorizationIssuer,
  resource,
}: {
  authorizationIssuer: string;
  resource: string;
}) {
  const metadata = () =>
    json({
      resource,
      authorization_servers: [authorizationIssuer],
      scopes_supported: [...MCP_SCOPES, "offline_access"],
      bearer_methods_supported: ["header"],
      resource_name: "context-use personal knowledge base",
    });
  return new Elysia()
    .get("/.well-known/oauth-protected-resource", metadata)
    .get("/.well-known/oauth-protected-resource/mcp", metadata);
}
