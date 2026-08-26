import { Elysia } from "elysia";
import { z } from "zod";
import { StoragePublicationService } from "../../../../services/storage-publication-service.ts";
import { denied, privateCapability } from "../../../../storage/broker-boundary.ts";
import type { StorageRouteContext } from "../../../../storage/broker-contracts.ts";

export function createPrivatePublicationArtifactController({
  publications,
  storage,
  tokens,
}: StorageRouteContext) {
  return new Elysia().put(
    "/private/publication-artifact",
    async ({ request, query }) => {
      if (privateCapability({ request, tokens }) !== "dashboard" || !publications) {
        return denied();
      }
      await new StoragePublicationService({ storage, claims: publications }).materialize(
        z.string().uuid().parse(query.id),
      );
      return new Response(null, { status: 204 });
    },
    { parse: "none" },
  );
}
