import { MCP_SCOPES } from "@context-use/shared";
import { Elysia } from "elysia";
import { json } from "../../http.ts";

type McpHandler = (request: Request) => Promise<Response> | Response;
type AssetHandler = (input: { request: Request; assetId: string }) => Promise<Response> | Response;

export function createMcpController({
  authorizationIssuer,
  download,
  handleMcp,
  resource,
  upload,
}: {
  authorizationIssuer: string;
  download: AssetHandler;
  handleMcp: McpHandler;
  resource: string;
  upload: AssetHandler;
}) {
  const protectedResourceMetadata = () =>
    json({
      resource,
      authorization_servers: [authorizationIssuer],
      // Long-lived MCP clients need refresh tokens, so discovery includes offline_access.
      scopes_supported: [...MCP_SCOPES, "offline_access"],
      bearer_methods_supported: ["header"],
      resource_name: "context-use personal knowledge base",
    });
  return new Elysia()
    .get("/health", () => json({ status: "ok", service: "private-mcp" }))
    .get("/.well-known/oauth-protected-resource", protectedResourceMetadata)
    .get("/.well-known/oauth-protected-resource/mcp", protectedResourceMetadata)
    .get("/mcp", ({ request }) => handleMcp(request))
    .post("/mcp", ({ request }) => handleMcp(request))
    .delete("/mcp", ({ request }) => handleMcp(request))
    .put(
      "/api/mcp/assets/:assetId/content",
      ({ request, params }) => upload({ request, assetId: params.assetId }),
      { parse: "none" },
    )
    .get("/api/mcp/assets/:assetId/content", ({ request, params }) =>
      download({ request, assetId: params.assetId }),
    );
}
