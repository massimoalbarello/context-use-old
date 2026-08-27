import { Elysia } from "elysia";
import { z } from "zod";
import { assetContentResponse } from "#http/asset-content.ts";
import { json, problem } from "#http/responses.ts";
import type { AuthorizeOwner } from "#private/auth/dashboard-owner-authorizer.ts";
import type { DashboardAssetsService } from "#private/services/dashboard/assets-service.ts";
import type { PrivateStorageBroker } from "#storage/client/contracts.ts";

export function createAssetController({
  authorizeOwner,
  service,
  storage,
}: {
  authorizeOwner: AuthorizeOwner;
  service: DashboardAssetsService;
  storage: Pick<PrivateStorageBroker, "read">;
}) {
  return new Elysia()
    .put(
      "/api/dashboard/assets/:assetId/content",
      async ({ request, params }) => {
        await authorizeOwner({ request, mode: "upload" });
        const result = await service.upload({
          assetId: z.string().uuid().parse(params.assetId),
          body: request.body,
          suppliedSize: request.headers.get("content-length"),
          suppliedType: request.headers.get("content-type"),
        });
        if (result.state === "not_found") {
          return problem("Asset not found", 404, "not_found");
        }
        if (result.state === "integrity_error") {
          return problem(result.message, 422, "integrity_error");
        }
        return json({ uploaded: true });
      },
      { parse: "none" },
    )
    .get("/api/dashboard/assets/:assetId/status", async ({ request, params }) => {
      await authorizeOwner({ request });
      const status = await service.status(z.string().uuid().parse(params.assetId));
      return status ? json(status) : problem("Asset not found", 404, "not_found");
    })
    .get("/api/dashboard/assets/:assetId/content", async ({ request, params }) => {
      await authorizeOwner({ request });
      const asset = await service.getContent(z.string().uuid().parse(params.assetId));
      if (!asset) {
        return problem("Asset not found", 404, "not_found");
      }
      return assetContentResponse(request, asset, storage, true, asset.blob_key);
    })
    .delete("/api/dashboard/assets/:assetId", async ({ request, params }) => {
      await authorizeOwner({ request, mode: "json" });
      const result = await service.delete(z.string().uuid().parse(params.assetId));
      return result.state === "deleted"
        ? json({ deleted: true })
        : problem("Published or referenced asset cannot be deleted", 409, "asset_in_use");
    });
}
