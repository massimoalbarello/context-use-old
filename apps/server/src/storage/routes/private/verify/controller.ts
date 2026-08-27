import { Elysia } from "elysia";
import { denied, privateAuthorized } from "#storage/broker-boundary.ts";
import type { StorageRouteContext } from "#storage/broker-contracts.ts";
import { verificationSchema } from "#storage/broker-model.ts";

export function createPrivateVerifyController({ storage, tokens }: StorageRouteContext) {
  return new Elysia().post("/private/verify", async ({ request }) => {
    if (!privateAuthorized({ request, tokens })) {
      return denied();
    }
    const input = verificationSchema.parse(await request.json());
    return Response.json(
      { verified: await storage.verify(input.blob_key, input.size_bytes, input.content_hash) },
      { headers: { "cache-control": "no-store" } },
    );
  });
}
