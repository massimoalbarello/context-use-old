import type { AssetRepository } from "@context-use/database";
import { z } from "zod";
import { assetContentResponse } from "#http/asset-content.ts";
import { requestMatchesOrigin } from "#http/request-origin.ts";
import { verifyAssetCapability } from "#private/services/mcp/asset-capability.ts";
import type { BlobStorage } from "#storage/object-storage.ts";

export function createMcpAssetDownloadHandler({
  assets,
  storage,
  appOrigin,
  capabilitySecret,
  authorizeLineage,
  securityHeaders,
}: {
  assets: AssetRepository;
  storage: BlobStorage;
  appOrigin: string;
  capabilitySecret: string;
  authorizeLineage: (input: { clientId: string; sessionId: string }) => Promise<boolean>;
  securityHeaders: Record<string, string>;
}) {
  const problem = ({
    message,
    status,
    code,
  }: {
    message: string;
    status: number;
    code: string;
  }): Response => Response.json({ error: code, message }, { status, headers: securityHeaders });
  return async ({ request, assetId }: { request: Request; assetId: string }): Promise<Response> => {
    if (!requestMatchesOrigin({ request, expectedOrigin: appOrigin })) {
      return problem({
        message: "Asset download capability is not accepted on this origin",
        status: 401,
        code: "invalid_download_capability",
      });
    }
    if (request.headers.has("cookie") || request.headers.has("authorization")) {
      return problem({
        message: "Only an MCP-issued asset download capability is accepted",
        status: 401,
        code: "invalid_download_capability",
      });
    }
    const capability = verifyAssetCapability(
      request.headers.get("x-context-use-download-token") ?? "",
      "download",
      Date.now(),
      capabilitySecret,
    );
    if (!capability || capability.assetId !== assetId) {
      return problem({
        message: "Asset download capability is invalid or expired",
        status: 401,
        code: "invalid_download_capability",
      });
    }
    if (
      !(await authorizeLineage({
        clientId: capability.clientId,
        sessionId: capability.sessionId,
      }))
    ) {
      return problem({
        message: "Asset download authorization is no longer active",
        status: 401,
        code: "invalid_download_capability",
      });
    }

    const asset = await assets.getForStorage(z.string().uuid().parse(assetId));
    if (!asset) {
      return problem({ message: "Asset not found", status: 404, code: "not_found" });
    }
    return assetContentResponse(request, asset, storage, false, asset.blob_key, securityHeaders);
  };
}
