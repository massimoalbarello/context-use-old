import { Elysia } from "elysia";
import { z } from "zod";
import { denied, privateAuthorized } from "#storage/broker-boundary.ts";
import type { StorageRouteContext } from "#storage/broker-contracts.ts";
import { StoragePublicationService } from "#storage/services/publication-service.ts";

export function createPrivatePublicationArtifactController({
  publications,
  storage,
  tokens,
}: StorageRouteContext) {
  return new Elysia().put(
    "/private/publication-artifact",
    async ({ request, query }) => {
      if (!privateAuthorized({ request, tokens }) || !publications) {
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
