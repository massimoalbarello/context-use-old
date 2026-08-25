import { createHash, randomUUID } from "node:crypto";
import { DeleteBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ensureObjectStorageBucket } from "./object-storage-init.ts";
import {
  ObjectAlreadyExistsError,
  S3Storage,
  type StoredAsset,
} from "./storage.ts";

const endpoint = process.env.TEST_S3_ENDPOINT;
const describeMinio = endpoint ? describe : describe.skip;
const bucket = `context-use-test-${randomUUID()}`;
const credentials = {
  accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "context-use",
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "test-only-minio-secret",
};
const client = endpoint
  ? new S3Client({
      region: "us-east-1",
      endpoint,
      forcePathStyle: true,
      credentials,
    })
  : null;
const storage = client
  ? new S3Storage(client, { region: "us-east-1", bucket, kmsKeyId: null })
  : null;
const objectKeys: string[] = [];

describeMinio("MinIO S3-compatible object storage", () => {
  beforeAll(async () => {
    await ensureObjectStorageBucket({
      AWS_REGION: "us-east-1",
      AWS_ACCESS_KEY_ID: credentials.accessKeyId,
      AWS_SECRET_ACCESS_KEY: credentials.secretAccessKey,
      ASSET_BUCKET: bucket,
      S3_ENDPOINT: endpoint,
    });
  });

  afterAll(async () => {
    try {
      await Promise.all(objectKeys.map((key) => storage!.deleteBundle(key)
        .catch(() => storage!.delete(key))));
      await client!.send(new DeleteBucketCommand({ Bucket: bucket }));
    } finally {
      client!.destroy();
    }
  });

  test("matches the immutable-object and knowledge-bundle semantics used in production", async () => {
    const value = new TextEncoder().encode("MinIO follows the production S3 path.");
    const objectKey = `objects/${randomUUID()}`;
    objectKeys.push(objectKey);
    const asset: StoredAsset = {
      id: randomUUID(),
      objectKey,
      filename: "minio.txt",
      contentType: "text/plain",
      sizeBytes: value.byteLength,
      contentHash: createHash("sha256").update(value).digest("hex"),
    };

    await storage!.writeOnce(asset, new Blob([value]).stream());
    await expect(storage!.writeOnce(asset, new Blob([value]).stream()))
      .rejects.toBeInstanceOf(ObjectAlreadyExistsError);
    expect(await storage!.verify(objectKey, asset.sizeBytes, asset.contentHash)).toBe(true);
    expect(await new Response(await storage!.read(objectKey, { start: 0, end: 4 })).text())
      .toBe("MinIO");

    const bundleKey = `bundles/${randomUUID()}.cuse`;
    objectKeys.push(bundleKey);
    const bundle = new TextEncoder().encode("CONTEXT-USE-KNOWLEDGE-BUNDLE-V1\ncomplete");
    const metadata = await storage!.writeBundle(
      bundleKey,
      new Blob([Buffer.from(bundle)]).stream(),
    );
    expect(metadata).toEqual({
      sizeBytes: bundle.byteLength,
      contentHash: createHash("sha256").update(bundle).digest("hex"),
    });
    expect(await storage!.inspectBundle(bundleKey)).toEqual(metadata);
  }, 15_000);
});
