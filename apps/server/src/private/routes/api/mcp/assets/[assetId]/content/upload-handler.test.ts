import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { AssetRepository } from "@context-use/database";
import { createMcpAssetUploadHandler } from "#private/routes/api/mcp/assets/[assetId]/content/upload-handler.ts";
import {
  createAssetCapability,
  verifyAssetCapability,
} from "#private/services/mcp/asset-capability.ts";
import type { BlobStorage, StoredBlob } from "#storage/object-storage.ts";

const assetId = "11111111-1111-4111-8111-111111111111";
const bytes = new TextEncoder().encode("private asset bytes");
const contentHash = createHash("sha256").update(bytes).digest("hex");
const principal = { clientId: "mcp-client", sessionId: "mcp-session" };
const capabilitySecret = "development-only-mcp-capability-secret";
const responseHeaders = { "cache-control": "no-store" };

function fixture() {
  const asset = {
    object_id: assetId,
    filename: "private.pdf",
    content_type: "application/pdf",
    size_bytes: bytes.byteLength,
    content_hash: contentHash,
    blob_key: `blobs/${assetId}`,
  };
  let written: { asset: StoredBlob; bytes: Uint8Array } | null = null;
  const assets = {
    async getForStorage(id: string) {
      return id === assetId ? asset : null;
    },
  } as unknown as AssetRepository;
  const storage = {
    async write(storedAsset: StoredBlob, body: ReadableStream<Uint8Array> | null) {
      written = {
        asset: storedAsset,
        bytes: new Uint8Array(await new Response(body).arrayBuffer()),
      };
    },
  } as unknown as BlobStorage;
  const handler = createMcpAssetUploadHandler({
    assets,
    storage,
    appOrigin: "http://localhost:3000",
    capabilitySecret,
    authorizeLineage: async () => true,
    securityHeaders: responseHeaders,
  });
  return { handler, written: () => written };
}

function uploadRequest(
  token: string,
  body: Uint8Array = bytes,
  headers: Record<string, string> = {},
) {
  return new Request(`http://localhost:3000/api/mcp/assets/${assetId}/content`, {
    method: "PUT",
    headers: {
      "content-type": "application/pdf",
      "content-length": String(body.byteLength),
      "x-context-use-upload-token": token,
      ...headers,
    },
    body: new Blob([new Uint8Array(body).buffer]),
  });
}

describe("MCP asset upload capabilities", () => {
  test("signs an asset-specific capability with a fixed expiry", () => {
    const now = Date.UTC(2026, 6, 18, 12, 0, 0);
    const created = createAssetCapability("upload", assetId, principal, now);
    expect(created.expiresAt).toBe("2026-07-18T12:15:00.000Z");
    expect(verifyAssetCapability(created.token, "upload", now)).toMatchObject({
      assetId,
      action: "upload",
      ...principal,
    });
    expect(verifyAssetCapability(created.token, "upload", now + 15 * 60 * 1000)).toBeNull();
    expect(verifyAssetCapability(`${created.token}tampered`, "upload", now)).toBeNull();
  });

  test("streams exact bytes for an action- and asset-bound capability", async () => {
    const capability = createAssetCapability("upload", assetId, principal);
    const { handler, written } = fixture();

    const response = await handler({ request: uploadRequest(capability.token), assetId });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ uploaded: true, object_id: assetId });
    expect(written()).toMatchObject({ asset: { id: assetId, contentHash } });
    expect(written()?.bytes).toEqual(bytes);
  });

  test("rejects credentials for another asset and mismatched metadata", async () => {
    const otherAsset = "22222222-2222-4222-8222-222222222222";
    const capability = createAssetCapability("upload", otherAsset, principal);
    expect(
      (await fixture().handler({ request: uploadRequest(capability.token), assetId })).status,
    ).toBe(401);

    const correct = createAssetCapability("upload", assetId, principal);
    expect(
      (
        await fixture().handler({
          request: uploadRequest(correct.token, bytes, { "content-type": "text/plain" }),
          assetId,
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await fixture().handler({
          request: uploadRequest(correct.token, bytes, { "content-length": "1" }),
          assetId,
        })
      ).status,
    ).toBe(422);
  });

  test("does not accept cookies or OAuth bearer credentials on the capability route", async () => {
    const capability = createAssetCapability("upload", assetId, principal);
    expect(
      (
        await fixture().handler({
          request: uploadRequest(capability.token, bytes, { cookie: "session=forged" }),
          assetId,
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await fixture().handler({
          request: uploadRequest(capability.token, bytes, { authorization: "Bearer oauth-token" }),
          assetId,
        })
      ).status,
    ).toBe(401);
  });

  test("does not accept the capability on another origin", async () => {
    const capability = createAssetCapability("upload", assetId, principal);
    const request = new Request(`https://assets.example.com/api/mcp/assets/${assetId}/content`, {
      method: "PUT",
      headers: {
        "content-type": "application/pdf",
        "content-length": String(bytes.byteLength),
        "x-context-use-upload-token": capability.token,
      },
      body: new Blob([bytes.buffer]),
    });
    expect((await fixture().handler({ request, assetId })).status).toBe(401);
  });

  test("rejects a signed capability after its MCP lineage is revoked", async () => {
    const capability = createAssetCapability("upload", assetId, principal);
    const revoked = createMcpAssetUploadHandler({
      assets: {} as AssetRepository,
      storage: {} as BlobStorage,
      appOrigin: "http://localhost:3000",
      capabilitySecret,
      authorizeLineage: async () => false,
      securityHeaders: responseHeaders,
    });

    expect((await revoked({ request: uploadRequest(capability.token), assetId })).status).toBe(401);
  });
});
