import type { Pool, PoolClient } from "pg";
import type { CreatePageInput } from "@context-use/shared";
import {
  MAX_KNOWLEDGE_PAGE_BYTES,
  type MarkdownBlobStore,
} from "./markdown-blobs.ts";
import { genericObjectTargets } from "./object-link-contract.ts";

export type HypermediaBootstrapPageKind =
  | "global_guide"
  | "activity_distiller_instructions"
  | "activity_distiller_state"
  | "diary_composer_instructions"
  | "diary_composer_state";

export type HypermediaBootstrapAllocation = {
  document_kind: HypermediaBootstrapPageKind;
  document_id: string;
  revision_id: string;
};

export type HypermediaBootstrapPage = HypermediaBootstrapAllocation & {
  input: CreatePageInput;
};

const BOOTSTRAP_ACTOR = "context-use-hypermedia-bootstrap/v1";

async function transaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET CONSTRAINTS ALL DEFERRED");
    const value = await work(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export class HypermediaBootstrapRepository {
  constructor(
    private readonly pool: Pool,
    private readonly bodies: MarkdownBlobStore,
  ) {}

  async begin(): Promise<HypermediaBootstrapAllocation[]> {
    const result = await this.pool.query<HypermediaBootstrapAllocation>(
      `SELECT document_kind,document_id,revision_id
       FROM begin_hypermedia_bootstrap()`,
    );
    return result.rows;
  }

  async ensurePage(page: HypermediaBootstrapPage): Promise<void> {
    if (Buffer.byteLength(page.input.body_markdown, "utf8") > MAX_KNOWLEDGE_PAGE_BYTES) {
      throw new Error("Hypermedia bootstrap page exceeds the page size limit");
    }
    const stored = await this.bodies.write(page.revision_id, page.input.body_markdown);
    const targets = genericObjectTargets(page.input.body_markdown);
    await transaction(this.pool, async (client) => {
      const allocation = await client.query(
        `SELECT 1 FROM hypermedia_bootstrap_allocations
         WHERE document_kind=$1 AND document_id=$2 AND revision_id=$3`,
        [page.document_kind, page.document_id, page.revision_id],
      );
      if (!allocation.rowCount) throw new Error("Hypermedia bootstrap allocation changed");

      const existing = await client.query<{
        current_version_id: string;
        version_number: number;
        title: string;
        summary: string;
        commit_message: string;
        actor_kind: string;
        actor_subject: string;
        body_object_key: string;
        body_size_bytes: number | string;
        body_content_hash: string;
        contract_revision_id: string | null;
        search_revision_id: string | null;
      }>(
        `SELECT page.current_version_id,version.version_number,
           version.title,version.summary,version.commit_message,
           version.actor_kind,version.actor_subject,
           revision.body_object_key,revision.body_size_bytes,
           revision.body_content_hash,
           contract.revision_id AS contract_revision_id,
           search.revision_id AS search_revision_id
         FROM hypermedia_documents hypermedia
         JOIN knowledge_pages page ON page.id=hypermedia.id
         JOIN knowledge_page_versions version
           ON version.id=page.current_version_id AND version.page_id=page.id
         JOIN hypermedia_document_revisions revision
           ON revision.id=version.id AND revision.document_id=page.id
         LEFT JOIN knowledge_revision_contracts contract
           ON contract.revision_id=version.id AND contract.document_id=page.id
            AND contract.link_contract='generic_document_v1'
         LEFT JOIN knowledge_search search
           ON search.document_id=page.id AND search.revision_id=version.id
         WHERE hypermedia.id=$1 AND hypermedia.authority='knowledge'
           AND hypermedia.representation='markdown' AND page.archived_at IS NULL
         FOR UPDATE OF page`,
        [page.document_id],
      );
      const row = existing.rows[0];
      if (row) {
        const exact = row.current_version_id === page.revision_id
          && row.version_number === 1
          && row.title === page.input.title
          && row.summary === page.input.summary
          && row.commit_message === page.input.commit_message
          && row.actor_kind === "dashboard"
          && row.actor_subject === BOOTSTRAP_ACTOR
          && row.body_object_key === stored.body_object_key
          && Number(row.body_size_bytes) === stored.body_size_bytes
          && row.body_content_hash === stored.body_content_hash
          && row.contract_revision_id === page.revision_id
          && row.search_revision_id === page.revision_id;
        if (!exact) throw new Error(`Hypermedia bootstrap page conflicts: ${page.document_kind}`);
        return;
      }

      await client.query(
        `INSERT INTO hypermedia_documents(id,authority,representation)
         VALUES ($1,'knowledge','markdown')`,
        [page.document_id],
      );
      await client.query(
        `INSERT INTO hypermedia_document_revisions(
           id,document_id,revision_number,body_object_key,body_size_bytes,body_content_hash
         ) VALUES ($1,$2,1,$3,$4,$5)`,
        [page.revision_id, page.document_id, stored.body_object_key,
          stored.body_size_bytes, stored.body_content_hash],
      );
      await client.query(
        `INSERT INTO knowledge_pages(id,current_version_id,search_vector)
         VALUES ($1,$2,''::tsvector)`,
        [page.document_id, page.revision_id],
      );
      await client.query(
        `INSERT INTO knowledge_page_versions(
           id,page_id,version_number,title,summary,commit_message,
           actor_kind,actor_subject
         ) VALUES ($1,$2,1,$3,$4,$5,'dashboard',$6)`,
        [page.revision_id, page.document_id,
          page.input.title, page.input.summary,
          page.input.commit_message, BOOTSTRAP_ACTOR],
      );
      await client.query(
        "SELECT register_generic_knowledge_revision($1,$2,$3::uuid[])",
        [page.revision_id, page.input.body_markdown, targets],
      );
    });
  }

  async complete(): Promise<Date | string> {
    const result = await this.pool.query<{ completed_at: Date | string }>(
      "SELECT complete_hypermedia_bootstrap() AS completed_at",
    );
    const completedAt = result.rows[0]?.completed_at;
    if (!completedAt) throw new Error("Hypermedia bootstrap did not finalize");
    return completedAt;
  }
}
