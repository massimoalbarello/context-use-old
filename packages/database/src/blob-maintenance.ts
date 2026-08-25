import type { Pool } from "pg";
import type { MarkdownBlobMetadata } from "./markdown-blobs.ts";

export type UnindexedObjectRevision = MarkdownBlobMetadata & {
  revision_id: string;
};

export class BlobMaintenanceRepository {
  constructor(private readonly pool: Pool) {}

  async unindexedLinkRevisions(limit = 250): Promise<UnindexedObjectRevision[]> {
    const boundedLimit = Math.min(Math.max(limit, 1), 1_000);
    const result = await this.pool.query<UnindexedObjectRevision>(
      `SELECT revision.id AS revision_id,revision.body_object_key,
         revision.body_size_bytes,revision.body_content_hash
       FROM hypermedia_document_revisions revision
       LEFT JOIN knowledge_pages page
         ON page.current_version_id=revision.id AND page.archived_at IS NULL
       LEFT JOIN source_records record
         ON record.current_revision_id=revision.id AND record.deleted_at IS NULL
       WHERE revision.links_indexed_at IS NULL
       ORDER BY (page.id IS NOT NULL OR record.document_id IS NOT NULL) DESC,
         revision.links_index_attempted_at NULLS FIRST,
         revision.links_index_attempted_at,revision.created_at,revision.id
       LIMIT $1`,
      [boundedLimit],
    );
    return result.rows.map((revision) => ({
      ...revision,
      body_size_bytes: Number(revision.body_size_bytes),
    }));
  }

  async replaceRevisionLinks(revisionId: string, targetDocumentIds: string[]): Promise<void> {
    await this.pool.query(
      "SELECT replace_document_links($1,$2::uuid[])",
      [revisionId, targetDocumentIds],
    );
  }

  async deferRevisionLinks(revisionId: string): Promise<void> {
    await this.pool.query("SELECT defer_document_link_index($1)", [revisionId]);
  }

}
