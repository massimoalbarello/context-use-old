import { Elysia } from "elysia";
import { z } from "zod";
import {
  mcpClientHeader,
  mcpGatewayHeader,
  mcpSessionHeader,
} from "../../../../auth-mcp-gateway.ts";
import { json, problem } from "../../../../http.ts";
import { hasHeaderCapability } from "../../../../internal-capability.ts";
import { securityHeaders } from "../../../../security.ts";
import type { AuthAuthorizationService } from "../../../../services/auth-authorization-service.ts";
import { bearerAccessToken } from "../../boundary.ts";

const mcpLineageSchema = z
  .object({
    clientId: z.string().min(1).max(512),
    sessionId: z.string().min(1).max(512),
  })
  .strict();

export function createAuthorizeMcpController({
  gatewayToken,
  service,
}: {
  gatewayToken: string;
  service: AuthAuthorizationService;
}) {
  return new Elysia().get("/internal/authorize-mcp", async ({ request }) => {
    if (!hasHeaderCapability(request, mcpGatewayHeader, gatewayToken)) {
      return problem("Not found", 404, "not_found");
    }
    const hasBearer = request.headers.has("authorization");
    const hasLineage =
      request.headers.has(mcpClientHeader) || request.headers.has(mcpSessionHeader);
    if (hasBearer === hasLineage) {
      return problem("Authorization required", 401, "unauthorized");
    }
    if (hasBearer) {
      const token = bearerAccessToken(request);
      if (!token) {
        return problem("Authorization required", 401, "unauthorized");
      }
      const result = await service.authorizeMcpBearer(token);
      return result.state === "authorized"
        ? json({ client_id: result.clientId })
        : problem("Authorization required", 401, "unauthorized");
    }
    const lineage = mcpLineageSchema.safeParse({
      clientId: request.headers.get(mcpClientHeader),
      sessionId: request.headers.get(mcpSessionHeader),
    });
    if (!lineage.success) {
      return problem("Authorization required", 401, "unauthorized");
    }
    const result = await service.authorizeMcpLineage(lineage.data);
    return result.state === "authorized"
      ? new Response(null, { status: 204, headers: securityHeaders })
      : problem("Authorization required", 401, "unauthorized");
  });
}
