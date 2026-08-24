import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type {
  ArchiveDocumentAssetInput,
  CreateDocumentAssetInput,
} from "@context-use/shared";
import { AssetArchiveConflictError } from "./assets.ts";

export type DocumentAsset = {
  document_id: string;
  public_id: string | null;
  filename: string;
  content_type: string;
  size_bytes: string;
  content_hash: string;
  width: number | null;
  height: number | null;
  duration_seconds: string | null;
  legacy_published: boolean;
  created_at: Date | string;
  deleted_at: Date | string | null;
};

/** Explicit internal storage handoff; API/catalog projections return only `document`. */
export type DocumentAssetCreateResult = {
  document: DocumentAsset;
  storage: { object_key: string };
};

export type DocumentAssetStorageObject = DocumentAsset & {
  object_key: string;
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

function compatibilityPath(): string {
  return `pathless-asset-${randomUUID()}`;
}

const ASSET_COLUMNS = `asset.id AS document_id,resource.public_id,
    asset.filename,asset.content_type,asset.size_bytes,asset.content_hash,
    asset.width,asset.height,asset.duration_seconds,
    asset.public_path IS NOT NULL AS legacy_published,
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
  SELECT ${ASSET_COLUMNS},asset.s3_object_key AS object_key${ASSET_FROM}
`;

type DocumentAssetDatabaseRow = Omit<DocumentAsset, "size_bytes" | "duration_seconds"> & {
  size_bytes: number | string;
  duration_seconds: number | string | null;
};
type DocumentAssetStorageRow = DocumentAssetDatabaseRow & { object_key: string };

function normalizeAsset(row: DocumentAssetDatabaseRow): DocumentAsset {
  return {
    ...row,
    size_bytes: String(row.size_bytes),
    duration_seconds: row.duration_seconds === null ? null : String(row.duration_seconds),
  };
}

export class DocumentAssetRepository {
  constructor(private readonly pool: Pool) {}

  async create(input: CreateDocumentAssetInput): Promise<DocumentAssetCreateResult> {
    const documentId = randomUUID();
    const objectKey = `objects/${documentId}`;
    const path = compatibilityPath();
    return transaction(this.pool, async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock_shared(hashtextextended('filesystem-hypermedia-corpus-transition',0))",
      );
      const result = await client.query<DocumentAssetDatabaseRow>(
        `INSERT INTO assets(
           id,current_path,filename,content_type,size_bytes,content_hash,
           s3_object_key,width,height,duration_seconds
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING id AS document_id,NULL::uuid AS public_id,
           filename,content_type,size_bytes,content_hash,
           width,height,duration_seconds,false AS legacy_published,
           created_at,deleted_at`,
        [documentId, path, input.filename, input.content_type,
          input.size_bytes, input.sha256, objectKey,
          input.width ?? null, input.height ?? null, input.duration_seconds ?? null],
      );
      return {
        document: normalizeAsset(result.rows[0]!),
        storage: { object_key: objectKey },
      };
    });
  }

  async get(documentId: string, options: { include_deleted?: boolean } = {}): Promise<DocumentAsset | null> {
    const result = await this.pool.query<DocumentAssetDatabaseRow>(
      `${ASSET_SELECT}
       WHERE asset.id=$1 ${options.include_deleted ? "" : "AND asset.deleted_at IS NULL"}`,
      [documentId],
    );
    return result.rows[0] ? normalizeAsset(result.rows[0]) : null;
  }

  /** Exact private byte locator for the isolated MCP storage capability route. */
  async getForStorage(documentId: string): Promise<DocumentAssetStorageObject | null> {
    const result = await this.pool.query<DocumentAssetStorageRow>(
      `${ASSET_STORAGE_SELECT} WHERE asset.id=$1`,
      [documentId],
    );
    const row = result.rows[0];
    if (!row) return null;
    const { object_key, ...asset } = row;
    return { ...normalizeAsset(asset), object_key };
  }

  async archive(input: ArchiveDocumentAssetInput): Promise<DocumentAsset | null> {
    const documentId = input.asset_id;
    return transaction(this.pool, async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock_shared(hashtextextended('filesystem-hypermedia-corpus-transition',0))",
      );
      const selected = await client.query<{ public_path: string | null }>(
        `SELECT public_path FROM assets
         WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`,
        [documentId],
      );
      if (!selected.rowCount) {
        const existing = await client.query<DocumentAssetDatabaseRow>(
          `${ASSET_SELECT} WHERE asset.id=$1`,
          [documentId],
        );
        return existing.rows[0] ? normalizeAsset(existing.rows[0]) : null;
      }
      if (selected.rows[0]!.public_path !== null) {
        throw new AssetArchiveConflictError("published");
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
        [documentId],
      );
      if (referenced.rowCount) throw new AssetArchiveConflictError("referenced");
      await client.query(
        "UPDATE assets SET deleted_at=now() WHERE id=$1 AND deleted_at IS NULL",
        [documentId],
      );
      await client.query(
        "UPDATE hypermedia_documents SET updated_at=now() WHERE id=$1",
        [documentId],
      );
      const result = await client.query<DocumentAssetDatabaseRow>(
        `${ASSET_SELECT} WHERE asset.id=$1`,
        [documentId],
      );
      return result.rows[0] ? normalizeAsset(result.rows[0]) : null;
    });
  }
}
