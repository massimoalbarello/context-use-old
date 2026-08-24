import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type {
  Actor,
  ArchiveKnowledgeDocumentInput,
  CreateKnowledgeDocumentInput,
  UpdateKnowledgeDocumentInput,
} from "@context-use/shared";
import {
  assertMarkdownObject,
  mapConcurrently,
  MAX_KNOWLEDGE_PAGE_BYTES,
  type MarkdownObjectMetadata,
  type MarkdownObjectStore,
} from "./documents.ts";
import { genericDocumentTargets } from "./document-link-contract.ts";
import { PublicationStateError, VersionConflictError } from "./pages.ts";

export type KnowledgeRevisionContractProvenance =
  | "authored"
  | "corpus_migration";

export type KnowledgeDocumentMetadata = {
  document_id: string;
  current_revision_id: string;
  published_revision_id: string | null;
  public_id: string | null;
  revision_number: number;
  title: string;
  summary: string;
  archived_at: Date | string | null;
  legacy_published: boolean;
  current_link_contract: "generic_document_v1" | null;
  pathless_search_ready: boolean;
  created_at: Date | string;
  updated_at: Date | string;
};

export type KnowledgeDocument = KnowledgeDocumentMetadata & {
  body_markdown: string;
};

export type KnowledgeDocumentRevision = {
  document_id: string;
  revision_id: string;
  revision_number: number;
  title: string;
  summary: string;
  commit_message: string;
  actor_kind: Actor["kind"];
  actor_subject: string;
  created_at: Date | string;
  link_contract: "generic_document_v1" | null;
  contract_provenance: KnowledgeRevisionContractProvenance | null;
  target_document_ids: string[] | null;
  body_markdown: string;
};

export type KnowledgeDocumentChangeKind = "created" | "updated" | "archived" | "deleted";

export type KnowledgeDocumentChange = {
  cursor: string;
  document_id: string;
  revision_id: string;
  revision_number: number;
  previous_revision_number: number | null;
  change_kind: KnowledgeDocumentChangeKind;
  title: string;
  commit_message: string;
  actor_kind: Actor["kind"] | null;
  actor_subject: string | null;
  changed_at: Date | string;
};

export type KnowledgeDocumentChangeBatch = {
  changes: KnowledgeDocumentChange[];
  next_cursor: string;
  next_page_token?: string;
  has_more: boolean;
};

export type AdoptKnowledgeRevisionInput = {
  document_id: string;
  revision_id: string;
  body_markdown: string;
  provenance?: Exclude<KnowledgeRevisionContractProvenance, "authored">;
};

type StoredKnowledgeDocumentRow = KnowledgeDocumentMetadata & MarkdownObjectMetadata;
type StoredKnowledgeRevisionRow = Omit<KnowledgeDocumentRevision, "body_markdown"> & MarkdownObjectMetadata;
type KnowledgeDocumentChangeRow = Omit<KnowledgeDocumentChange, "cursor"> & {
  change_sequence: string;
};

const CHANGE_CURSOR_PREFIX = "cu-page-changes-v1.";
const CHANGE_PAGE_TOKEN_PREFIX = "cu-page-scan-v1.";
const MAX_BIGINT = 9_223_372_036_854_775_807n;

function parseBase36(value: string): bigint {
  if (!/^[0-9a-z]+$/.test(value)) throw new Error("Invalid knowledge document change cursor");
  let result = 0n;
  for (const character of value) {
    result = result * 36n + BigInt(parseInt(character, 36));
    if (result > MAX_BIGINT) throw new Error("Invalid knowledge document change cursor");
  }
  return result;
}

function changeCursor(sequence: string | bigint): string {
  return `${CHANGE_CURSOR_PREFIX}${BigInt(sequence).toString(36)}`;
}

function parseChangeCursor(cursor?: string): bigint {
  if (!cursor) return 0n;
  if (!cursor.startsWith(CHANGE_CURSOR_PREFIX)) {
    throw new Error("Invalid knowledge document change cursor");
  }
  return parseBase36(cursor.slice(CHANGE_CURSOR_PREFIX.length));
}

function pageToken(after: bigint, through: bigint, position: bigint): string {
  return `${CHANGE_PAGE_TOKEN_PREFIX}${after.toString(36)}.${through.toString(36)}.${position.toString(36)}`;
}

function parsePageToken(token: string): { after: bigint; through: bigint; position: bigint } {
  if (!token.startsWith(CHANGE_PAGE_TOKEN_PREFIX)) {
    throw new Error("Invalid knowledge document change page token");
  }
  const parts = token.slice(CHANGE_PAGE_TOKEN_PREFIX.length).split(".");
  if (parts.length !== 3) throw new Error("Invalid knowledge document change page token");
  const after = parseBase36(parts[0]!);
  const through = parseBase36(parts[1]!);
  const position = parseBase36(parts[2]!);
  if (after > position || position > through) {
    throw new Error("Invalid knowledge document change page token");
  }
  return { after, through, position };
}

async function knowledgeChangeWindowHead(pool: Pool, after: bigint): Promise<bigint> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('knowledge-page-change-ledger',0))",
    );
    const head = await client.query<{ change_sequence: string }>(
      `SELECT GREATEST($1::bigint,COALESCE(max(change_sequence),0))::text AS change_sequence
       FROM knowledge_page_changes`,
      [after.toString()],
    );
    await client.query("COMMIT");
    return BigInt(head.rows[0]?.change_sequence ?? after);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function boundedLimit(value: number | undefined, fallback: number, maximum: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.floor(value ?? fallback), 1), maximum);
}

const CURRENT_DOCUMENT_SELECT = `
  SELECT page.id AS document_id,page.current_version_id AS current_revision_id,
    page.published_version_id AS published_revision_id,resource.public_id,
    version.version_number AS revision_number,version.title,version.summary,
    page.archived_at,
    (page.published_version_id IS NOT NULL AND page.public_path IS NOT NULL)
      AS legacy_published,
    contract.link_contract::text AS current_link_contract,
    coalesce(search.revision_id=page.current_version_id,false) AS pathless_search_ready,
    page.created_at,page.updated_at,
    revision.body_object_key,revision.body_size_bytes,revision.body_content_hash
  FROM knowledge_pages page
  JOIN knowledge_page_versions version
    ON version.id=page.current_version_id AND version.page_id=page.id
  JOIN hypermedia_document_revisions revision
    ON revision.id=page.current_version_id AND revision.document_id=page.id
  JOIN hypermedia_documents document
    ON document.id=page.id
   AND document.authority='knowledge'
   AND document.representation='markdown'
  LEFT JOIN public_resources resource ON resource.document_id=page.id
  LEFT JOIN knowledge_revision_contracts contract
    ON contract.revision_id=page.current_version_id
  LEFT JOIN pathless_knowledge_search search ON search.document_id=page.id
`;

async function transaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET CONSTRAINTS ALL DEFERRED");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

// Compatibility labels are stable but deliberately unrelated to the private
// document UUID. They are never returned or ranked by the pathless API.
function compatibilityPath(): string {
  return `pathless-page-${randomUUID()}`;
}

export class KnowledgeDocumentRepository {
  constructor(
    private readonly pool: Pool,
    private readonly bodies: MarkdownObjectStore,
  ) {}

  private async storedBody(revisionId: string, markdown: string): Promise<MarkdownObjectMetadata> {
    if (Buffer.byteLength(markdown, "utf8") > MAX_KNOWLEDGE_PAGE_BYTES) {
      throw new Error("Knowledge document Markdown exceeds the page size limit");
    }
    return this.bodies.write(revisionId, markdown);
  }

  private async hydrate(row: StoredKnowledgeDocumentRow | undefined): Promise<KnowledgeDocument | null> {
    if (!row) return null;
    const { body_object_key, body_size_bytes, body_content_hash, ...metadata } = row;
    const body_markdown = assertMarkdownObject(
      await this.bodies.read({ body_object_key, body_size_bytes, body_content_hash }),
      { body_object_key, body_size_bytes, body_content_hash },
    );
    return { ...metadata, body_markdown };
  }

  private async getWith(client: Pool | PoolClient, documentId: string): Promise<KnowledgeDocument | null> {
    const result = await client.query<StoredKnowledgeDocumentRow>(
      `${CURRENT_DOCUMENT_SELECT} WHERE page.id=$1`,
      [documentId],
    );
    return this.hydrate(result.rows[0]);
  }

  private async getMetadataWith(
    client: Pool | PoolClient,
    documentId: string,
  ): Promise<KnowledgeDocumentMetadata | null> {
    const result = await client.query<StoredKnowledgeDocumentRow>(
      `${CURRENT_DOCUMENT_SELECT} WHERE page.id=$1`,
      [documentId],
    );
    const row = result.rows[0];
    if (!row) return null;
    const {
      body_object_key: _key,
      body_size_bytes: _size,
      body_content_hash: _hash,
      ...metadata
    } = row;
    return metadata;
  }

  async create(input: CreateKnowledgeDocumentInput, actor: Actor): Promise<KnowledgeDocument> {
    const documentId = randomUUID();
    const revisionId = randomUUID();
    const path = compatibilityPath();
    const targets = genericDocumentTargets(input.body_markdown);
    const stored = await this.storedBody(revisionId, input.body_markdown);
    return transaction(this.pool, async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock_shared(hashtextextended('filesystem-hypermedia-corpus-transition',0))",
      );
      await client.query(
        `INSERT INTO hypermedia_documents(id,authority,representation)
         VALUES ($1,'knowledge','markdown')`,
        [documentId],
      );
      await client.query(
        `INSERT INTO hypermedia_document_revisions(
           id,document_id,revision_number,body_object_key,body_size_bytes,body_content_hash
         ) VALUES ($1,$2,1,$3,$4,$5)`,
        [revisionId, documentId, stored.body_object_key,
          stored.body_size_bytes, stored.body_content_hash],
      );
      await client.query(
        `INSERT INTO knowledge_pages(id,current_path,current_version_id,search_vector)
         VALUES ($1,$2,$3,''::tsvector)`,
        [documentId, path, revisionId],
      );
      await client.query(
        `INSERT INTO knowledge_page_versions(
           id,page_id,version_number,path,title,summary,commit_message,actor_kind,actor_subject
         ) VALUES ($1,$2,1,$3,$4,$5,$6,$7,$8)`,
        [revisionId, documentId, path, input.title, input.summary,
          input.commit_message, actor.kind, actor.subject],
      );
      await client.query(
        "SELECT register_generic_knowledge_revision($1,$2,$3::uuid[])",
        [revisionId, input.body_markdown, targets],
      );
      return (await this.getWith(client, documentId))!;
    });
  }

  async update(
    documentId: string,
    input: UpdateKnowledgeDocumentInput,
    actor: Actor,
  ): Promise<KnowledgeDocument | null> {
    const preflight = await this.getMetadataWith(this.pool, documentId);
    if (!preflight || preflight.archived_at) return null;
    if (preflight.revision_number !== input.expected_revision_number) {
      throw new VersionConflictError(preflight.revision_number);
    }
    const revisionId = randomUUID();
    const targets = genericDocumentTargets(input.body_markdown);
    const stored = await this.storedBody(revisionId, input.body_markdown);
    return transaction(this.pool, async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock_shared(hashtextextended('filesystem-hypermedia-corpus-transition',0))",
      );
      await client.query("SELECT lock_operational_document($1)", [documentId]);
      const current = await client.query<{
        current_path: string;
        version_number: number;
      }>(
        `SELECT page.current_path,version.version_number
         FROM knowledge_pages page
         JOIN knowledge_page_versions version
           ON version.id=page.current_version_id AND version.page_id=page.id
         WHERE page.id=$1 AND page.archived_at IS NULL
         FOR UPDATE OF page`,
        [documentId],
      );
      if (!current.rowCount) return null;
      const row = current.rows[0]!;
      if (row.version_number !== input.expected_revision_number) {
        throw new VersionConflictError(row.version_number);
      }
      const revisionNumber = row.version_number + 1;
      await client.query(
        `INSERT INTO hypermedia_document_revisions(
           id,document_id,revision_number,body_object_key,body_size_bytes,body_content_hash
         ) VALUES ($1,$2,$3,$4,$5,$6)`,
        [revisionId, documentId, revisionNumber, stored.body_object_key,
          stored.body_size_bytes, stored.body_content_hash],
      );
      await client.query(
        `INSERT INTO knowledge_page_versions(
           id,page_id,version_number,path,title,summary,commit_message,actor_kind,actor_subject
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [revisionId, documentId, revisionNumber, row.current_path,
          input.title, input.summary, input.commit_message, actor.kind, actor.subject],
      );
      await client.query(
        `UPDATE knowledge_pages
         SET current_version_id=$2,
           search_vector=''::tsvector,updated_at=now()
         WHERE id=$1`,
        [documentId, revisionId],
      );
      await client.query(
        "SELECT register_generic_knowledge_revision($1,$2,$3::uuid[])",
        [revisionId, input.body_markdown, targets],
      );
      await client.query(
        "UPDATE hypermedia_documents SET updated_at=now() WHERE id=$1",
        [documentId],
      );
      return this.getWith(client, documentId);
    });
  }

  async archive(
    documentId: string,
    input: ArchiveKnowledgeDocumentInput,
    actor: Actor,
  ): Promise<KnowledgeDocument | null> {
    const preflight = await this.getMetadataWith(this.pool, documentId);
    if (!preflight) return null;
    if (preflight.archived_at) return this.get(documentId);
    if (preflight.revision_number !== input.expected_revision_number) {
      throw new VersionConflictError(preflight.revision_number);
    }
    const source = (await this.get(documentId))!;
    const revisionId = randomUUID();
    const targets = genericDocumentTargets(source.body_markdown);
    const stored = await this.storedBody(revisionId, source.body_markdown);
    return transaction(this.pool, async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock_shared(hashtextextended('filesystem-hypermedia-corpus-transition',0))",
      );
      await client.query("SELECT lock_operational_document($1)", [documentId]);
      const current = await client.query<{
        current_path: string;
        version_number: number;
        title: string;
        summary: string;
        published_version_id: string | null;
      }>(
        `SELECT page.current_path,version.version_number,version.title,version.summary,
           page.published_version_id
         FROM knowledge_pages page
         JOIN knowledge_page_versions version
           ON version.id=page.current_version_id AND version.page_id=page.id
         WHERE page.id=$1 AND page.archived_at IS NULL
         FOR UPDATE OF page`,
        [documentId],
      );
      if (!current.rowCount) return this.getWith(client, documentId);
      const row = current.rows[0]!;
      if (row.version_number !== input.expected_revision_number) {
        throw new VersionConflictError(row.version_number);
      }
      if (row.published_version_id) throw new PublicationStateError();
      const revisionNumber = row.version_number + 1;
      await client.query(
        `INSERT INTO hypermedia_document_revisions(
           id,document_id,revision_number,body_object_key,body_size_bytes,body_content_hash
         ) VALUES ($1,$2,$3,$4,$5,$6)`,
        [revisionId, documentId, revisionNumber, stored.body_object_key,
          stored.body_size_bytes, stored.body_content_hash],
      );
      await client.query(
        `INSERT INTO knowledge_page_versions(
           id,page_id,version_number,path,title,summary,commit_message,actor_kind,actor_subject
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [revisionId, documentId, revisionNumber, row.current_path,
          row.title, row.summary, input.commit_message, actor.kind, actor.subject],
      );
      await client.query(
        `UPDATE knowledge_pages
         SET current_version_id=$2,
           search_vector=''::tsvector,updated_at=now()
         WHERE id=$1`,
        [documentId, revisionId],
      );
      await client.query(
        "SELECT register_generic_knowledge_revision($1,$2,$3::uuid[])",
        [revisionId, source.body_markdown, targets],
      );
      await client.query(
        "UPDATE knowledge_pages SET archived_at=now(),updated_at=now() WHERE id=$1",
        [documentId],
      );
      await client.query(
        "UPDATE hypermedia_documents SET updated_at=now() WHERE id=$1",
        [documentId],
      );
      return this.getWith(client, documentId);
    });
  }

  async get(documentId: string): Promise<KnowledgeDocument | null> {
    return this.getWith(this.pool, documentId);
  }

  async history(
    documentId: string,
    options: { before_revision_number?: number; limit?: number } = {},
  ): Promise<{ revisions: KnowledgeDocumentRevision[]; has_more: boolean }> {
    const limit = boundedLimit(options.limit, 50, 100);
    const result = await this.pool.query<StoredKnowledgeRevisionRow>(
      `SELECT version.page_id AS document_id,version.id AS revision_id,
         version.version_number AS revision_number,
         version.title,version.summary,version.commit_message,
         version.actor_kind,version.actor_subject,version.created_at,
         contract.link_contract::text AS link_contract,
         contract.provenance::text AS contract_provenance,
         contract.target_document_ids,
         revision.body_object_key,revision.body_size_bytes,revision.body_content_hash
       FROM knowledge_page_versions version
       JOIN hypermedia_document_revisions revision
         ON revision.id=version.id AND revision.document_id=version.page_id
       LEFT JOIN knowledge_revision_contracts contract ON contract.revision_id=version.id
       WHERE version.page_id=$1
         AND ($2::integer IS NULL OR version.version_number<$2)
       ORDER BY version.version_number DESC
       LIMIT $3`,
      [documentId, options.before_revision_number ?? null, limit + 1],
    );
    const rows = result.rows.slice(0, limit);
    const revisions = await mapConcurrently(rows, 8, async (row) => {
      const { body_object_key, body_size_bytes, body_content_hash, ...metadata } = row;
      const body_markdown = assertMarkdownObject(
        await this.bodies.read({ body_object_key, body_size_bytes, body_content_hash }),
        { body_object_key, body_size_bytes, body_content_hash },
      );
      return { ...metadata, body_markdown };
    });
    return { revisions, has_more: result.rows.length > limit };
  }

  async revision(
    documentId: string,
    revisionNumber: number,
  ): Promise<KnowledgeDocumentRevision | null> {
    const result = await this.pool.query<StoredKnowledgeRevisionRow>(
      `SELECT version.page_id AS document_id,version.id AS revision_id,
         version.version_number AS revision_number,
         version.title,version.summary,version.commit_message,
         version.actor_kind,version.actor_subject,version.created_at,
         contract.link_contract::text AS link_contract,
         contract.provenance::text AS contract_provenance,
         contract.target_document_ids,
         revision.body_object_key,revision.body_size_bytes,revision.body_content_hash
       FROM knowledge_page_versions version
       JOIN hypermedia_document_revisions revision
         ON revision.id=version.id AND revision.document_id=version.page_id
       LEFT JOIN knowledge_revision_contracts contract ON contract.revision_id=version.id
       WHERE version.page_id=$1 AND version.version_number=$2`,
      [documentId, revisionNumber],
    );
    const row = result.rows[0];
    if (!row) return null;
    const { body_object_key, body_size_bytes, body_content_hash, ...metadata } = row;
    const body_markdown = assertMarkdownObject(
      await this.bodies.read({ body_object_key, body_size_bytes, body_content_hash }),
      { body_object_key, body_size_bytes, body_content_hash },
    );
    return { ...metadata, body_markdown };
  }

  async oldestRetainedRevisionAfter(
    documentId: string,
    afterRevisionNumber: number,
    throughRevisionNumber: number,
  ): Promise<KnowledgeDocumentRevision | null> {
    const result = await this.pool.query<{ revision_number: number }>(
      `SELECT version.version_number AS revision_number
       FROM knowledge_page_versions version
       WHERE version.page_id=$1
         AND version.version_number>$2
         AND version.version_number<=$3
       ORDER BY version.version_number ASC
       LIMIT 1`,
      [documentId, afterRevisionNumber, throughRevisionNumber],
    );
    const revisionNumber = result.rows[0]?.revision_number;
    return revisionNumber === undefined ? null : this.revision(documentId, revisionNumber);
  }

  async changesSince(options: {
    cursor?: string;
    pageToken?: string;
    limit?: number;
  } = {}): Promise<KnowledgeDocumentChangeBatch> {
    if (options.cursor && options.pageToken) {
      throw new Error("Provide a cursor or page token, not both");
    }
    const limit = Math.min(Math.max(options.limit ?? 200, 1), 500);
    let after: bigint;
    let through: bigint;
    let position: bigint;
    if (options.pageToken) {
      ({ after, through, position } = parsePageToken(options.pageToken));
    } else {
      after = parseChangeCursor(options.cursor);
      through = await knowledgeChangeWindowHead(this.pool, after);
      position = after;
    }
    const result = await this.pool.query<KnowledgeDocumentChangeRow>(
      `WITH latest_per_document AS (
         SELECT DISTINCT ON (page_id)
           change_sequence,page_id,version_id,version_number,change_kind,title,
           commit_message,actor_kind,actor_subject,changed_at
         FROM knowledge_page_changes
         WHERE change_sequence>$1::bigint AND change_sequence<=$2::bigint
         ORDER BY page_id,change_sequence DESC
       )
       SELECT latest.change_sequence::text AS change_sequence,
         latest.page_id AS document_id,latest.version_id AS revision_id,
         latest.version_number AS revision_number,
         baseline.version_number AS previous_revision_number,
         latest.change_kind,latest.title,latest.commit_message,
         latest.actor_kind,latest.actor_subject,latest.changed_at
       FROM latest_per_document latest
       LEFT JOIN LATERAL (
         SELECT prior.version_number
         FROM knowledge_page_changes prior
         WHERE prior.page_id=latest.page_id AND prior.change_sequence<=$1::bigint
         ORDER BY prior.change_sequence DESC
         LIMIT 1
       ) baseline ON true
       WHERE latest.change_sequence>$3::bigint
       ORDER BY latest.change_sequence
       LIMIT $4`,
      [after.toString(), through.toString(), position.toString(), limit + 1],
    );
    const hasMore = result.rows.length > limit;
    const included = result.rows.slice(0, limit);
    const lastPosition = included.length
      ? BigInt(included[included.length - 1]!.change_sequence)
      : position;
    return {
      changes: included.map(({ change_sequence, ...change }) => ({
        cursor: changeCursor(change_sequence),
        ...change,
      })),
      next_cursor: changeCursor(through),
      ...(hasMore ? { next_page_token: pageToken(after, through, lastPosition) } : {}),
      has_more: hasMore,
    };
  }

  async adoptCurrent(input: AdoptKnowledgeRevisionInput): Promise<KnowledgeDocumentMetadata> {
    const targets = genericDocumentTargets(input.body_markdown);
    return transaction(this.pool, async (client) => {
      await client.query(
        `SELECT adopt_generic_knowledge_revision(
           $1,$2,$3,$4::uuid[],$5::knowledge_revision_contract_provenance
         )`,
        [input.document_id, input.revision_id, input.body_markdown, targets,
          input.provenance ?? "corpus_migration"],
      );
      const metadata = await this.getMetadataWith(client, input.document_id);
      if (!metadata || metadata.current_revision_id !== input.revision_id) {
        throw new Error("Adopted knowledge revision is no longer current");
      }
      return metadata;
    });
  }
}
