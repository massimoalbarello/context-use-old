import { basename } from "node:path";

export type StoredBlob = {
  id: string;
  blobKey: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  contentHash: string;
};

export type ByteRange = { start: number; end: number };

export type GeneratedBlobMetadata = {
  sizeBytes: number;
  contentHash: string;
};

export interface BlobStorage {
  write(asset: StoredBlob, body: ReadableStream<Uint8Array> | null): Promise<void>;
  delete(blobKey: string): Promise<void>;
  read(blobKey: string, range?: ByteRange): Promise<BodyInit>;
  verify(blobKey: string, sizeBytes: number, contentHash: string): Promise<boolean>;
}

export interface BlobStorageBackend extends BlobStorage {
  exists(blobKey: string): Promise<boolean>;
  writeOnce(asset: StoredBlob, body: ReadableStream<Uint8Array> | null): Promise<void>;
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

export class BlobAlreadyExistsError extends Error {
  constructor(message = "Immutable object already exists") {
    super(message);
    this.name = "BlobAlreadyExistsError";
  }
}

export function contentDisposition({
  filename,
  inline,
}: {
  filename: string;
  inline: boolean;
}): string {
  const safe = basename(filename)
    .replaceAll(/[\r\n"\\]/g, "_")
    .slice(0, 240);
  return `${inline ? "inline" : "attachment"}; filename="${safe}"`;
}

const INLINE_TYPES =
  /^(image\/(?:png|jpeg|gif|webp|avif)|video\/(?:mp4|webm|quicktime)|audio\/(?:mpeg|ogg|wav)|application\/pdf|text\/html)$/;

export function mayRenderInline(contentType: string): boolean {
  return INLINE_TYPES.test(contentType.toLowerCase());
}
