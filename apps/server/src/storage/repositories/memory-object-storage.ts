import { createHash } from "node:crypto";
import {
  AssetIntegrityError,
  AssetNotFoundError,
  BlobAlreadyExistsError,
  type BlobStorageBackend,
  type ByteRange,
  type StoredBlob,
} from "#storage/object-storage.ts";

async function collect(body: ReadableStream<Uint8Array> | null): Promise<Uint8Array> {
  return body ? new Uint8Array(await new Response(body).arrayBuffer()) : new Uint8Array();
}

export class MemoryBlobStorage implements BlobStorageBackend {
  private readonly objects = new Map<string, Uint8Array>();

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
    if (createOnly && this.objects.has(asset.blobKey)) {
      throw new BlobAlreadyExistsError();
    }
    const value = await collect(body);
    if (
      value.byteLength !== asset.sizeBytes ||
      createHash("sha256").update(value).digest("hex") !== asset.contentHash
    ) {
      throw new AssetIntegrityError();
    }
    if (createOnly && this.objects.has(asset.blobKey)) {
      throw new BlobAlreadyExistsError();
    }
    this.objects.set(asset.blobKey, value);
  }

  async delete(blobKey: string): Promise<void> {
    this.objects.delete(blobKey);
  }

  async exists(blobKey: string): Promise<boolean> {
    return this.objects.has(blobKey);
  }

  async read(blobKey: string, range?: ByteRange): Promise<BodyInit> {
    const value = this.objects.get(blobKey);
    if (!value) {
      throw new AssetNotFoundError();
    }
    return range ? value.slice(range.start, range.end + 1) : value.slice();
  }

  async verify(blobKey: string, sizeBytes: number, contentHash: string): Promise<boolean> {
    const value = this.objects.get(blobKey);
    return Boolean(
      value &&
        value.byteLength === sizeBytes &&
        createHash("sha256").update(value).digest("hex") === contentHash,
    );
  }
}
