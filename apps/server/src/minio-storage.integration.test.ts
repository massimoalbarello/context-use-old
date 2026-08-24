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

function zipBytes(): Uint8Array {
  const value = new Uint8Array(128).fill(17);
  const footer = value.byteLength - 22;
  value.set([0x50, 0x4b, 0x05, 0x06], footer);
  value.fill(0, footer + 4);
  return value;
}

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
      await Promise.all(objectKeys.map((key) => storage!.deleteGenerated(key)
        .catch(() => storage!.delete(key))));
      await client!.send(new DeleteBucketCommand({ Bucket: bucket }));
    } finally {
      client!.destroy();
    }
  });

  test("matches the immutable and generated-object semantics used in production", async () => {
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

    const generatedKey = `exports/${randomUUID()}.zip`;
    objectKeys.push(generatedKey);
    const generated = zipBytes();
    const metadata = await storage!.writeGenerated(
      generatedKey,
      new Blob([Buffer.from(generated)]).stream(),
    );
    expect(metadata).toEqual({
      sizeBytes: generated.byteLength,
      contentHash: createHash("sha256").update(generated).digest("hex"),
    });
    expect(await storage!.inspectGenerated(generatedKey)).toEqual(metadata);
  }, 15_000);
});
