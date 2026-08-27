import type { AssetRepository } from "@context-use/database";
import { z } from "zod";
import { requestMatchesOrigin } from "#http/request-origin.ts";
import { verifyAssetCapability } from "#private/services/mcp/asset-capability.ts";
import { AssetIntegrityError, type BlobStorage } from "#storage/object-storage.ts";

export function createMcpAssetUploadHandler({
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
        message: "Asset upload capability is not accepted on this origin",
        status: 401,
        code: "invalid_upload_capability",
      });
    }
    if (request.headers.has("cookie") || request.headers.has("authorization")) {
      return problem({
        message: "Only an MCP-issued asset upload capability is accepted",
        status: 401,
        code: "invalid_upload_capability",
      });
    }
    const capability = verifyAssetCapability(
      request.headers.get("x-context-use-upload-token") ?? "",
      "upload",
      Date.now(),
      capabilitySecret,
    );
    if (!capability || capability.assetId !== assetId) {
      return problem({
        message: "Asset upload capability is invalid or expired",
        status: 401,
        code: "invalid_upload_capability",
      });
    }
    if (
      !(await authorizeLineage({
        clientId: capability.clientId,
        sessionId: capability.sessionId,
      }))
    ) {
      return problem({
        message: "Asset upload authorization is no longer active",
        status: 401,
        code: "invalid_upload_capability",
      });
    }

    const asset = await assets.getForStorage(z.string().uuid().parse(assetId));
    if (!asset) {
      return problem({ message: "Asset not found", status: 404, code: "not_found" });
    }
    const expectedSize = Number(asset.size_bytes);
    const suppliedSize = request.headers.get("content-length");
    if (
      suppliedSize !== null &&
      (!/^\d+$/.test(suppliedSize) || Number(suppliedSize) !== expectedSize)
    ) {
      return problem({ message: "Asset size mismatch", status: 422, code: "integrity_error" });
    }
    if (request.headers.get("content-type")?.toLowerCase() !== asset.content_type.toLowerCase()) {
      return problem({
        message: "Asset content type mismatch",
        status: 422,
        code: "integrity_error",
      });
    }
    if (!request.body && expectedSize !== 0) {
      return problem({ message: "Asset size mismatch", status: 422, code: "integrity_error" });
    }
    try {
      await storage.write(
        {
          id: asset.object_id,
          blobKey: asset.blob_key,
          filename: asset.filename,
          contentType: asset.content_type,
          sizeBytes: expectedSize,
          contentHash: asset.content_hash,
        },
        request.body,
      );
    } catch (error) {
      if (error instanceof AssetIntegrityError) {
        return problem({ message: error.message, status: 422, code: "integrity_error" });
      }
      throw error;
    }
    return Response.json(
      { uploaded: true, object_id: asset.object_id },
      { headers: securityHeaders },
    );
  };
}
