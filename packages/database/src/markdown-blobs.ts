import { createHash } from "node:crypto";

// Connector-controlled Markdown can be much larger than an authored knowledge
// page (notably a long agent conversation) while still remaining one exact raw
// record. Page schemas keep their tighter authoring limit.
export const MAX_KNOWLEDGE_PAGE_BYTES = 4_000_000;
export const MAX_MARKDOWN_BLOB_BYTES = 64 * 1024 * 1024;

export type MarkdownBlobMetadata = {
  body_object_key: string;
  body_size_bytes: number;
  body_content_hash: string;
};

export interface MarkdownBlobStore {
  write(revisionId: string, markdown: string): Promise<MarkdownBlobMetadata>;
  read(metadata: MarkdownBlobMetadata): Promise<string>;
}

export async function mapConcurrently<T, R>(
  values: T[],
  concurrency: number,
  transform: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new Error("Concurrency must be a positive integer");
  }
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await transform(values[index]!, index);
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(concurrency, values.length) },
    () => worker(),
  ));
  return results;
}

export function markdownBlobMetadata(revisionId: string, markdown: string): MarkdownBlobMetadata {
  const bytes = Buffer.from(markdown, "utf8");
  return {
    body_object_key: `blobs/${revisionId}`,
    body_size_bytes: bytes.byteLength,
    body_content_hash: createHash("sha256").update(bytes).digest("hex"),
  };
}

export function assertMarkdownBlob(markdown: string, metadata: MarkdownBlobMetadata): string {
  const blobMatch = metadata.body_object_key.match(/^blobs\/([a-f0-9-]{36})$/);
  const legacyMatch = metadata.body_object_key.match(
    /^documents\/private\/([a-f0-9-]{36})\.md$/,
  );
  const revisionId = blobMatch?.[1] ?? legacyMatch?.[1];
  if (!revisionId) throw new Error("Markdown blob locator is invalid");
  const actual = markdownBlobMetadata(revisionId, markdown);
  if (actual.body_size_bytes !== Number(metadata.body_size_bytes)
      || actual.body_content_hash !== metadata.body_content_hash) {
    throw new Error("Markdown blob failed integrity verification");
  }
  return markdown;
}
