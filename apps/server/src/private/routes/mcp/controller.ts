import { Elysia } from "elysia";
import { requestMatchesOrigin } from "#http/request-origin.ts";
import type { AuthAuthorizationService } from "#private/services/auth/authorization-service.ts";
import type { McpContext } from "#private/services/mcp/server.ts";
import { createProtectedResourceMetadataController } from "../.well-known/oauth-protected-resource/controller.ts";
import { createMcpAssetContentController } from "../api/mcp/assets/[assetId]/content/controller.ts";

type McpHandler = (input: {
  request: Request;
  context: McpContext;
}) => Promise<Response> | Response;
type AssetHandler = (input: { request: Request; assetId: string }) => Promise<Response> | Response;

export function createMcpController({
  authorizationIssuer,
  authorization,
  appOrigin,
  download,
  handleMcp,
  resource,
  upload,
}: {
  authorizationIssuer: string;
  authorization: Pick<AuthAuthorizationService, "authorizeMcpBearer">;
  appOrigin: string;
  download: AssetHandler;
  handleMcp: McpHandler;
  resource: string;
  upload: AssetHandler;
}) {
  const protectedMcp = async (request: Request) => {
    if (!requestMatchesOrigin({ request, expectedOrigin: appOrigin })) {
      return new Response("Not found", {
        status: 404,
        headers: { "cache-control": "no-store" },
      });
    }
    if (request.headers.has("cookie")) {
      return unauthorized({ message: "Cookie credentials are not accepted by MCP", appOrigin });
    }
    const token = request.headers.get("authorization")?.match(/^Bearer ([A-Za-z0-9._~-]+)$/)?.[1];
    if (!token) {
      return unauthorized({ message: "Bearer authorization is required", appOrigin });
    }
    const result = await authorization.authorizeMcpBearer(token);
    if (
      result.state !== "authorized" ||
      result.clientId === undefined ||
      result.sessionId === undefined
    ) {
      return unauthorized({
        message: "Bearer token is revoked or its owner session is inactive",
        appOrigin,
      });
    }
    return handleMcp({
      request,
      context: { clientId: result.clientId, sessionId: result.sessionId },
    });
  };

  return new Elysia()
    .use(createProtectedResourceMetadataController({ authorizationIssuer, resource }))
    .get("/mcp", ({ request }) => protectedMcp(request))
    .post("/mcp", ({ request }) => protectedMcp(request))
    .delete("/mcp", ({ request }) => protectedMcp(request))
    .use(createMcpAssetContentController({ download, upload }));
}

function unauthorized({ message, appOrigin }: { message: string; appOrigin: string }): Response {
  return new Response(message, {
    status: 401,
    headers: {
      "cache-control": "no-store",
      "www-authenticate": `Bearer resource_metadata="${appOrigin}/.well-known/oauth-protected-resource/mcp"`,
    },
  });
}
