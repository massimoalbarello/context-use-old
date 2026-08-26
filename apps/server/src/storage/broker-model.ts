import { z } from "zod";

export const blobKeySchema = z.string().regex(/^blobs\/[a-f0-9-]{36}$/);
const legacyAssetKeySchema = z.string().regex(/^objects\/[a-f0-9-]{36}$/);
const legacyPrivatePageKeySchema = z.string().regex(/^documents\/private\/[a-f0-9-]{36}\.md$/);
export const privateBlobKeySchema = z.union([
  blobKeySchema,
  legacyAssetKeySchema,
  legacyPrivatePageKeySchema,
]);
export const assetBlobKeySchema = z.union([blobKeySchema, legacyAssetKeySchema]);
export const pageBlobKeySchema = z.union([blobKeySchema, legacyPrivatePageKeySchema]);
export const publicPageKeySchema = z.string().regex(/^documents\/public\/[a-f0-9-]{36}\.md$/);
export const publicAssetArtifactKeySchema = z.string().regex(/^artifacts\/public\/[a-f0-9-]{36}$/);
export const bundleObjectKeySchema = z.string().regex(/^bundles\/[a-f0-9-]{36}\.cuse$/);
export const importPartKeySchema = z.string().regex(/^imports\/[a-f0-9-]{36}\/parts\/[0-9]{1,6}$/);
export const importedObjectKeySchema = z.union([
  privateBlobKeySchema,
  publicPageKeySchema,
  publicAssetArtifactKeySchema,
]);

export const verificationSchema = z
  .object({
    // Public projection artifacts are verify-only through this privileged
    // integrity endpoint. This does not expose their read routes.
    blob_key: z.union([privateBlobKeySchema, publicPageKeySchema, publicAssetArtifactKeySchema]),
    size_bytes: z.number().int().nonnegative().max(5_000_000_000),
    content_hash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export function filenameHeader(request: Request): string {
  const encoded = z.string().min(1).max(16_000).parse(request.headers.get("x-filename"));
  return z.string().min(1).max(1_024).parse(decodeURIComponent(encoded));
}
