import {
  assertMarkdownBlob,
  type MarkdownBlobMetadata,
  type MarkdownBlobStore,
  markdownBlobMetadata,
} from "@context-use/database";
import type { PrivateStorageBroker } from "#storage/client/contracts.ts";

export class BrokeredMarkdownBlobStore implements MarkdownBlobStore {
  constructor(
    private readonly storage: Pick<PrivateStorageBroker, "readMarkdownBlob" | "writeMarkdownBlob">,
  ) {}

  async write(revisionId: string, markdown: string): Promise<MarkdownBlobMetadata> {
    const metadata = markdownBlobMetadata(revisionId, markdown);
    await this.storage.writeMarkdownBlob({
      revisionId,
      blobKey: metadata.body_object_key,
      sizeBytes: metadata.body_size_bytes,
      contentHash: metadata.body_content_hash,
      body: markdown,
    });
    return metadata;
  }

  async read(metadata: MarkdownBlobMetadata): Promise<string> {
    return assertMarkdownBlob(
      await this.storage.readMarkdownBlob(metadata.body_object_key),
      metadata,
    );
  }
}
