import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";

export type PrivateDocumentKind = "knowledge" | "record" | "asset";
export type PrivateDocumentLifecycle = "active" | "archived" | "deleted";
export type PrivateDocumentOperationalRole =
  | "global_guide"
  | "automation_instructions"
  | "automation_state";

export type PrivateDocumentCatalogFilters = {
  authority?: "knowledge" | "source";
  representation?: "markdown" | "asset";
  document_kind?: PrivateDocumentKind;
  lifecycle?: PrivateDocumentLifecycle;
  integration?: string;
  operational_role?: PrivateDocumentOperationalRole;
};

export type PrivateDocumentCatalogItem = {
  document_id: string;
  document_kind: PrivateDocumentKind;
  authority: "knowledge" | "source";
  representation: "markdown" | "asset";
  lifecycle: PrivateDocumentLifecycle;
  current_revision_id: string | null;
  current_revision_number: number | null;
  title: string | null;
  summary: string | null;
  filename: string | null;
  content_type: string | null;
  size_bytes: string | null;
  content_hash: string | null;
  width: number | null;
  height: number | null;
  duration_seconds: string | null;
  integration: string | null;
  connection_instance_id: string | null;
  connection_id: string | null;
  source_model: string | null;
  source_record_id: string | null;
  operational_roles: PrivateDocumentOperationalRole[];
  public_id: string | null;
  current_link_contract: "generic_document_v1" | null;
  links_indexed_at: string | null;
  pathless_search_ready: boolean;
  created_at: string;
  updated_at: string;
};

export type PrivateDocumentCatalogPage = {
  documents: PrivateDocumentCatalogItem[];
  next_cursor: string | null;
  has_more: boolean;
};

export type PrivateDocumentNeighbor = {
  target_document_id: string;
  resolved: boolean;
  document: PrivateDocumentCatalogItem | null;
};

export type PrivateDocumentNeighborhood = {
  document: PrivateDocumentCatalogItem;
  outbound: {
    revision_id: string | null;
    neighbors: PrivateDocumentNeighbor[];
    next_cursor: string | null;
    has_more: boolean;
    index_complete: boolean;
  };
  backlinks: {
    documents: PrivateDocumentCatalogItem[];
    next_cursor: string | null;
    has_more: boolean;
    completeness_checked: boolean;
    complete: boolean | null;
  };
};

// When explicitly requested, `backlinks.complete` means every active current
// knowledge revision has an application-attested generic receipt whose
// materialized graph is exact, and every source-record current revision has a
// completed zero-edge index. The default bounded neighborhood read reports
// `completeness_checked=false` and `complete=null`; a full verification must
// independently hydrate and parse bodies under its locks.

type CatalogDatabaseRow = Omit<
  PrivateDocumentCatalogItem,
  "size_bytes" | "duration_seconds" | "connection_instance_id"
    | "links_indexed_at" | "created_at" | "updated_at"
> & {
  size_bytes: number | string | null;
  duration_seconds: number | string | null;
  connection_instance_id: number | string | null;
  links_indexed_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

type NeighborRow = CatalogDatabaseRow & {
  target_document_id: string;
  resolved: boolean;
};

type PrivateDocumentSearchRow = {
  document: CatalogDatabaseRow;
  search_rank: number;
  search_updated_at_epoch_micros: string;
  search_document_id: string;
};

type PrivateDocumentListRow = CatalogDatabaseRow & {
  cursor_updated_at_epoch_micros: string;
};

type PrivateDocumentSearchCursor = {
  version: 1;
  fingerprint: string;
  rank: number;
  updated_at_epoch_micros: string;
  document_id: string;
};

type PrivateDocumentListCursor = {
  version: 1;
  fingerprint: string;
  updated_at_epoch_micros: string;
  document_id: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MIN_INT64 = -(1n << 63n);
const MAX_INT64 = (1n << 63n) - 1n;

export class InvalidPrivateDocumentCursorError extends Error {
  readonly code = "INVALID_PRIVATE_DOCUMENT_CURSOR";

  constructor(surface: "catalog" | "search" | "neighborhood") {
    super(`Private document ${surface} cursor is invalid for this query`);
    this.name = "InvalidPrivateDocumentCursorError";
  }
}

function boundedLimit(value: number | undefined, fallback: number, maximum: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.floor(value ?? fallback), 1), maximum);
}

function validEpochMicros(value: string): boolean {
  if (!/^-?\d+$/.test(value)) return false;
  try {
    const parsed = BigInt(value);
    return parsed >= MIN_INT64 && parsed <= MAX_INT64;
  } catch {
    return false;
  }
}

function timestamp(value: Date | string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.valueOf())) throw new Error("Private document timestamp is invalid");
  return parsed.toISOString();
}

function normalizeCatalogItem(row: CatalogDatabaseRow): PrivateDocumentCatalogItem {
  return {
    ...row,
    size_bytes: row.size_bytes === null ? null : String(row.size_bytes),
    duration_seconds: row.duration_seconds === null ? null : String(row.duration_seconds),
    connection_instance_id: row.connection_instance_id === null
      ? null
      : String(row.connection_instance_id),
    links_indexed_at: row.links_indexed_at === null ? null : timestamp(row.links_indexed_at),
    created_at: timestamp(row.created_at),
    updated_at: timestamp(row.updated_at),
  };
}

function neighbor(row: NeighborRow): PrivateDocumentNeighbor {
  const { target_document_id, resolved, ...catalog } = row;
  return {
    target_document_id,
    resolved,
    document: catalog.document_id ? normalizeCatalogItem(catalog) : null,
  };
}

function searchFingerprint(
  query: string,
  options: PrivateDocumentCatalogFilters & { include_retired?: boolean },
): string {
  return createHash("sha256").update(JSON.stringify({
    query: query.trim(),
    include_retired: options.include_retired ?? false,
    authority: options.authority ?? null,
    representation: options.representation ?? null,
    document_kind: options.document_kind ?? null,
    lifecycle: options.lifecycle ?? null,
    integration: options.integration ?? null,
    operational_role: options.operational_role ?? null,
  })).digest("hex");
}

function listFingerprint(
  options: PrivateDocumentCatalogFilters & { include_retired?: boolean },
): string {
  return searchFingerprint("", options);
}

function decodeListCursor(
  cursor: string | undefined,
  fingerprint: string,
): PrivateDocumentListCursor | null {
  if (!cursor) return null;
  try {
    const value = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as Partial<PrivateDocumentListCursor>;
    if (value.version !== 1 || value.fingerprint !== fingerprint
        || typeof value.updated_at_epoch_micros !== "string"
        || !validEpochMicros(value.updated_at_epoch_micros)
        || typeof value.document_id !== "string" || !UUID.test(value.document_id)) {
      throw new Error();
    }
    return value as PrivateDocumentListCursor;
  } catch {
    throw new InvalidPrivateDocumentCursorError("catalog");
  }
}

function decodeSearchCursor(
  cursor: string | undefined,
  fingerprint: string,
): PrivateDocumentSearchCursor | null {
  if (!cursor) return null;
  try {
    const value = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as Partial<PrivateDocumentSearchCursor>;
    if (value.version !== 1 || value.fingerprint !== fingerprint
        || typeof value.rank !== "number" || value.rank < 0
        || !Number.isFinite(value.rank) || !Number.isFinite(Math.fround(value.rank))
        || typeof value.updated_at_epoch_micros !== "string"
        || !validEpochMicros(value.updated_at_epoch_micros)
        || typeof value.document_id !== "string" || !UUID.test(value.document_id)) {
      throw new Error();
    }
    return value as PrivateDocumentSearchCursor;
  } catch {
    throw new InvalidPrivateDocumentCursorError("search");
  }
}

function encodeSearchCursor(
  row: PrivateDocumentSearchRow,
  fingerprint: string,
): string {
  const value: PrivateDocumentSearchCursor = {
    version: 1,
    fingerprint,
    rank: row.search_rank,
    updated_at_epoch_micros: row.search_updated_at_epoch_micros,
    document_id: row.search_document_id,
  };
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function encodeListCursor(
  row: PrivateDocumentListRow,
  fingerprint: string,
): string {
  const value: PrivateDocumentListCursor = {
    version: 1,
    fingerprint,
    updated_at_epoch_micros: row.cursor_updated_at_epoch_micros,
    document_id: row.document_id,
  };
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

async function repeatableRead<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
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

export class PrivateDocumentCatalogRepository {
  constructor(private readonly pool: Pool) {}

  async get(documentId: string): Promise<PrivateDocumentCatalogItem | null> {
    return this.getWith(this.pool, documentId);
  }

  private async getWith(
    client: Pool | PoolClient,
    documentId: string,
  ): Promise<PrivateDocumentCatalogItem | null> {
    const result = await client.query<CatalogDatabaseRow>(
      "SELECT * FROM private_document_catalog WHERE document_id=$1",
      [documentId],
    );
    return result.rows[0] ? normalizeCatalogItem(result.rows[0]) : null;
  }

  async list(options: PrivateDocumentCatalogFilters & {
    cursor?: string;
    limit?: number;
    include_retired?: boolean;
  } = {}): Promise<PrivateDocumentCatalogPage> {
    const limit = boundedLimit(options.limit, 50, 200);
    const fingerprint = listFingerprint(options);
    const cursor = decodeListCursor(options.cursor, fingerprint);
    const result = await this.pool.query<PrivateDocumentListRow>(
      `SELECT catalog.*,
         (extract(epoch FROM updated_at)*1000000)::bigint::text
           AS cursor_updated_at_epoch_micros
       FROM private_document_catalog catalog
       WHERE ($1::bigint IS NULL
         OR (extract(epoch FROM updated_at)*1000000)::bigint<$1
         OR (
           (extract(epoch FROM updated_at)*1000000)::bigint=$1
           AND document_id::text COLLATE "C">$2::text COLLATE "C"
         ))
         AND (
           $7::private_document_lifecycle IS NOT NULL
             AND lifecycle=$7::private_document_lifecycle::text
           OR $7::private_document_lifecycle IS NULL
             AND ($3::boolean OR lifecycle='active')
         )
         AND ($4::hypermedia_document_authority IS NULL OR authority=$4)
         AND ($5::hypermedia_document_representation IS NULL OR representation=$5)
         AND ($6::private_document_kind IS NULL
           OR document_kind=$6::private_document_kind::text)
         AND ($8::text IS NULL OR integration=$8)
         AND ($9::private_document_operational_role IS NULL
           OR $9::private_document_operational_role::text=ANY(operational_roles))
       ORDER BY updated_at DESC,document_id::text COLLATE "C"
       LIMIT $10`,
      [cursor?.updated_at_epoch_micros ?? null, cursor?.document_id ?? null,
        options.include_retired ?? false,
        options.authority ?? null, options.representation ?? null,
        options.document_kind ?? null, options.lifecycle ?? null,
        options.integration ?? null, options.operational_role ?? null, limit + 1],
    );
    const rows = result.rows.slice(0, limit);
    const documents = rows.map(({ cursor_updated_at_epoch_micros: _cursor, ...document }) => (
      normalizeCatalogItem(document)
    ));
    return {
      documents,
      next_cursor: result.rows.length > limit
        ? encodeListCursor(rows.at(-1)!, fingerprint)
        : null,
      has_more: result.rows.length > limit,
    };
  }

  async search(query: string, options: PrivateDocumentCatalogFilters & {
    cursor?: string;
    limit?: number;
    include_retired?: boolean;
  } = {}): Promise<PrivateDocumentCatalogPage> {
    if (!query.trim()) return { documents: [], next_cursor: null, has_more: false };
    const limit = boundedLimit(options.limit, 30, 100);
    const fingerprint = searchFingerprint(query, options);
    const cursor = decodeSearchCursor(options.cursor, fingerprint);
    const result = await this.pool.query<PrivateDocumentSearchRow>(
      `SELECT * FROM search_private_document_catalog(
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12
       )`,
      [query.trim(), cursor?.rank ?? null, cursor?.updated_at_epoch_micros ?? null,
        cursor?.document_id ?? null, options.include_retired ?? false, limit + 1,
        options.authority ?? null, options.representation ?? null,
        options.document_kind ?? null, options.lifecycle ?? null,
        options.integration ?? null, options.operational_role ?? null],
    );
    const rows = result.rows.slice(0, limit);
    const documents = rows.map((row) => normalizeCatalogItem(row.document));
    return {
      documents,
      next_cursor: result.rows.length > limit
        ? encodeSearchCursor(rows.at(-1)!, fingerprint)
        : null,
      has_more: result.rows.length > limit,
    };
  }

  async neighborhood(
    documentId: string,
    options: {
      requested_revision_id?: string;
      outbound_after_document_id?: string;
      outbound_limit?: number;
      backlink_after_document_id?: string;
      backlink_limit?: number;
      audit_global_completeness?: boolean;
    } = {},
  ): Promise<PrivateDocumentNeighborhood | null> {
    if (options.outbound_after_document_id && !options.requested_revision_id) {
      throw new InvalidPrivateDocumentCursorError("neighborhood");
    }
    for (const cursor of [
      options.requested_revision_id,
      options.outbound_after_document_id,
      options.backlink_after_document_id,
    ]) {
      if (cursor !== undefined && !UUID.test(cursor)) {
        throw new InvalidPrivateDocumentCursorError("neighborhood");
      }
    }
    return repeatableRead(this.pool, async (client) => {
      const document = await this.getWith(client, documentId);
      if (!document) return null;
      const outboundLimit = boundedLimit(options.outbound_limit, 100, 500);
      const backlinkLimit = boundedLimit(options.backlink_limit, 100, 500);
      const revisionId = options.requested_revision_id ?? document.current_revision_id;
      if (options.requested_revision_id) {
        const requested = await client.query(
          `SELECT 1 FROM hypermedia_document_revisions
           WHERE id=$1 AND document_id=$2`,
          [options.requested_revision_id, documentId],
        );
        if (!requested.rowCount) throw new InvalidPrivateDocumentCursorError("neighborhood");
      }

      const outbound = revisionId
        ? await client.query<NeighborRow>(
          `WITH receipt AS (
             SELECT target_document_id
             FROM knowledge_revision_contracts contract
             CROSS JOIN LATERAL unnest(contract.target_document_ids)
               target(target_document_id)
             WHERE contract.revision_id=$1
             UNION
             SELECT link.target_document_id
             FROM document_links link
             WHERE link.source_revision_id=$1
               AND NOT EXISTS (
                 SELECT 1 FROM knowledge_revision_contracts contract
                 WHERE contract.revision_id=$1
               )
           )
           SELECT receipt.target_document_id,
             (link.target_document_id IS NOT NULL) AS resolved,catalog.*
           FROM receipt
           LEFT JOIN document_links link
             ON link.source_revision_id=$1
            AND link.target_document_id=receipt.target_document_id
           LEFT JOIN private_document_catalog catalog
             ON catalog.document_id=receipt.target_document_id
           WHERE ($2::text IS NULL
             OR receipt.target_document_id::text COLLATE "C">$2::text COLLATE "C")
           ORDER BY receipt.target_document_id::text COLLATE "C"
           LIMIT $3`,
          [revisionId, options.outbound_after_document_id ?? null, outboundLimit + 1],
        )
        : { rows: [] as NeighborRow[] };

      const backlinks = await client.query<CatalogDatabaseRow>(
        `WITH origins AS (
           SELECT page.id AS document_id
           FROM document_links link
           JOIN knowledge_pages page
             ON page.current_version_id=link.source_revision_id
            AND page.archived_at IS NULL
           WHERE link.target_document_id=$1
           UNION
           SELECT record.document_id
           FROM document_links link
           JOIN source_records record
             ON record.current_revision_id=link.source_revision_id
            AND record.deleted_at IS NULL
           WHERE link.target_document_id=$1
         )
         SELECT catalog.*
         FROM origins
         JOIN private_document_catalog catalog USING (document_id)
         WHERE ($2::text IS NULL
           OR catalog.document_id::text COLLATE "C">$2::text COLLATE "C")
         ORDER BY catalog.document_id::text COLLATE "C"
         LIMIT $3`,
        [documentId, options.backlink_after_document_id ?? null, backlinkLimit + 1],
      );
      const indexComplete = await client.query<{ complete: boolean }>(
        `SELECT CASE
           WHEN $2::private_document_kind='asset' THEN true
           WHEN $2::private_document_kind='record' THEN
             ($1::uuid IS NULL AND $3::private_document_lifecycle<>'active') OR (
               $1::uuid IS NOT NULL
               AND
               EXISTS (
                 SELECT 1 FROM hypermedia_document_revisions revision
                 WHERE revision.id=$1 AND revision.links_indexed_at IS NOT NULL
               )
               AND NOT EXISTS (
                 SELECT 1 FROM document_links link WHERE link.source_revision_id=$1
               )
             )
           WHEN $1::uuid IS NULL THEN false
           ELSE EXISTS (
             SELECT 1
             FROM hypermedia_document_revisions revision
             JOIN knowledge_revision_contracts contract
               ON contract.revision_id=revision.id
              AND contract.document_id=revision.document_id
              AND contract.link_contract='generic_document_v1'
             WHERE revision.id=$1 AND revision.links_indexed_at IS NOT NULL
               AND NOT EXISTS ((
                 SELECT link.target_document_id
                 FROM document_links link WHERE link.source_revision_id=$1
                 EXCEPT
                 SELECT target.target_document_id
                 FROM unnest(contract.target_document_ids) target(target_document_id)
                 JOIN hypermedia_documents target_document
                   ON target_document.id=target.target_document_id
               ) UNION ALL (
                 SELECT target.target_document_id
                 FROM unnest(contract.target_document_ids) target(target_document_id)
                 JOIN hypermedia_documents target_document
                   ON target_document.id=target.target_document_id
                 EXCEPT
                 SELECT link.target_document_id
                 FROM document_links link WHERE link.source_revision_id=$1
               ))
           )
         END AS complete`,
        [revisionId, document.document_kind, document.lifecycle],
      );
      const complete = options.audit_global_completeness
        ? await client.query<{ complete: boolean }>(
        `SELECT
           NOT EXISTS (
             SELECT 1
             FROM knowledge_pages page
             LEFT JOIN hypermedia_document_revisions revision
               ON revision.id=page.current_version_id AND revision.document_id=page.id
             LEFT JOIN knowledge_revision_contracts contract
               ON contract.revision_id=page.current_version_id
              AND contract.document_id=page.id
             WHERE page.archived_at IS NULL AND (
               revision.id IS NULL OR revision.links_indexed_at IS NULL
               OR contract.revision_id IS NULL
               OR contract.link_contract<>'generic_document_v1'
               OR EXISTS ((
                 SELECT link.target_document_id
                 FROM document_links link
                 WHERE link.source_revision_id=page.current_version_id
                 EXCEPT
                 SELECT target.target_document_id
                 FROM unnest(contract.target_document_ids) target(target_document_id)
                 JOIN hypermedia_documents target_document
                   ON target_document.id=target.target_document_id
               ) UNION ALL (
                 SELECT target.target_document_id
                 FROM unnest(contract.target_document_ids) target(target_document_id)
                 JOIN hypermedia_documents target_document
                   ON target_document.id=target.target_document_id
                 EXCEPT
                 SELECT link.target_document_id
                 FROM document_links link
                 WHERE link.source_revision_id=page.current_version_id
               ))
             )
           )
           AND NOT EXISTS (
             SELECT 1
             FROM source_records record
             LEFT JOIN hypermedia_document_revisions revision
               ON revision.id=record.current_revision_id
              AND revision.document_id=record.document_id
             WHERE record.deleted_at IS NULL
               AND (
                 record.current_revision_id IS NULL
                 OR revision.id IS NULL OR revision.links_indexed_at IS NULL
                 OR EXISTS (
                   SELECT 1 FROM document_links link
                   WHERE link.source_revision_id=record.current_revision_id
                 )
               )
           ) AS complete`,
        )
        : null;

      return {
        document,
        outbound: {
          revision_id: revisionId,
          neighbors: outbound.rows.slice(0, outboundLimit).map(neighbor),
          next_cursor: outbound.rows.length > outboundLimit
            ? outbound.rows[outboundLimit - 1]?.target_document_id ?? null
            : null,
          has_more: outbound.rows.length > outboundLimit,
          index_complete: indexComplete.rows[0]?.complete === true,
        },
        backlinks: {
          documents: backlinks.rows.slice(0, backlinkLimit).map(normalizeCatalogItem),
          next_cursor: backlinks.rows.length > backlinkLimit
            ? backlinks.rows[backlinkLimit - 1]?.document_id ?? null
            : null,
          has_more: backlinks.rows.length > backlinkLimit,
          completeness_checked: complete !== null,
          complete: complete === null ? null : complete.rows[0]?.complete === true,
        },
      };
    });
  }
}
