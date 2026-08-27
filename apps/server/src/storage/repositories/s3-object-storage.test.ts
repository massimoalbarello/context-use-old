import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  type S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { MemoryBlobStorage } from "#storage/repositories/memory-object-storage.ts";
import {
  AssetIntegrityError,
  BlobAlreadyExistsError,
  credentialsFromFile,
  mayRenderInline,
  S3Storage,
  type StoredBlob,
} from "#storage/repositories/s3-object-storage.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture(bytes: Uint8Array) {
  const asset: StoredBlob = {
    id: "11111111-1111-4111-8111-111111111111",
    blobKey: "objects/11111111-1111-4111-8111-111111111111",
    filename: "document.pdf",
    contentType: "application/pdf",
    sizeBytes: bytes.byteLength,
    contentHash: createHash("sha256").update(bytes).digest("hex"),
  };
  return { asset, storage: new MemoryBlobStorage() };
}

async function storedBytes(storage: MemoryBlobStorage, blobKey: string): Promise<Uint8Array> {
  return new Uint8Array(await new Response(await storage.read(blobKey)).arrayBuffer());
}

class FakeS3Client {
  readonly partLengths: number[] = [];
  readonly uploadedParts = new Map<number, Uint8Array>();
  object: Uint8Array | null = null;
  metadata: Record<string, string> | undefined;
  readonly auxiliaryObjects = new Map<string, Uint8Array>();
  aborted = false;
  conditionalPut = false;
  conditionalComplete = false;
  encryption: { algorithm?: string; keyId?: string } | null = null;

  async send(command: unknown): Promise<Record<string, unknown>> {
    if (command instanceof PutObjectCommand) {
      const body = command.input.Body;
      const bytes = typeof body === "string" ? Buffer.from(body) : body;
      if (!(bytes instanceof Uint8Array)) {
        throw new Error("PutObject body was not buffered bytes");
      }
      if (command.input.Key?.endsWith(".json")) {
        this.auxiliaryObjects.set(command.input.Key, new Uint8Array(bytes));
        return {};
      }
      this.conditionalPut = command.input.IfNoneMatch === "*";
      this.encryption = {
        ...(command.input.ServerSideEncryption
          ? { algorithm: command.input.ServerSideEncryption }
          : {}),
        ...(command.input.SSEKMSKeyId ? { keyId: command.input.SSEKMSKeyId } : {}),
      };
      if (this.conditionalPut && this.object) {
        throw Object.assign(new Error("already exists"), { name: "PreconditionFailed" });
      }
      this.object = new Uint8Array(bytes);
      this.metadata = command.input.Metadata;
      return {};
    }
    if (command instanceof CreateMultipartUploadCommand) {
      this.metadata = command.input.Metadata;
      this.encryption = {
        ...(command.input.ServerSideEncryption
          ? { algorithm: command.input.ServerSideEncryption }
          : {}),
        ...(command.input.SSEKMSKeyId ? { keyId: command.input.SSEKMSKeyId } : {}),
      };
      return { UploadId: "test-upload" };
    }
    if (command instanceof UploadPartCommand) {
      const body = command.input.Body;
      if (!(body instanceof Uint8Array)) {
        throw new Error("UploadPart body was not buffered bytes");
      }
      this.partLengths.push(body.byteLength);
      this.uploadedParts.set(command.input.PartNumber!, new Uint8Array(body));
      return { ETag: `etag-${command.input.PartNumber}` };
    }
    if (command instanceof CompleteMultipartUploadCommand) {
      this.conditionalComplete = command.input.IfNoneMatch === "*";
      if (this.conditionalComplete && this.object) {
        throw Object.assign(new Error("already exists"), { name: "PreconditionFailed" });
      }
      this.object = Buffer.concat(
        [...this.uploadedParts.entries()]
          .sort(([left], [right]) => left - right)
          .map(([, bytes]) => bytes),
      );
      return {};
    }
    if (command instanceof AbortMultipartUploadCommand) {
      this.aborted = true;
      this.uploadedParts.clear();
      return {};
    }
    if (command instanceof HeadObjectCommand) {
      return {
        ContentLength: this.object?.byteLength,
        Metadata: this.metadata,
      };
    }
    if (command instanceof GetObjectCommand) {
      const auxiliary = this.auxiliaryObjects.get(command.input.Key!);
      if (auxiliary) {
        return { Body: { transformToString: async () => Buffer.from(auxiliary).toString() } };
      }
      let bytes = this.object;
      if (!bytes) {
        throw Object.assign(new Error("missing"), { name: "NoSuchKey" });
      }
      const match = command.input.Range?.match(/^bytes=(\d+)-(\d+)$/);
      if (match) {
        bytes = bytes.slice(Number(match[1]), Number(match[2]) + 1);
      }
      return { Body: { transformToByteArray: async () => bytes! } };
    }
    if (command instanceof DeleteObjectCommand) {
      if (command.input.Key?.endsWith(".json")) {
        this.auxiliaryObjects.delete(command.input.Key);
      } else {
        this.object = null;
      }
      return {};
    }
    throw new Error(`Unexpected S3 command: ${String(command)}`);
  }
}

describe("application-routed asset storage", () => {
  test("loads only unexpired scoped process credentials", async () => {
    const root = await mkdtemp(join(tmpdir(), "context-use-credentials-"));
    temporaryDirectories.push(root);
    const path = join(root, "credentials.json");
    await Bun.write(
      path,
      JSON.stringify({
        Version: 1,
        AccessKeyId: "ASIAEXAMPLEACCESSKEY",
        SecretAccessKey: "example-secret-access-key-that-is-long-enough",
        SessionToken: "example-session-token-that-is-long-enough",
        Expiration: new Date(Date.now() + 60_000).toISOString(),
      }),
    );
    expect(await credentialsFromFile(path)()).toMatchObject({
      accessKeyId: "ASIAEXAMPLEACCESSKEY",
      sessionToken: "example-session-token-that-is-long-enough",
    });

    await Bun.write(
      path,
      JSON.stringify({
        Version: 1,
        AccessKeyId: "ASIAEXAMPLEACCESSKEY",
        SecretAccessKey: "example-secret-access-key-that-is-long-enough",
        SessionToken: "example-session-token-that-is-long-enough",
        Expiration: new Date(Date.now() - 1).toISOString(),
      }),
    );
    await expect(credentialsFromFile(path)()).rejects.toThrow("expired");
  });

  test("inlines browser-viewable formats without allowing active images", () => {
    expect(mayRenderInline("image/avif")).toBe(true);
    expect(mayRenderInline("video/quicktime")).toBe(true);
    expect(mayRenderInline("application/pdf")).toBe(true);
    expect(mayRenderInline("text/html")).toBe(true);
    expect(mayRenderInline("image/svg+xml")).toBe(false);
  });

  test("writes verified bytes without buffering them in the route", async () => {
    const bytes = new TextEncoder().encode("a private PDF");
    const { asset, storage } = await fixture(bytes);

    await storage.write(asset, new Blob([bytes]).stream());

    expect(await storedBytes(storage, asset.blobKey)).toEqual(bytes);
    expect(await storage.verify(asset.blobKey, asset.sizeBytes, asset.contentHash)).toBe(true);
  });

  test("rejects checksum mismatches without storing an object", async () => {
    const expected = new TextEncoder().encode("expected bytes");
    const supplied = new TextEncoder().encode("tampered bytes");
    const { asset, storage } = await fixture(expected);

    await expect(storage.write(asset, new Blob([supplied]).stream())).rejects.toBeInstanceOf(
      AssetIntegrityError,
    );
    expect(await storage.exists(asset.blobKey)).toBe(false);
  });

  test("rejects truncated uploads", async () => {
    const expected = new TextEncoder().encode("complete bytes");
    const supplied = expected.slice(0, 4);
    const { asset, storage } = await fixture(expected);

    await expect(storage.write(asset, new Blob([supplied]).stream())).rejects.toBeInstanceOf(
      AssetIntegrityError,
    );
    expect(await storage.exists(asset.blobKey)).toBe(false);
  });

  test("conditionally creates an object without replacing existing bytes", async () => {
    const first = new TextEncoder().encode("first immutable value");
    const second = new TextEncoder().encode("second immutable value");
    const { asset, storage } = await fixture(first);

    await storage.writeOnce(asset, new Blob([first]).stream());
    await expect(
      storage.writeOnce(
        {
          ...asset,
          sizeBytes: second.byteLength,
          contentHash: createHash("sha256").update(second).digest("hex"),
        },
        new Blob([second]).stream(),
      ),
    ).rejects.toBeInstanceOf(BlobAlreadyExistsError);

    expect(await storedBytes(storage, asset.blobKey)).toEqual(first);
  });

  test("uses an S3 conditional request for single-part immutable objects", async () => {
    const bytes = new TextEncoder().encode("conditional S3 body");
    const { asset } = await fixture(bytes);
    const client = new FakeS3Client();
    const storage = new S3Storage(client as unknown as S3Client);

    await storage.writeOnce(asset, new Blob([bytes]).stream());
    expect(client.conditionalPut).toBe(true);
    await expect(storage.writeOnce(asset, new Blob([bytes]).stream())).rejects.toBeInstanceOf(
      BlobAlreadyExistsError,
    );
    expect(client.object).toEqual(bytes);
  });

  test("keeps AWS KMS encryption in production while allowing local MinIO", async () => {
    const bytes = new TextEncoder().encode("encryption boundary");
    const { asset } = await fixture(bytes);
    const awsClient = new FakeS3Client();
    const awsStorage = new S3Storage(awsClient as unknown as S3Client, {
      region: "eu-west-2",
      bucket: "assets",
      kmsKeyId: "arn:aws:kms:eu-west-2:123456789012:key/test",
    });
    await awsStorage.write(asset, new Blob([bytes]).stream());
    expect(awsClient.encryption).toEqual({
      algorithm: "aws:kms",
      keyId: "arn:aws:kms:eu-west-2:123456789012:key/test",
    });

    const minioClient = new FakeS3Client();
    const minioStorage = new S3Storage(minioClient as unknown as S3Client, {
      region: "us-east-1",
      bucket: "assets",
      kmsKeyId: null,
    });
    await minioStorage.write(asset, new Blob([bytes]).stream());
    expect(minioClient.encryption).toEqual({});
  });

  test("uploads large web request streams as bounded S3 multipart bytes", async () => {
    const bytes = new Uint8Array(8 * 1024 * 1024 + 97).fill(42);
    const { asset } = await fixture(bytes);
    const client = new FakeS3Client();
    const storage = new S3Storage(client as unknown as S3Client);

    await storage.write(asset, new Blob([bytes]).stream());

    expect(client.aborted).toBe(false);
    expect(client.partLengths).toEqual([8 * 1024 * 1024, 97]);
    expect(client.object?.byteLength).toBe(bytes.byteLength);
    expect(createHash("sha256").update(client.object!).digest("hex")).toBe(asset.contentHash);
    expect(client.metadata?.sha256).toBe(asset.contentHash);
    expect(await storage.verify(asset.blobKey, asset.sizeBytes, asset.contentHash)).toBe(true);
  });

  test("conditions multipart completion so a competing object cannot be replaced", async () => {
    const bytes = new Uint8Array(8 * 1024 * 1024 + 97).fill(42);
    const competing = new TextEncoder().encode("competing immutable object");
    const { asset } = await fixture(bytes);
    const client = new FakeS3Client();
    const storage = new S3Storage(client as unknown as S3Client);
    client.object = competing;

    await expect(storage.writeOnce(asset, new Blob([bytes]).stream())).rejects.toBeInstanceOf(
      BlobAlreadyExistsError,
    );
    expect(client.conditionalComplete).toBe(true);
    expect(client.object).toEqual(competing);
    expect(client.aborted).toBe(true);
  });

  test("uploads a large inbound Bun HTTP request without bridging it to a Node stream", async () => {
    const bytes = new Uint8Array(8 * 1024 * 1024 + 113).fill(21);
    const { asset } = await fixture(bytes);
    const client = new FakeS3Client();
    const storage = new S3Storage(client as unknown as S3Client);
    const server = Bun.serve({
      port: 0,
      maxRequestBodySize: 5_100_000_000,
      async fetch(request) {
        await storage.write(asset, request.body);
        return Response.json({ uploaded: true });
      },
    });

    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/upload`, {
        method: "PUT",
        body: new Blob([bytes]),
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ uploaded: true });
      expect(client.partLengths).toEqual([8 * 1024 * 1024, 113]);
      expect(createHash("sha256").update(client.object!).digest("hex")).toBe(asset.contentHash);
    } finally {
      server.stop(true);
    }
  });

  test("aborts multipart uploads before completion when integrity fails", async () => {
    const expected = new Uint8Array(8 * 1024 * 1024 + 1).fill(7);
    const supplied = new Uint8Array(expected.byteLength).fill(8);
    const { asset } = await fixture(expected);
    const client = new FakeS3Client();
    const storage = new S3Storage(client as unknown as S3Client);

    await expect(storage.write(asset, new Blob([supplied]).stream())).rejects.toBeInstanceOf(
      AssetIntegrityError,
    );

    expect(client.aborted).toBe(true);
    expect(client.object).toBeNull();
  });
});
