import { Elysia } from "elysia";
import { json } from "../../../../../http.ts";
import type { AuthClientRepository } from "../../../../../repositories/auth-client-repository.ts";
import type { AuthorizeAuthOwner } from "../../../boundary.ts";

export function createDashboardSessionController({
  authorizeOwner,
  clients,
}: {
  authorizeOwner: AuthorizeAuthOwner;
  clients: Pick<AuthClientRepository, "ownerPasskeys">;
}) {
  return new Elysia().get("/api/dashboard/session", async ({ request }) => {
    const principal = await authorizeOwner({ request });
    const passkeys = await clients.ownerPasskeys(principal.userId);
    return json({
      owner: { id: principal.userId, email: principal.email },
      passkey_count: passkeys.length,
      passkeys: passkeys.map((key) => ({
        id: key.id,
        name: key.name,
        created_at: key.createdAt,
        device_type: key.deviceType,
        backed_up: key.backedUp,
      })),
    });
  });
}
