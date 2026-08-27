import type { BlobStorage, ByteRange, GeneratedBlobMetadata } from "#storage/object-storage.ts";

export interface PrivateStorageBroker extends BlobStorage {
  writeMarkdownBlob(input: {
    revisionId: string;
    blobKey: string;
    sizeBytes: number;
    contentHash: string;
    body: string;
  }): Promise<void>;
  readMarkdownBlob(blobKey: string): Promise<string>;
  materializePublicationArtifact(allocationId: string): Promise<void>;
}

export interface PublicStorageBroker {
  readPublishedRepresentation(representationToken: string, range?: ByteRange): Promise<BodyInit>;
  readPublishedRepresentationText(representationToken: string): Promise<string>;
  inspectPublishedRepresentation(representationToken: string): Promise<GeneratedBlobMetadata>;
}
