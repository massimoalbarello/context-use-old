import { Elysia } from "elysia";
import { z } from "zod";
import { assetContentResponse } from "../../../../../../../asset-content.ts";
import { problem } from "../../../../../../../http.ts";
import { KNOWLEDGE_BUNDLE_CONTENT_TYPE } from "../../../../../../../knowledge-bundle.ts";
import type { DashboardKnowledgeBundleExportsService } from "../../../../../../../services/dashboard-knowledge-bundle-exports-service.ts";
import type { BrokeredStorage } from "../../../../../../../storage-client.ts";
import { disableStreamingRequestIdleTimeout } from "../../../../../../../streaming-timeout.ts";
import type { AuthorizeOwner } from "../../../../../authorization.ts";

export function createKnowledgeBundleDownloadController({
  authorizeOwner,
  service,
  storage,
}: {
  authorizeOwner: AuthorizeOwner;
  service: DashboardKnowledgeBundleExportsService;
  storage: BrokeredStorage;
}) {
  return new Elysia().get(
    "/api/dashboard/knowledge-bundles/:bundleId/download",
    async ({ request, params, server }) => {
      disableStreamingRequestIdleTimeout(server, request);
      const principal = await authorizeOwner({ request, mode: "download" });
      const download = await service.download({
        intentId: z.string().uuid().parse(params.bundleId),
        principal,
      });
      if (download.state === "not_found") {
        return problem("Knowledge bundle export not found", 404, "not_found");
      }
      if (download.state === "passkey_required") {
        return problem("A fresh passkey confirmation is required", 403, "passkey_required");
      }
      return assetContentResponse(
        request,
        {
          filename: download.result.filename,
          content_type: KNOWLEDGE_BUNDLE_CONTENT_TYPE,
          size_bytes: download.result.sizeBytes,
          content_hash: download.result.contentHash,
        },
        storage,
        false,
        download.result.objectKey,
      );
    },
  );
}
