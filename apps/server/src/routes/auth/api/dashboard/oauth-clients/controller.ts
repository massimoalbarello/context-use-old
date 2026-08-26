import { Elysia } from "elysia";
import { z } from "zod";
import { json, problem } from "../../../../../http.ts";
import type { AuthClientRepository } from "../../../../../repositories/auth-client-repository.ts";
import { SecurityError } from "../../../../../security.ts";
import type { AuthorizeAuthOwner } from "../../../boundary.ts";

const clientPageNumber = z.coerce.number().int().min(1).default(1);
const clientPageSize = z.coerce.number().int().min(1).max(50).default(10);
const clientIdSchema = z.string().min(1).max(512);

export function createDashboardOAuthClientsController({
  authorizeOwner,
  clients,
}: {
  authorizeOwner: AuthorizeAuthOwner;
  clients: Pick<AuthClientRepository, "connectedClients" | "clientPreview" | "revokeClient">;
}) {
  return new Elysia()
    .get("/api/dashboard/private-mcp-clients", async ({ request, query }) => {
      const principal = await authorizeOwner({ request });
      return json(
        await clients.connectedClients({
          ownerUserId: principal.userId,
          page: clientPageNumber.parse(query.page),
          pageSize: clientPageSize.parse(query.page_size),
        }),
      );
    })
    .get("/api/dashboard/oauth-client-preview", async ({ request, query }) => {
      await authorizeOwner({ request });
      const preview = await clients.clientPreview(clientIdSchema.parse(query.client_id));
      return preview ? json(preview) : problem("OAuth client not found", 404, "not_found");
    })
    .delete("/api/dashboard/oauth-clients/:clientId", async ({ request, params }) => {
      const principal = await authorizeOwner({ request, mutation: true });
      const revoked = await clients.revokeClient({
        clientId: clientIdSchema.parse(params.clientId),
        ownerUserId: principal.userId,
      });
      if (!revoked) {
        throw new SecurityError("Connected client not found", 404);
      }
      return json({ revoked: true });
    });
}
