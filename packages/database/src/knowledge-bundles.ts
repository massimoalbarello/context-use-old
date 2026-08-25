import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";

export const KNOWLEDGE_BUNDLE_FORMAT = "context-use-knowledge-bundle" as const;
export const KNOWLEDGE_BUNDLE_VERSION = 1 as const;
export const KNOWLEDGE_BUNDLE_PART_SIZE = 8 * 1024 * 1024;
export const KNOWLEDGE_BUNDLE_DATASETS = [
  "hypermedia_documents", "knowledge_pages", "assets", "hypermedia_document_revisions",
  "knowledge_page_versions", "source_records", "knowledge_page_changes",
  "knowledge_revision_contracts", "document_links", "knowledge_asset_links",
  "knowledge_search", "knowledge_search_chunks", "source_record_search_chunks",
  "knowledge_settings", "automation_registry", "hypermedia_bootstrap_allocations",
  "publication_intent_id_reservations", "public_artifact_id_reservations",
  "public_representation_token_reservations", "publication_intents",
  "publication_artifact_staging", "publication_object_claims", "public_resources",
  "retained_page_artifacts", "public_page_artifacts", "public_asset_artifacts",
  "page_publications", "asset_publications", "public_route_aliases",
  "public_visibility_generations", "publication_target_generations",
  "public_namespace_conflicts", "publication_settings",
] as const;

export type KnowledgeBundlePrincipal = { ownerUserId: string; sessionId: string };

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

export type KnowledgeBundleExportRecord = {
  dataset: string;
  ordinal: number | string;
  record: Record<string, unknown>;
};

/** A stored byte payload. Wire-format v1 retains `object_*` frame field names. */
export type KnowledgeBundleBlob = {
  ordinal: number | string;
  blob_kind: "private_revision" | "asset" | "retained_page" | "public_page" | "public_asset";
  blob_key: string;
  size_bytes: number | string;
  content_hash: string;
  content_type: string;
};

export type KnowledgeBundleExportStatus = {
  intent_id: string;
  status: "pending" | "snapshotting" | "processing" | "ready" | "failed";
  phase: string;
  records_completed: number | string;
  records_total: number | string;
  objects_completed: number | string;
  objects_total: number | string;
  bytes_completed: number | string;
  bytes_total: number | string;
  bundle_size_bytes: number | string | null;
  bundle_sha256: string | null;
  error_code: string | null;
  error_message: string | null;
  updated_at: Date | string;
};

export type KnowledgeBundleImportStatus = {
  id: string;
  owner_user_id: string;
  session_id: string;
  filename: string;
  total_bytes: number | string;
  part_size: number;
  total_parts: number;
  status: "uploading" | "validating" | "awaiting_confirmation" | "restoring" | "complete" | "failed";
  phase: string;
  parts_completed: number;
  records_completed: number | string;
  records_total: number | string;
  objects_completed: number | string;
  objects_total: number | string;
  bytes_completed: number | string;
  bytes_total: number | string;
  manifest: Record<string, unknown> | null;
  error_code: string | null;
  error_message: string | null;
  expires_at: Date | string;
  confirmed_at: Date | string | null;
  consumed_at: Date | string | null;
  updated_at: Date | string;
};

export type KnowledgeBundleImportPart = {
  part_number: number;
  object_key: string;
  size_bytes: number;
  content_hash: string;
};

export type KnowledgeBundleImportBlobAuthorization = KnowledgeBundleBlob & {
  import_id: string;
  confirmed_at: Date | string;
  expires_at: Date | string;
  status: string;
};

export class KnowledgeBundleRepository {
  constructor(private readonly pool: Pool) {}

  async createExportIntent(principal: KnowledgeBundlePrincipal) {
    return transaction(this.pool, async (client) => {
      const discarded = await client.query<{ id: string }>(
        `DELETE FROM knowledge_export_intents
         WHERE expires_at <= now()
            OR (owner_user_id=$1 AND session_id=$2 AND download_started_at IS NULL)
         RETURNING id`,
        [principal.ownerUserId, principal.sessionId],
      );
      const id = randomUUID();
      const inserted = await client.query<{ expires_at: Date }>(
        `INSERT INTO knowledge_export_intents(id,owner_user_id,session_id,expires_at)
         VALUES ($1,$2,$3,now()+interval '5 minutes') RETURNING expires_at`,
        [id, principal.ownerUserId, principal.sessionId],
      );
      const summary = await client.query<{
        page_count: string;
        asset_count: string;
        estimated_bytes: string;
      }>(
        `SELECT page_count::text,asset_count::text,estimated_bytes::text
         FROM full_knowledge_bundle_summary()`,
      );
      await client.query("INSERT INTO knowledge_bundle_exports(intent_id) VALUES ($1)", [id]);
      return {
        id,
        expires_at: inserted.rows[0]!.expires_at,
        page_count: Number(summary.rows[0]!.page_count),
        asset_count: Number(summary.rows[0]!.asset_count),
        estimated_bytes: Number(summary.rows[0]!.estimated_bytes),
        discarded_export_ids: discarded.rows.map(({ id: discardedId }) => discardedId),
      };
    });
  }

  async exportIntent(id: string) {
    const result = await this.pool.query<{
      id: string;
      owner_user_id: string;
      session_id: string;
      expires_at: Date;
      confirmed_at: Date | null;
      download_started_at: Date | null;
    }>(
      `SELECT intent.id,intent.owner_user_id,intent.session_id,intent.expires_at,
         intent.confirmed_at,intent.download_started_at
       FROM knowledge_export_intents intent
       JOIN knowledge_bundle_exports bundle ON bundle.intent_id=intent.id
       WHERE intent.id=$1`,
      [id],
    );
    return result.rows[0] ?? null;
  }

  async discardExportIntent(id: string, principal: KnowledgeBundlePrincipal): Promise<void> {
    await this.pool.query(
      `DELETE FROM knowledge_export_intents
       WHERE id=$1 AND owner_user_id=$2 AND session_id=$3 AND confirmed_at IS NULL`,
      [id, principal.ownerUserId, principal.sessionId],
    );
  }

  async acceptsFullImport(): Promise<boolean> {
    const result = await this.pool.query<{ fresh: boolean }>(
      "SELECT full_knowledge_import_available() AS fresh",
    );
    return result.rows[0]?.fresh === true;
  }

  async captureExport(intentId: string, principal: KnowledgeBundlePrincipal): Promise<{
    records: number;
    objects: number;
    bytes: number;
  }> {
    const result = await this.pool.query<{ capture_full_knowledge_bundle: {
      records: number;
      objects: number;
      bytes: number;
    } }>("SELECT capture_full_knowledge_bundle($1,$2,$3)", [
      intentId, principal.ownerUserId, principal.sessionId,
    ]);
    return result.rows[0]!.capture_full_knowledge_bundle;
  }

  async exportStatus(intentId: string): Promise<KnowledgeBundleExportStatus | null> {
    const result = await this.pool.query<KnowledgeBundleExportStatus>(
      "SELECT * FROM knowledge_bundle_exports WHERE intent_id=$1",
      [intentId],
    );
    return result.rows[0] ?? null;
  }

  async exportRecords(intentId: string, dataset: string, after: number, limit = 500): Promise<KnowledgeBundleExportRecord[]> {
    const result = await this.pool.query<KnowledgeBundleExportRecord>(
      `SELECT dataset,ordinal,record FROM knowledge_bundle_export_records
       WHERE intent_id=$1 AND dataset=$2 AND ordinal>$3
       ORDER BY ordinal LIMIT $4`,
      [intentId, dataset, after, limit],
    );
    return result.rows;
  }

  async exportDatasets(intentId: string): Promise<Array<{ dataset: string; record_count: number }>> {
    const result = await this.pool.query<{ dataset: string; record_count: string }>(
      `SELECT dataset,count(*)::text AS record_count
       FROM knowledge_bundle_export_records WHERE intent_id=$1
       GROUP BY dataset ORDER BY dataset`,
      [intentId],
    );
    const counts = new Map(result.rows.map((row) => [row.dataset, Number(row.record_count)]));
    return KNOWLEDGE_BUNDLE_DATASETS.map((dataset) => ({
      dataset,
      record_count: counts.get(dataset) ?? 0,
    }));
  }

  async exportBlobs(intentId: string, after: number, limit = 100): Promise<KnowledgeBundleBlob[]> {
    const result = await this.pool.query<KnowledgeBundleBlob>(
      `SELECT ordinal,object_kind AS blob_kind,object_key AS blob_key,
         size_bytes,content_hash,content_type
       FROM knowledge_bundle_export_objects
       WHERE intent_id=$1 AND ordinal>$2 ORDER BY ordinal LIMIT $3`,
      [intentId, after, limit],
    );
    return result.rows;
  }

  async updateExportProgress(intentId: string, input: {
    phase: string;
    recordsCompleted: number;
    objectsCompleted: number;
    bytesCompleted: number;
  }): Promise<void> {
    await this.pool.query(
      `UPDATE knowledge_bundle_exports SET phase=$2,records_completed=$3,
         objects_completed=$4,bytes_completed=$5,updated_at=now()
       WHERE intent_id=$1 AND status='processing'`,
      [intentId, input.phase, input.recordsCompleted, input.objectsCompleted, input.bytesCompleted],
    );
  }

  async completeExport(intentId: string, sizeBytes: number, contentHash: string): Promise<void> {
    await this.pool.query(
      `UPDATE knowledge_bundle_exports SET status='ready',phase='complete',
         records_completed=records_total,objects_completed=objects_total,
         bytes_completed=bytes_total,bundle_size_bytes=$2,bundle_sha256=$3,
         updated_at=now() WHERE intent_id=$1`,
      [intentId, sizeBytes, contentHash],
    );
  }

  async failExport(intentId: string, code: string, message: string): Promise<void> {
    await this.pool.query(
      `UPDATE knowledge_bundle_exports SET status='failed',phase='failed',
         error_code=$2,error_message=$3,updated_at=now() WHERE intent_id=$1`,
      [intentId, code, message],
    );
  }

  async createImport(principal: KnowledgeBundlePrincipal, input: {
    filename: string;
    totalBytes: number;
    partSize?: number;
  }): Promise<KnowledgeBundleImportStatus> {
    const id = randomUUID();
    const partSize = input.partSize ?? KNOWLEDGE_BUNDLE_PART_SIZE;
    const totalParts = Math.ceil(input.totalBytes / partSize);
    const result = await this.pool.query<KnowledgeBundleImportStatus>(
      `INSERT INTO knowledge_bundle_imports(
         id,owner_user_id,session_id,filename,total_bytes,part_size,total_parts,bytes_total
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$5) RETURNING *`,
      [id, principal.ownerUserId, principal.sessionId, input.filename,
        input.totalBytes, partSize, totalParts],
    );
    return result.rows[0]!;
  }

  async importStatus(id: string): Promise<KnowledgeBundleImportStatus | null> {
    const result = await this.pool.query<KnowledgeBundleImportStatus>(
      "SELECT * FROM knowledge_bundle_imports WHERE id=$1",
      [id],
    );
    return result.rows[0] ?? null;
  }

  async importParts(id: string): Promise<KnowledgeBundleImportPart[]> {
    const result = await this.pool.query<KnowledgeBundleImportPart>(
      `SELECT part_number,object_key,size_bytes,content_hash
       FROM knowledge_bundle_import_parts WHERE import_id=$1 ORDER BY part_number`,
      [id],
    );
    return result.rows;
  }

  async recordImportPart(id: string, part: KnowledgeBundleImportPart): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const job = await client.query<{ total_parts: number; status: string }>(
        "SELECT total_parts,status FROM knowledge_bundle_imports WHERE id=$1 FOR UPDATE",
        [id],
      );
      if (job.rows[0]?.status !== "uploading" || part.part_number >= job.rows[0]!.total_parts) {
        throw new Error("Knowledge bundle import is not accepting this part");
      }
      const existing = await client.query<KnowledgeBundleImportPart>(
        `SELECT part_number,object_key,size_bytes,content_hash
         FROM knowledge_bundle_import_parts WHERE import_id=$1 AND part_number=$2`,
        [id, part.part_number],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].size_bytes !== part.size_bytes
            || existing.rows[0].content_hash !== part.content_hash
            || existing.rows[0].object_key !== part.object_key) {
          throw new Error("Knowledge bundle import part conflicts with the uploaded part");
        }
      } else {
        await client.query(
          `INSERT INTO knowledge_bundle_import_parts(
             import_id,part_number,object_key,size_bytes,content_hash
           ) VALUES ($1,$2,$3,$4,$5)`,
          [id, part.part_number, part.object_key, part.size_bytes, part.content_hash],
        );
      }
      await client.query(
        `UPDATE knowledge_bundle_imports job SET
           parts_completed=parts.count,bytes_completed=parts.bytes,updated_at=now()
         FROM (SELECT count(*)::integer count,coalesce(sum(size_bytes),0)::bigint bytes
           FROM knowledge_bundle_import_parts WHERE import_id=$1) parts
         WHERE job.id=$1`,
        [id],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async beginImportValidation(id: string, principal: KnowledgeBundlePrincipal): Promise<void> {
    const result = await this.pool.query(
      `UPDATE knowledge_bundle_imports job SET status='validating',phase='manifest',
         records_completed=0,objects_completed=0,bytes_completed=0,updated_at=now()
       WHERE id=$1 AND owner_user_id=$2 AND session_id=$3 AND status='uploading'
         AND parts_completed=total_parts
         AND (SELECT coalesce(sum(size_bytes),0) FROM knowledge_bundle_import_parts
              WHERE import_id=job.id)=job.total_bytes`,
      [id, principal.ownerUserId, principal.sessionId],
    );
    if (result.rowCount !== 1) throw new Error("Knowledge bundle upload is incomplete");
    await Promise.all([
      this.pool.query("DELETE FROM knowledge_bundle_import_records WHERE import_id=$1", [id]),
      this.pool.query("DELETE FROM knowledge_bundle_import_objects WHERE import_id=$1", [id]),
    ]);
  }

  async insertImportRecords(id: string, records: KnowledgeBundleExportRecord[]): Promise<void> {
    if (!records.length) return;
    const values: unknown[] = [];
    const rows = records.map((record, index) => {
      const offset = index * 4;
      values.push(id, record.dataset, Number(record.ordinal), record.record);
      return `($${offset + 1},$${offset + 2},$${offset + 3},$${offset + 4})`;
    });
    await this.pool.query(
      `INSERT INTO knowledge_bundle_import_records(import_id,dataset,ordinal,record)
       VALUES ${rows.join(",")}`,
      values,
    );
  }

  async insertImportBlob(id: string, blob: KnowledgeBundleBlob): Promise<void> {
    await this.pool.query(
      `INSERT INTO knowledge_bundle_import_objects(
         import_id,ordinal,object_kind,object_key,size_bytes,content_hash,content_type
       ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, Number(blob.ordinal), blob.blob_kind, blob.blob_key,
        blob.size_bytes, blob.content_hash, blob.content_type],
    );
  }

  async updateImportProgress(id: string, input: {
    phase: string;
    recordsCompleted: number;
    objectsCompleted: number;
    bytesCompleted: number;
  }): Promise<void> {
    await this.pool.query(
      `UPDATE knowledge_bundle_imports SET phase=$2,records_completed=$3,
         objects_completed=$4,bytes_completed=$5,updated_at=now()
       WHERE id=$1 AND status IN ('validating','restoring')`,
      [id, input.phase, input.recordsCompleted, input.objectsCompleted, input.bytesCompleted],
    );
  }

  async finishImportValidation(id: string, manifest: Record<string, unknown>, input: {
    recordsTotal: number;
    objectsTotal: number;
    objectBytes: number;
  }): Promise<void> {
    const catalog = await this.pool.query<{ valid: boolean }>(
      `WITH expected AS (
         SELECT record->>'body_object_key' object_key,
           (record->>'body_size_bytes')::bigint size_bytes,
           record->>'body_content_hash' content_hash,
           'text/markdown; charset=utf-8'::text content_type
         FROM knowledge_bundle_import_records
         WHERE import_id=$1 AND dataset IN (
           'hypermedia_document_revisions','retained_page_artifacts','public_page_artifacts'
         )
         UNION ALL
         SELECT record->>'s3_object_key',(record->>'size_bytes')::bigint,
           record->>'content_hash',record->>'content_type'
         FROM knowledge_bundle_import_records
         WHERE import_id=$1 AND dataset='assets' AND record->>'deleted_at' IS NULL
         UNION ALL
         SELECT record->>'body_object_key',(record->>'body_size_bytes')::bigint,
           record->>'body_content_hash',record->>'public_content_type'
         FROM knowledge_bundle_import_records
         WHERE import_id=$1 AND dataset='public_asset_artifacts'
       ), distinct_expected AS (
         SELECT object_key,min(size_bytes) size_bytes,min(content_hash) content_hash,
           min(content_type) content_type,count(DISTINCT (size_bytes,content_hash,content_type)) variants
         FROM expected GROUP BY object_key
       )
       SELECT NOT EXISTS (
         SELECT 1 FROM distinct_expected expected
         LEFT JOIN knowledge_bundle_import_objects object
           ON object.import_id=$1 AND object.object_key=expected.object_key
          AND object.size_bytes=expected.size_bytes
          AND object.content_hash=expected.content_hash
          AND object.content_type=expected.content_type
         WHERE expected.variants<>1 OR object.object_key IS NULL
       ) AND NOT EXISTS (
         SELECT 1 FROM knowledge_bundle_import_objects object
         LEFT JOIN distinct_expected expected ON expected.object_key=object.object_key
         WHERE object.import_id=$1 AND expected.object_key IS NULL
       ) AS valid`,
      [id],
    );
    if (catalog.rows[0]?.valid !== true) {
      throw new Error("Knowledge bundle object catalog does not match its logical records");
    }
    await this.pool.query(
      `UPDATE knowledge_bundle_imports SET status='awaiting_confirmation',
         phase='authorization',manifest=$2,records_total=$3,objects_total=$4,
         bytes_total=$5,records_completed=$3,objects_completed=$4,
         bytes_completed=$5,updated_at=now()
       WHERE id=$1 AND status='validating'`,
      [id, manifest, input.recordsTotal, input.objectsTotal, input.objectBytes],
    );
  }

  async markImportBlobMaterialized(id: string, ordinal: number): Promise<void> {
    await this.pool.query(
      `UPDATE knowledge_bundle_import_objects SET materialized_at=now()
       WHERE import_id=$1 AND ordinal=$2`,
      [id, ordinal],
    );
  }

  async importBlobAuthorization(id: string, blobKey: string): Promise<KnowledgeBundleImportBlobAuthorization | null> {
    const result = await this.pool.query<KnowledgeBundleImportBlobAuthorization>(
      `SELECT object.import_id,object.ordinal,object.object_kind AS blob_kind,
         object.object_key AS blob_key,
         object.size_bytes,object.content_hash,object.content_type,
         job.confirmed_at,job.expires_at,job.status
       FROM knowledge_bundle_import_objects object
       JOIN knowledge_bundle_imports job ON job.id=object.import_id
       WHERE object.import_id=$1 AND object.object_key=$2`,
      [id, blobKey],
    );
    return result.rows[0] ?? null;
  }

  async restoreImport(id: string, principal: KnowledgeBundlePrincipal): Promise<Record<string, unknown>> {
    const result = await this.pool.query<{ restore_full_knowledge_bundle: Record<string, unknown> }>(
      "SELECT restore_full_knowledge_bundle($1,$2,$3)",
      [id, principal.ownerUserId, principal.sessionId],
    );
    return result.rows[0]!.restore_full_knowledge_bundle;
  }

  async failImport(id: string, code: string, message: string): Promise<void> {
    await this.pool.query(
      `UPDATE knowledge_bundle_imports SET status='failed',phase='failed',
         error_code=$2,error_message=$3,updated_at=now() WHERE id=$1`,
      [id, code, message],
    );
  }
}
