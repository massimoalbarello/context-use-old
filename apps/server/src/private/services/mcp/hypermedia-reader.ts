import type { ObjectLinkRepository } from "@context-use/database";
import type { HypermediaReader } from "./contracts.ts";

const MCP_BACKLINK_LIMIT = 100;

export function createHypermediaReader({
  objectLinks,
}: {
  objectLinks: ObjectLinkRepository;
}): HypermediaReader {
  return async ({ objectId, revisionId }) => {
    const [index, backlinkPage, backlinksComplete] = await Promise.all([
      revisionId ? objectLinks.revisionIndex(revisionId) : Promise.resolve(null),
      objectLinks.backlinks(objectId, MCP_BACKLINK_LIMIT),
      objectLinks.backlinksComplete(),
    ]);
    return {
      links_indexed: revisionId === null || index?.links_indexed_at != null,
      outbound_object_ids: index?.links_indexed_at == null ? [] : index.target_document_ids,
      backlinks: backlinkPage.backlinks.map((backlink) => ({
        source_object_id: backlink.source_document_id,
        source_revision_id: backlink.source_revision_id,
        source_revision_number: backlink.source_revision_number,
        source_authority: backlink.source_authority,
        source_representation: backlink.source_representation,
      })),
      backlinks_has_more: backlinkPage.has_more,
      backlinks_complete: backlinksComplete,
    };
  };
}
