import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";

export type StoredAsset = {
  id: string;
  objectKey: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  contentHash: string;
};

export type ByteRange = { start: number; end: number };

export type GeneratedObjectMetadata = {
  sizeBytes: number;
  contentHash: string;
};

export interface ObjectStorage {
  write(asset: StoredAsset, body: ReadableStream<Uint8Array> | null): Promise<void>;
  delete(objectKey: string): Promise<void>;
  read(objectKey: string, range?: ByteRange): Promise<BodyInit>;
  verify(objectKey: string, sizeBytes: number, contentHash: string): Promise<boolean>;
}

export interface ObjectStorageBackend extends ObjectStorage {
  exists(objectKey: string): Promise<boolean>;
  writeOnce(asset: StoredAsset, body: ReadableStream<Uint8Array> | null): Promise<void>;
  writeBundle(objectKey: string, body: ReadableStream<Uint8Array> | null): Promise<GeneratedObjectMetadata>;
  inspectBundle(objectKey: string): Promise<GeneratedObjectMetadata | null>;
  deleteBundle(objectKey: string): Promise<void>;
  writeImportPart(asset: StoredAsset, body: ReadableStream<Uint8Array> | null): Promise<void>;
  inspectImportPart(objectKey: string): Promise<GeneratedObjectMetadata | null>;
  deleteImportPart(objectKey: string): Promise<void>;
}

export type S3StorageConfig = {
  region: string;
  bucket: string;
  kmsKeyId: string | null;
};

type ProcessCredentials = {
  Version?: unknown;
  AccessKeyId?: unknown;
  SecretAccessKey?: unknown;
  SessionToken?: unknown;
  Expiration?: unknown;
};

export function credentialsFromFile(path: string) {
  return async () => {
    const parsed = JSON.parse(await readFile(path, "utf8")) as ProcessCredentials;
    if (parsed.Version !== 1
        || typeof parsed.AccessKeyId !== "string" || parsed.AccessKeyId.length<16
        || typeof parsed.SecretAccessKey !== "string" || parsed.SecretAccessKey.length<32
        || typeof parsed.SessionToken !== "string" || parsed.SessionToken.length<16
        || typeof parsed.Expiration !== "string") {
      throw new Error("Scoped AWS credential file is invalid");
    }
    const expiration = new Date(parsed.Expiration);
    if (!Number.isFinite(expiration.getTime()) || expiration.getTime()<=Date.now()) {
      throw new Error("Scoped AWS credential file is expired");
    }
    return {
      accessKeyId: parsed.AccessKeyId,
      secretAccessKey: parsed.SecretAccessKey,
      sessionToken: parsed.SessionToken,
      expiration,
    };
  };
}

export class AssetIntegrityError extends Error {
  constructor(message = "Asset bytes failed integrity verification") {
    super(message);
    this.name = "AssetIntegrityError";
  }
}

export class AssetNotFoundError extends Error {
  constructor(message = "Asset bytes are missing") {
    super(message);
    this.name = "AssetNotFoundError";
  }
}

export class ObjectAlreadyExistsError extends Error {
  constructor(message = "Immutable object already exists") {
    super(message);
    this.name = "ObjectAlreadyExistsError";
  }
}

const S3_MULTIPART_PART_SIZE = 8 * 1024 * 1024;
const MAX_GENERATED_OBJECT_BYTES = 64 * 1024 ** 3;

function generatedManifestKey(objectKey: string): string {
  return `${objectKey}.json`;
}

function parseGeneratedManifest(input: string): GeneratedObjectMetadata | null {
  try {
    const value = JSON.parse(input) as Record<string, unknown>;
    if (!Number.isSafeInteger(value.size_bytes) || Number(value.size_bytes) <= 0) return null;
    if (typeof value.content_hash !== "string" || !/^[a-f0-9]{64}$/.test(value.content_hash)) return null;
    return { sizeBytes: Number(value.size_bytes), contentHash: value.content_hash };
  } catch {
    return null;
  }
}

function generatedManifest(metadata: GeneratedObjectMetadata): string {
  return JSON.stringify({ size_bytes: metadata.sizeBytes, content_hash: metadata.contentHash });
}

class ChunkAccumulator {
  private readonly chunks: Uint8Array[] = [];
  private firstOffset = 0;
  byteLength = 0;

  push(chunk: Uint8Array): void {
    if (!chunk.byteLength) return;
    this.chunks.push(chunk);
    this.byteLength += chunk.byteLength;
  }

  take(length = this.byteLength): Buffer {
    if (length < 0 || length > this.byteLength) throw new Error("Invalid buffered asset length");
    const result = Buffer.allocUnsafe(length);
    let written = 0;
    while (written < length) {
      const chunk = this.chunks[0]!;
      const available = chunk.byteLength - this.firstOffset;
      const consumed = Math.min(available, length - written);
      result.set(chunk.subarray(this.firstOffset, this.firstOffset + consumed), written);
      written += consumed;
      this.firstOffset += consumed;
      if (this.firstOffset === chunk.byteLength) {
        this.chunks.shift();
        this.firstOffset = 0;
      }
    }
    this.byteLength -= length;
    return result;
  }
}

async function consumeVerifiedBody(
  asset: StoredAsset,
  body: ReadableStream<Uint8Array> | null,
  consume: (chunk: Uint8Array) => Promise<void> | void,
): Promise<void> {
  const hash = createHash("sha256");
  let size = 0;
  if (body) {
    const reader = body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > asset.sizeBytes) throw new AssetIntegrityError("Asset size mismatch");
        hash.update(value);
        await consume(value);
      }
    } catch (error) {
      try {
        await reader.cancel(error);
      } catch {
        // Preserve the integrity or storage error that stopped consumption.
      }
      throw error;
    }
  }
  if (size !== asset.sizeBytes || hash.digest("hex") !== asset.contentHash) {
    throw new AssetIntegrityError();
  }
}

export function contentDisposition(filename: string, inline: boolean): string {
  const safe = basename(filename).replaceAll(/[\r\n"\\]/g, "_").slice(0, 240);
  return `${inline ? "inline" : "attachment"}; filename="${safe}"`;
}

const INLINE_TYPES = /^(image\/(?:png|jpeg|gif|webp|avif)|video\/(?:mp4|webm|quicktime)|audio\/(?:mpeg|ogg|wav)|application\/pdf|text\/html)$/;
export function mayRenderInline(contentType: string): boolean {
  return INLINE_TYPES.test(contentType.toLowerCase());
}

export class S3Storage implements ObjectStorageBackend {
  constructor(
    private readonly client = new S3Client({
      region: process.env.AWS_REGION ?? "eu-west-2",
      ...(process.env.S3_ENDPOINT ? { endpoint: process.env.S3_ENDPOINT } : {}),
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
      ...(process.env.AWS_CREDENTIALS_FILE
        ? { credentials: credentialsFromFile(process.env.AWS_CREDENTIALS_FILE) }
        : {}),
    }),
    private readonly options: S3StorageConfig = {
      region: process.env.AWS_REGION ?? "eu-west-2",
      bucket: process.env.ASSET_BUCKET ?? "",
      kmsKeyId: process.env.KMS_KEY_ID || null,
    },
  ) {}

  private encryption(): {
    ServerSideEncryption: "aws:kms";
    SSEKMSKeyId: string;
  } | Record<string, never> {
    return this.options.kmsKeyId
      ? { ServerSideEncryption: "aws:kms", SSEKMSKeyId: this.options.kmsKeyId }
      : {};
  }

  async write(asset: StoredAsset, body: ReadableStream<Uint8Array> | null): Promise<void> {
    return this.writeVerified(asset, body, false);
  }

  async writeOnce(asset: StoredAsset, body: ReadableStream<Uint8Array> | null): Promise<void> {
    return this.writeVerified(asset, body, true);
  }

  private async writeVerified(
    asset: StoredAsset,
    body: ReadableStream<Uint8Array> | null,
    createOnly: boolean,
  ): Promise<void> {
    const checksum = Buffer.from(asset.contentHash, "hex").toString("base64");
    try {
      if (asset.sizeBytes <= S3_MULTIPART_PART_SIZE) {
        const buffered = new ChunkAccumulator();
        await consumeVerifiedBody(asset, body, (chunk) => buffered.push(chunk));
        await this.client.send(new PutObjectCommand({
          Bucket: this.options.bucket,
          Key: asset.objectKey,
          Body: buffered.take(),
          ContentType: asset.contentType,
          ContentLength: asset.sizeBytes,
          ChecksumSHA256: checksum,
          ...(createOnly ? { IfNoneMatch: "*" } : {}),
          Metadata: { sha256: asset.contentHash },
          ...this.encryption(),
        }));
        return;
      }

      const created = await this.client.send(new CreateMultipartUploadCommand({
        Bucket: this.options.bucket,
        Key: asset.objectKey,
        ContentType: asset.contentType,
        ChecksumAlgorithm: "SHA256",
        Metadata: { sha256: asset.contentHash },
        ...this.encryption(),
      }));
      if (!created.UploadId) throw new Error("S3 did not create an asset multipart upload");
      const uploadId = created.UploadId;
      const parts: Array<{ ETag: string; PartNumber: number; ChecksumSHA256: string }> = [];
      const buffered = new ChunkAccumulator();
      let completed = false;
      const uploadPart = async (bytes: Buffer) => {
        const partNumber = parts.length + 1;
        const partChecksum = createHash("sha256").update(bytes).digest("base64");
        const uploaded = await this.client.send(new UploadPartCommand({
          Bucket: this.options.bucket,
          Key: asset.objectKey,
          UploadId: uploadId,
          PartNumber: partNumber,
          Body: bytes,
          ContentLength: bytes.byteLength,
          ChecksumSHA256: partChecksum,
        }));
        if (!uploaded.ETag) throw new Error("S3 did not return an asset part ETag");
        parts.push({ ETag: uploaded.ETag, PartNumber: partNumber, ChecksumSHA256: partChecksum });
      };
      try {
        await consumeVerifiedBody(asset, body, async (chunk) => {
          buffered.push(chunk);
          while (buffered.byteLength >= S3_MULTIPART_PART_SIZE) {
            await uploadPart(buffered.take(S3_MULTIPART_PART_SIZE));
          }
        });
        if (buffered.byteLength) await uploadPart(buffered.take());
        await this.client.send(new CompleteMultipartUploadCommand({
          Bucket: this.options.bucket,
          Key: asset.objectKey,
          UploadId: uploadId,
          MultipartUpload: { Parts: parts },
          ...(createOnly ? { IfNoneMatch: "*" } : {}),
        }));
        completed = true;
      } finally {
        if (!completed) {
          await this.client.send(new AbortMultipartUploadCommand({
            Bucket: this.options.bucket,
            Key: asset.objectKey,
            UploadId: uploadId,
          })).catch(() => undefined);
        }
      }
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } } | null)
        ?.$metadata?.httpStatusCode;
      if (createOnly && error instanceof Error
          && (["PreconditionFailed", "ConditionalRequestConflict"].includes(error.name)
            || status === 409 || status === 412)) {
        throw new ObjectAlreadyExistsError();
      }
      if (error instanceof Error && error.name === "BadDigest") {
        throw new AssetIntegrityError("Asset checksum mismatch");
      }
      throw error;
    }
  }

  async writeBundle(
    objectKey: string,
    body: ReadableStream<Uint8Array> | null,
  ): Promise<GeneratedObjectMetadata> {
    return this.writeBundleObject(objectKey, body);
  }

  private async writeBundleObject(
    objectKey: string,
    body: ReadableStream<Uint8Array> | null,
  ): Promise<GeneratedObjectMetadata> {
    if (!body) throw new Error("Knowledge bundle body is missing");
    const created = await this.client.send(new CreateMultipartUploadCommand({
      Bucket: this.options.bucket,
      Key: objectKey,
      ContentType: "application/vnd.context-use.knowledge-bundle",
      ChecksumAlgorithm: "SHA256",
      Metadata: { generated: "knowledge-bundle" },
      ...this.encryption(),
    }));
    if (!created.UploadId) throw new Error("S3 did not create a knowledge bundle multipart upload");
    const uploadId = created.UploadId;
    const parts: Array<{ ETag: string; PartNumber: number; ChecksumSHA256: string }> = [];
    const buffered = new ChunkAccumulator();
    const hash = createHash("sha256");
    let sizeBytes = 0;
    let completed = false;
    const uploadPart = async (bytes: Buffer) => {
      const partNumber = parts.length + 1;
      const partChecksum = createHash("sha256").update(bytes).digest("base64");
      const uploaded = await this.client.send(new UploadPartCommand({
        Bucket: this.options.bucket,
        Key: objectKey,
        UploadId: uploadId,
        PartNumber: partNumber,
        Body: bytes,
        ContentLength: bytes.byteLength,
        ChecksumSHA256: partChecksum,
      }));
      if (!uploaded.ETag) throw new Error("S3 did not return a knowledge bundle part ETag");
      parts.push({ ETag: uploaded.ETag, PartNumber: partNumber, ChecksumSHA256: partChecksum });
    };
    try {
      const reader = body.getReader();
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          sizeBytes += chunk.value.byteLength;
          if (sizeBytes > MAX_GENERATED_OBJECT_BYTES) throw new Error("Knowledge bundle is too large");
          hash.update(chunk.value);
          buffered.push(chunk.value);
          while (buffered.byteLength >= S3_MULTIPART_PART_SIZE) {
            await uploadPart(buffered.take(S3_MULTIPART_PART_SIZE));
          }
        }
      } catch (error) {
        await reader.cancel(error).catch(() => undefined);
        throw error;
      }
      if (!sizeBytes) throw new Error("Knowledge bundle is empty");
      if (buffered.byteLength) await uploadPart(buffered.take());
      await this.client.send(new CompleteMultipartUploadCommand({
        Bucket: this.options.bucket,
        Key: objectKey,
        UploadId: uploadId,
        MultipartUpload: { Parts: parts },
      }));
      completed = true;
    } finally {
      if (!completed) {
        await this.client.send(new AbortMultipartUploadCommand({
          Bucket: this.options.bucket,
          Key: objectKey,
          UploadId: uploadId,
        })).catch(() => undefined);
      }
    }

    const metadata = { sizeBytes, contentHash: hash.digest("hex") };
    const manifest = generatedManifest(metadata);
    const manifestHash = createHash("sha256").update(manifest).digest("base64");
    await this.client.send(new PutObjectCommand({
      Bucket: this.options.bucket,
      Key: generatedManifestKey(objectKey),
      Body: manifest,
      ContentType: "application/json",
      ContentLength: Buffer.byteLength(manifest),
      ChecksumSHA256: manifestHash,
      ...this.encryption(),
    }));
    return metadata;
  }

  async inspectBundle(objectKey: string): Promise<GeneratedObjectMetadata | null> {
    try {
      const [manifestResult, objectResult] = await Promise.all([
        this.client.send(new GetObjectCommand({
          Bucket: this.options.bucket,
          Key: generatedManifestKey(objectKey),
        })),
        this.client.send(new HeadObjectCommand({
          Bucket: this.options.bucket,
          Key: objectKey,
        })),
      ]);
      if (!manifestResult.Body) return null;
      const metadata = parseGeneratedManifest(await manifestResult.Body.transformToString());
      return metadata && objectResult.ContentLength === metadata.sizeBytes ? metadata : null;
    } catch (error) {
      if (error instanceof Error && ["NoSuchKey", "NotFound"].includes(error.name)) return null;
      throw error;
    }
  }

  async deleteBundle(objectKey: string): Promise<void> {
    await Promise.all([
      this.delete(objectKey),
      this.delete(generatedManifestKey(objectKey)),
    ]);
  }

  async writeImportPart(asset: StoredAsset, body: ReadableStream<Uint8Array> | null): Promise<void> {
    return this.writeOnce(asset, body);
  }

  async inspectImportPart(objectKey: string): Promise<GeneratedObjectMetadata | null> {
    try {
      const result = await this.client.send(new HeadObjectCommand({
        Bucket: this.options.bucket,
        Key: objectKey,
        ChecksumMode: "ENABLED",
      }));
      const sizeBytes = Number(result.ContentLength);
      const contentHash = result.Metadata?.sha256 ?? "";
      return Number.isSafeInteger(sizeBytes) && sizeBytes > 0 && /^[a-f0-9]{64}$/.test(contentHash)
        ? { sizeBytes, contentHash }
        : null;
    } catch (error) {
      if (error instanceof Error && ["NoSuchKey", "NotFound"].includes(error.name)) return null;
      throw error;
    }
  }

  async deleteImportPart(objectKey: string): Promise<void> {
    await this.delete(objectKey);
  }

  async delete(objectKey: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.options.bucket, Key: objectKey }));
  }

  async exists(objectKey: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.options.bucket, Key: objectKey }));
      return true;
    } catch (error) {
      if (error instanceof Error && ["NoSuchKey", "NotFound"].includes(error.name)) return false;
      throw error;
    }
  }

  async read(objectKey: string, range?: ByteRange): Promise<BodyInit> {
    try {
      const result = await this.client.send(new GetObjectCommand({
        Bucket: this.options.bucket,
        Key: objectKey,
        ...(range ? { Range: `bytes=${range.start}-${range.end}` } : {}),
      }));
      if (!result.Body) throw new AssetNotFoundError();
      return result.Body.transformToWebStream() as BodyInit;
    } catch (error) {
      if (error instanceof AssetNotFoundError) throw error;
      if (error instanceof Error && ["NoSuchKey", "NotFound"].includes(error.name)) {
        throw new AssetNotFoundError();
      }
      throw error;
    }
  }

  async verify(objectKey: string, sizeBytes: number, contentHash: string): Promise<boolean> {
    try {
      const result = await this.client.send(new HeadObjectCommand({ Bucket: this.options.bucket, Key: objectKey, ChecksumMode: "ENABLED" }));
      const checksumMatches = result.ChecksumSHA256 === Buffer.from(contentHash, "hex").toString("base64")
        || result.Metadata?.sha256 === contentHash;
      return result.ContentLength === sizeBytes && checksumMatches;
    } catch {
      return false;
    }
  }
}
