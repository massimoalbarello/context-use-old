import { type BlobMaintenanceRepository, extractObjectLinks } from "@context-use/database";
import type { BlobStorageBackend } from "#storage/object-storage.ts";

export async function reconcileDocumentLinks(input: {
  storage: BlobStorageBackend;
  maintenance: Pick<
    BlobMaintenanceRepository,
    "unindexedLinkRevisions" | "replaceRevisionLinks" | "deferRevisionLinks"
  >;
}): Promise<{
  indexed: number;
  failures: Array<{ revisionId: string; error: unknown }>;
}> {
  const { storage, maintenance } = input;
  const revisions = await maintenance.unindexedLinkRevisions();
  let indexed = 0;
  const failures: Array<{ revisionId: string; error: unknown }> = [];
  const maxConcurrency = 8;
  const maxInFlightBytes = 16 * 1024 * 1024;
  for (let offset = 0; offset < revisions.length; ) {
    const batch: typeof revisions = [];
    let batchBytes = 0;
    while (offset < revisions.length && batch.length < maxConcurrency) {
      const revision = revisions[offset]!;
      const declaredBytes =
        Number.isSafeInteger(revision.body_size_bytes) && revision.body_size_bytes >= 0
          ? revision.body_size_bytes
          : maxInFlightBytes + 1;
      if (batch.length > 0 && batchBytes + declaredBytes > maxInFlightBytes) {
        break;
      }
      batch.push(revision);
      batchBytes += declaredBytes;
      offset += 1;
      if (declaredBytes > maxInFlightBytes) {
        break;
      }
    }
    await Promise.all(
      batch.map(async (revision) => {
        try {
          if (
            !(await storage.verify(
              revision.body_object_key,
              Number(revision.body_size_bytes),
              revision.body_content_hash,
            ))
          ) {
            throw new Error("Stored revision bytes are unavailable or corrupt");
          }
          const markdown = await new Response(await storage.read(revision.body_object_key)).text();
          await maintenance.replaceRevisionLinks(
            revision.revision_id,
            extractObjectLinks(markdown),
          );
          indexed += 1;
        } catch (error) {
          await maintenance.deferRevisionLinks(revision.revision_id);
          failures.push({ revisionId: revision.revision_id, error });
        }
      }),
    );
  }
  return { indexed, failures };
}
