import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { DeleteBucketCommand, S3Client } from "@aws-sdk/client-s3";
import {
  BlobAlreadyExistsError,
  S3Storage,
  type StoredBlob,
} from "#storage/repositories/s3-object-storage.ts";
import { ensureObjectStorageBucket } from "./object-storage-init.ts";

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
const blobKeys: string[] = [];

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
      await Promise.all(blobKeys.map((key) => storage!.delete(key)));
      await client!.send(new DeleteBucketCommand({ Bucket: bucket }));
    } finally {
      client!.destroy();
    }
  });

  test("matches the immutable-object semantics used in production", async () => {
    const value = new TextEncoder().encode("MinIO follows the production S3 path.");
    const blobKey = `blobs/${randomUUID()}`;
    blobKeys.push(blobKey);
    const asset: StoredBlob = {
      id: randomUUID(),
      blobKey,
      filename: "minio.txt",
      contentType: "text/plain",
      sizeBytes: value.byteLength,
      contentHash: createHash("sha256").update(value).digest("hex"),
    };

    await storage!.writeOnce(asset, new Blob([value]).stream());
    await expect(storage!.writeOnce(asset, new Blob([value]).stream())).rejects.toBeInstanceOf(
      BlobAlreadyExistsError,
    );
    expect(await storage!.verify(blobKey, asset.sizeBytes, asset.contentHash)).toBe(true);
    expect(await new Response(await storage!.read(blobKey, { start: 0, end: 4 })).text()).toBe(
      "MinIO",
    );
  }, 15_000);
});
