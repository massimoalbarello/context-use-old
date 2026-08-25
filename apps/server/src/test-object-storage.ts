import { createHash } from "node:crypto";
import {
  AssetIntegrityError,
  AssetNotFoundError,
  BlobAlreadyExistsError,
  type ByteRange,
  type GeneratedBlobMetadata,
  type BlobStorageBackend,
  type StoredBlob,
} from "./storage.ts";

async function collect(body: ReadableStream<Uint8Array> | null): Promise<Uint8Array> {
  return body
    ? new Uint8Array(await new Response(body).arrayBuffer())
    : new Uint8Array();
}

export class MemoryBlobStorage implements BlobStorageBackend {
  private readonly objects = new Map<string, Uint8Array>();
  private readonly generated = new Map<string, GeneratedBlobMetadata>();

  async write(asset: StoredBlob, body: ReadableStream<Uint8Array> | null): Promise<void> {
    await this.writeVerified(asset, body, false);
  }

  async writeOnce(asset: StoredBlob, body: ReadableStream<Uint8Array> | null): Promise<void> {
    await this.writeVerified(asset, body, true);
  }

  private async writeVerified(
    asset: StoredBlob,
    body: ReadableStream<Uint8Array> | null,
    createOnly: boolean,
  ): Promise<void> {
    if (createOnly && this.objects.has(asset.blobKey)) throw new BlobAlreadyExistsError();
    const value = await collect(body);
    if (value.byteLength !== asset.sizeBytes
        || createHash("sha256").update(value).digest("hex") !== asset.contentHash) {
      throw new AssetIntegrityError();
    }
    if (createOnly && this.objects.has(asset.blobKey)) throw new BlobAlreadyExistsError();
    this.objects.set(asset.blobKey, value);
  }

  async writeBundle(
    blobKey: string,
    body: ReadableStream<Uint8Array> | null,
  ): Promise<GeneratedBlobMetadata> {
    const value = await collect(body);
    if (!value.byteLength) throw new Error("Knowledge bundle is empty");
    const metadata = {
      sizeBytes: value.byteLength,
      contentHash: createHash("sha256").update(value).digest("hex"),
    };
    this.objects.set(blobKey, value);
    this.generated.set(blobKey, metadata);
    return metadata;
  }

  async inspectBundle(blobKey: string): Promise<GeneratedBlobMetadata | null> {
    return this.objects.has(blobKey) ? this.generated.get(blobKey) ?? null : null;
  }

  async deleteBundle(blobKey: string): Promise<void> {
    this.generated.delete(blobKey);
    this.objects.delete(blobKey);
  }

  async writeImportPart(asset: StoredBlob, body: ReadableStream<Uint8Array> | null): Promise<void> {
    return this.writeOnce(asset, body);
  }

  async inspectImportPart(blobKey: string): Promise<GeneratedBlobMetadata | null> {
    const value = this.objects.get(blobKey);
    return value ? {
      sizeBytes: value.byteLength,
      contentHash: createHash("sha256").update(value).digest("hex"),
    } : null;
  }

  async deleteImportPart(blobKey: string): Promise<void> {
    return this.delete(blobKey);
  }

  async delete(blobKey: string): Promise<void> {
    this.objects.delete(blobKey);
  }

  async exists(blobKey: string): Promise<boolean> {
    return this.objects.has(blobKey);
  }

  async read(blobKey: string, range?: ByteRange): Promise<BodyInit> {
    const value = this.objects.get(blobKey);
    if (!value) throw new AssetNotFoundError();
    return range ? value.slice(range.start, range.end + 1) : value.slice();
  }

  async verify(blobKey: string, sizeBytes: number, contentHash: string): Promise<boolean> {
    const value = this.objects.get(blobKey);
    return Boolean(value
      && value.byteLength === sizeBytes
      && createHash("sha256").update(value).digest("hex") === contentHash);
  }
}
