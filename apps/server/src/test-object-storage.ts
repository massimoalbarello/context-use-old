import { createHash } from "node:crypto";
import { isFinalizedZipFooter, zipFooterRange } from "./zip-footer.ts";
import {
  AssetIntegrityError,
  AssetNotFoundError,
  ObjectAlreadyExistsError,
  type ByteRange,
  type GeneratedObjectMetadata,
  type ObjectStorageBackend,
  type StoredAsset,
} from "./storage.ts";

async function collect(body: ReadableStream<Uint8Array> | null): Promise<Uint8Array> {
  return body
    ? new Uint8Array(await new Response(body).arrayBuffer())
    : new Uint8Array();
}

export class MemoryObjectStorage implements ObjectStorageBackend {
  private readonly objects = new Map<string, Uint8Array>();
  private readonly generated = new Map<string, GeneratedObjectMetadata>();

  async write(asset: StoredAsset, body: ReadableStream<Uint8Array> | null): Promise<void> {
    await this.writeVerified(asset, body, false);
  }

  async writeOnce(asset: StoredAsset, body: ReadableStream<Uint8Array> | null): Promise<void> {
    await this.writeVerified(asset, body, true);
  }

  private async writeVerified(
    asset: StoredAsset,
    body: ReadableStream<Uint8Array> | null,
    createOnly: boolean,
  ): Promise<void> {
    if (createOnly && this.objects.has(asset.objectKey)) throw new ObjectAlreadyExistsError();
    const value = await collect(body);
    if (value.byteLength !== asset.sizeBytes
        || createHash("sha256").update(value).digest("hex") !== asset.contentHash) {
      throw new AssetIntegrityError();
    }
    if (createOnly && this.objects.has(asset.objectKey)) throw new ObjectAlreadyExistsError();
    this.objects.set(asset.objectKey, value);
  }

  async writeGenerated(
    objectKey: string,
    body: ReadableStream<Uint8Array> | null,
  ): Promise<GeneratedObjectMetadata> {
    if (!body) throw new Error("Generated object body is missing");
    const value = await collect(body);
    if (!value.byteLength) throw new Error("Generated object is empty");
    const footerRange = zipFooterRange(value.byteLength);
    if (!footerRange
        || !isFinalizedZipFooter(value.slice(footerRange.start, footerRange.end + 1))) {
      throw new Error("Generated ZIP central directory was not finalized");
    }
    const metadata = {
      sizeBytes: value.byteLength,
      contentHash: createHash("sha256").update(value).digest("hex"),
    };
    this.objects.set(objectKey, value);
    this.generated.set(objectKey, metadata);
    return metadata;
  }

  async inspectGenerated(objectKey: string): Promise<GeneratedObjectMetadata | null> {
    return this.objects.has(objectKey) ? this.generated.get(objectKey) ?? null : null;
  }

  async deleteGenerated(objectKey: string): Promise<void> {
    this.generated.delete(objectKey);
    this.objects.delete(objectKey);
  }

  async writeBundle(
    objectKey: string,
    body: ReadableStream<Uint8Array> | null,
  ): Promise<GeneratedObjectMetadata> {
    const value = await collect(body);
    if (!value.byteLength) throw new Error("Generated object is empty");
    const metadata = {
      sizeBytes: value.byteLength,
      contentHash: createHash("sha256").update(value).digest("hex"),
    };
    this.objects.set(objectKey, value);
    this.generated.set(objectKey, metadata);
    return metadata;
  }

  async inspectBundle(objectKey: string): Promise<GeneratedObjectMetadata | null> {
    return this.inspectGenerated(objectKey);
  }

  async deleteBundle(objectKey: string): Promise<void> {
    return this.deleteGenerated(objectKey);
  }

  async writeImportPart(asset: StoredAsset, body: ReadableStream<Uint8Array> | null): Promise<void> {
    return this.writeOnce(asset, body);
  }

  async inspectImportPart(objectKey: string): Promise<GeneratedObjectMetadata | null> {
    const value = this.objects.get(objectKey);
    return value ? {
      sizeBytes: value.byteLength,
      contentHash: createHash("sha256").update(value).digest("hex"),
    } : null;
  }

  async deleteImportPart(objectKey: string): Promise<void> {
    return this.delete(objectKey);
  }

  async delete(objectKey: string): Promise<void> {
    this.objects.delete(objectKey);
  }

  async exists(objectKey: string): Promise<boolean> {
    return this.objects.has(objectKey);
  }

  async read(objectKey: string, range?: ByteRange): Promise<BodyInit> {
    const value = this.objects.get(objectKey);
    if (!value) throw new AssetNotFoundError();
    return range ? value.slice(range.start, range.end + 1) : value.slice();
  }

  async verify(objectKey: string, sizeBytes: number, contentHash: string): Promise<boolean> {
    const value = this.objects.get(objectKey);
    return Boolean(value
      && value.byteLength === sizeBytes
      && createHash("sha256").update(value).digest("hex") === contentHash);
  }
}
