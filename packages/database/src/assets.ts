import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type {
  ArchiveAssetInput,
  CreateAssetInput,
} from "@context-use/shared";

export type AssetArchiveConflictReason = "published" | "referenced";

export class AssetArchiveConflictError extends Error {
  constructor(readonly reason: AssetArchiveConflictReason) {
    super(reason === "published"
      ? "Published assets must be explicitly unpublished before they can be archived"
      : "Assets referenced by an active page cannot be archived");
    this.name = "AssetArchiveConflictError";
  }
}

function activePublicationBlocked(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; message?: unknown };
  return candidate.code === "23514"
    && candidate.message === "an actively published v2 asset cannot be archived or deleted";
}

export type AssetMetadata = {
  object_id: string;
  public_id: string | null;
  filename: string;
  content_type: string;
  size_bytes: string;
  content_hash: string;
  width: number | null;
  height: number | null;
  duration_seconds: string | null;
  created_at: Date | string;
  deleted_at: Date | string | null;
};

/** Explicit internal storage handoff; API/catalog projections return only `object`. */
export type AssetCreateResult = {
  object: AssetMetadata;
  storage: { blob_key: string };
};

export type AssetStorageBlob = {
  object_id: string;
  blob_key: string;
  filename: string;
  content_type: string;
  size_bytes: string;
  content_hash: string;
};

export type DeletedAssetStorageBlob = {
  object_id: string;
  blob_key: string;
};

async function transaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
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

const ASSET_COLUMNS = `asset.id AS document_id,resource.public_id,
    asset.filename,asset.content_type,asset.size_bytes,asset.content_hash,
    asset.width,asset.height,asset.duration_seconds,
    asset.created_at,asset.deleted_at`;

const ASSET_FROM = `
  FROM assets asset
  JOIN hypermedia_documents document
    ON document.id=asset.id
   AND document.authority='knowledge'
   AND document.representation='asset'
  LEFT JOIN public_resources resource ON resource.document_id=asset.id
`;

const ASSET_SELECT = `SELECT ${ASSET_COLUMNS}${ASSET_FROM}`;
const ASSET_STORAGE_SELECT = `
  SELECT asset.id AS document_id,asset.s3_object_key AS object_key,
    asset.filename,asset.content_type,asset.size_bytes,asset.content_hash
  FROM assets asset
  JOIN hypermedia_documents document
    ON document.id=asset.id
   AND document.authority='knowledge'
   AND document.representation='asset'
`;

type AssetDatabaseRow = Omit<AssetMetadata, "object_id" | "size_bytes" | "duration_seconds"> & {
  document_id: string;
  size_bytes: number | string;
  duration_seconds: number | string | null;
};
type AssetStorageRow = Omit<AssetStorageBlob, "object_id" | "blob_key" | "size_bytes"> & {
  document_id: string;
  object_key: string;
  size_bytes: number | string;
};

function normalizeAsset(row: AssetDatabaseRow): AssetMetadata {
  const { document_id, ...metadata } = row;
  return {
    ...metadata,
    object_id: document_id,
    size_bytes: String(row.size_bytes),
    duration_seconds: row.duration_seconds === null ? null : String(row.duration_seconds),
  };
}

export class AssetRepository {
  constructor(private readonly pool: Pool) {}

  async create(input: CreateAssetInput): Promise<AssetCreateResult> {
    const objectId = randomUUID();
    const blobKey = `blobs/${objectId}`;
    return transaction(this.pool, async (client) => {
      const result = await client.query<AssetDatabaseRow>(
        `INSERT INTO assets(
           id,filename,content_type,size_bytes,content_hash,
           s3_object_key,width,height,duration_seconds
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING id AS document_id,NULL::uuid AS public_id,
           filename,content_type,size_bytes,content_hash,
           width,height,duration_seconds,
           created_at,deleted_at`,
        [objectId, input.filename, input.content_type,
          input.size_bytes, input.sha256, blobKey,
          input.width ?? null, input.height ?? null, input.duration_seconds ?? null],
      );
      return {
        object: normalizeAsset(result.rows[0]!),
        storage: { blob_key: blobKey },
      };
    });
  }

  async get(objectId: string, options: { include_deleted?: boolean } = {}): Promise<AssetMetadata | null> {
    const result = await this.pool.query<AssetDatabaseRow>(
      `${ASSET_SELECT}
       WHERE asset.id=$1 ${options.include_deleted ? "" : "AND asset.deleted_at IS NULL"}`,
      [objectId],
    );
    return result.rows[0] ? normalizeAsset(result.rows[0]) : null;
  }

  /**
   * Exact private byte locator for the isolated storage capability route.
   * Keep this projection independent of publication metadata: the storage role
   * deliberately cannot map public identifiers back to private documents.
   */
  async getForStorage(objectId: string): Promise<AssetStorageBlob | null> {
    const result = await this.pool.query<AssetStorageRow>(
      `${ASSET_STORAGE_SELECT} WHERE asset.id=$1 AND asset.deleted_at IS NULL`,
      [objectId],
    );
    const row = result.rows[0];
    if (!row) return null;
    const { document_id, object_key, ...metadata } = row;
    return {
      ...metadata,
      object_id: document_id,
      blob_key: object_key,
      size_bytes: String(row.size_bytes),
    };
  }

  /** Exact deleted byte locator used only by the isolated storage cleanup boundary. */
  async getDeletedForStorage(objectId: string): Promise<DeletedAssetStorageBlob | null> {
    const result = await this.pool.query<{ document_id: string; object_key: string }>(
      `SELECT asset.id AS document_id,asset.s3_object_key AS object_key
       FROM assets asset
       JOIN hypermedia_documents document
         ON document.id=asset.id
        AND document.authority='knowledge'
        AND document.representation='asset'
       WHERE asset.id=$1 AND asset.deleted_at IS NOT NULL`,
      [objectId],
    );
    const row = result.rows[0];
    return row ? { object_id: row.document_id, blob_key: row.object_key } : null;
  }

  async list(): Promise<AssetMetadata[]> {
    const result = await this.pool.query<AssetDatabaseRow>(
      `${ASSET_SELECT}
       WHERE asset.deleted_at IS NULL
       ORDER BY asset.created_at,asset.id`,
    );
    return result.rows.map(normalizeAsset);
  }

  async delete(objectId: string): Promise<string | null> {
    return transaction(this.pool, async (client) => {
      const selected = await client.query<{ s3_object_key: string }>(
        `SELECT asset.s3_object_key
         FROM assets asset
         WHERE asset.id=$1 AND asset.deleted_at IS NULL
           AND NOT EXISTS (
             SELECT 1
             FROM public_resources resource
             JOIN asset_publications publication ON publication.public_id=resource.public_id
             WHERE resource.document_id=asset.id
           )
         FOR UPDATE`,
        [objectId],
      );
      if (!selected.rows[0]) return null;
      const referenced = await client.query(
        `SELECT 1
         FROM knowledge_pages page
         WHERE page.archived_at IS NULL AND EXISTS (
           SELECT 1 FROM document_links link
           WHERE link.source_revision_id=page.current_version_id
             AND link.target_document_id=$1
           UNION ALL
           SELECT 1 FROM knowledge_asset_links link
           WHERE link.source_version_id=page.current_version_id
             AND link.target_asset_id=$1
         )
         LIMIT 1`,
        [objectId],
      );
      if (referenced.rowCount) return null;
      if ((await client.query(
        `SELECT 1 FROM knowledge_export_intents
         WHERE download_started_at IS NOT NULL AND expires_at>now() LIMIT 1`,
      )).rowCount) return null;
      const deleted = await client.query<{ s3_object_key: string }>(
        `UPDATE assets SET deleted_at=now()
         WHERE id=$1 AND deleted_at IS NULL
         RETURNING s3_object_key`,
        [objectId],
      );
      if (!deleted.rows[0]) return null;
      await client.query("UPDATE hypermedia_documents SET updated_at=now() WHERE id=$1", [objectId]);
      return deleted.rows[0].s3_object_key;
    });
  }

  async archive(input: ArchiveAssetInput): Promise<AssetMetadata | null> {
    const objectId = input.object_id;
    return transaction(this.pool, async (client) => {
      const selected = await client.query(
        `SELECT 1 FROM assets asset
         WHERE asset.id=$1 AND asset.deleted_at IS NULL
         FOR UPDATE OF asset`,
        [objectId],
      );
      if (!selected.rowCount) {
        const existing = await client.query<AssetDatabaseRow>(
          `${ASSET_SELECT} WHERE asset.id=$1`,
          [objectId],
        );
        return existing.rows[0] ? normalizeAsset(existing.rows[0]) : null;
      }
      const referenced = await client.query(
        `SELECT 1
         FROM knowledge_pages page
         WHERE page.archived_at IS NULL AND EXISTS (
           SELECT 1 FROM document_links link
           WHERE link.source_revision_id=page.current_version_id
             AND link.target_document_id=$1
           UNION ALL
           SELECT 1 FROM knowledge_asset_links link
           WHERE link.source_version_id=page.current_version_id
             AND link.target_asset_id=$1
         )
         LIMIT 1`,
        [objectId],
      );
      if (referenced.rowCount) throw new AssetArchiveConflictError("referenced");
      try {
        await client.query(
          "UPDATE assets SET deleted_at=now() WHERE id=$1 AND deleted_at IS NULL",
          [objectId],
        );
      } catch (error) {
        if (activePublicationBlocked(error)) throw new AssetArchiveConflictError("published");
        throw error;
      }
      await client.query(
        "UPDATE hypermedia_documents SET updated_at=now() WHERE id=$1",
        [objectId],
      );
      const result = await client.query<AssetDatabaseRow>(
        `${ASSET_SELECT} WHERE asset.id=$1`,
        [objectId],
      );
      return result.rows[0] ? normalizeAsset(result.rows[0]) : null;
    });
  }
}
