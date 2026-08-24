import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  markdownObjectMetadata,
  type MarkdownObjectMetadata,
  type MarkdownObjectStore,
} from "./documents.ts";
import { matchesReleasedV0_1_84Ledger } from "./migration-state.ts";

const MIGRATION_LOCK = "context-use:migrate";
const UPGRADE_ACTOR = "context-use-v0.1.84-directory-upgrade/v1";
const UPGRADE_COMMIT_MESSAGE = "Preserve legacy directory metadata";
const EMPTY_MARKDOWN = "";

type ReleasedV084Directory = {
  id: string;
  current_path: string;
  title: string;
  summary: string;
  created_at: Date | string;
  updated_at: Date | string;
  document_exists: boolean;
  page_exists: boolean;
  public_prefix_exists: boolean;
};

export type ReleasedV084DirectoryUpgradeResult = {
  applicable: boolean;
  converted: number;
};

const BLOCKING_DIRECTORIES = `
  SELECT directory.id::text,directory.current_path,directory.title,directory.summary,
    directory.created_at,directory.updated_at,
    (document.id IS NOT NULL) AS document_exists,
    (page.id IS NOT NULL) AS page_exists,
    EXISTS (
      SELECT 1 FROM legacy_public_directory_prefixes prefix
      WHERE prefix.directory_id=directory.id
    ) AS public_prefix_exists
  FROM knowledge_directories directory
  LEFT JOIN hypermedia_documents document
    ON document.id=directory.id AND document.authority='knowledge'
   AND document.representation='markdown'
  LEFT JOIN knowledge_pages page ON page.id=directory.id
  WHERE (document.id IS NULL OR page.id IS NULL)
    AND NOT (
      directory.current_path IN ('','automations','skills')
      AND NOT EXISTS (
        SELECT 1 FROM knowledge_pages child
        WHERE child.current_path=directory.current_path
           OR child.current_path LIKE CASE WHEN directory.current_path=''
             THEN '%' ELSE directory.current_path||'/%' END
      )
      AND NOT EXISTS (
        SELECT 1 FROM assets child
        WHERE child.current_path=directory.current_path
           OR child.current_path LIKE CASE WHEN directory.current_path=''
             THEN '%' ELSE directory.current_path||'/%' END
      )
    )
  ORDER BY directory.current_path COLLATE "C",directory.id
`;

/** Stable private revision identity for the one released-ledger repair. */
export function releasedV084DirectoryRevisionId(directoryId: string): string {
  const hex = createHash("sha256")
    .update(`context-use:released-v0.1.84-directory:${directoryId.toLowerCase()}`)
    .digest("hex")
    .slice(0, 32)
    .split("");
  // RFC 9562 UUIDv8: deterministic application-defined payload, RFC variant.
  hex[12] = "8";
  hex[16] = "8";
  const value = hex.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function assertStoredEmptyBody(
  revisionId: string,
  stored: MarkdownObjectMetadata,
): void {
  const expected = markdownObjectMetadata(revisionId, EMPTY_MARKDOWN);
  if (stored.body_object_key !== expected.body_object_key
      || stored.body_size_bytes !== expected.body_size_bytes
      || stored.body_content_hash !== expected.body_content_hash) {
    throw new Error("Released v0.1.84 directory upgrade storage metadata changed");
  }
}

async function lockedDirectory(
  client: PoolClient,
  directoryId: string,
): Promise<ReleasedV084Directory | undefined> {
  const result = await client.query<ReleasedV084Directory>(
    `SELECT directory.id::text,directory.current_path,directory.title,directory.summary,
       directory.created_at,directory.updated_at,
       EXISTS (SELECT 1 FROM hypermedia_documents document
         WHERE document.id=directory.id AND document.authority='knowledge'
           AND document.representation='markdown') AS document_exists,
       EXISTS (SELECT 1 FROM knowledge_pages page
         WHERE page.id=directory.id) AS page_exists,
       EXISTS (SELECT 1 FROM legacy_public_directory_prefixes prefix
         WHERE prefix.directory_id=directory.id) AS public_prefix_exists
     FROM knowledge_directories directory
     WHERE directory.id=$1
     FOR UPDATE OF directory`,
    [directoryId],
  );
  return result.rows[0];
}

async function convertDirectory(
  client: PoolClient,
  bodies: MarkdownObjectStore,
  candidate: ReleasedV084Directory,
): Promise<boolean> {
  const revisionId = releasedV084DirectoryRevisionId(candidate.id);
  const stored = await bodies.write(revisionId, EMPTY_MARKDOWN);
  assertStoredEmptyBody(revisionId, stored);

  await client.query("BEGIN");
  try {
    await client.query("SET CONSTRAINTS ALL DEFERRED");
    const directory = await lockedDirectory(client, candidate.id);
    if (!directory) {
      throw new Error(`Released v0.1.84 directory disappeared during upgrade: ${candidate.id}`);
    }
    if (directory.public_prefix_exists) {
      throw new Error(
        `Released v0.1.84 public directory requires immutable publication evidence: ${candidate.id}`,
      );
    }
    if (directory.document_exists !== directory.page_exists) {
      throw new Error(
        `Released v0.1.84 directory has partial canonical state: ${candidate.id}`,
      );
    }
    if (directory.document_exists) {
      await client.query("COMMIT");
      return false;
    }

    await client.query(
      `INSERT INTO hypermedia_documents(
         id,authority,representation,created_at,updated_at
       ) VALUES ($1,'knowledge','markdown',$2,$3)`,
      [directory.id, directory.created_at, directory.updated_at],
    );
    await client.query(
      `INSERT INTO hypermedia_document_revisions(
         id,document_id,revision_number,body_object_key,body_size_bytes,
         body_content_hash,created_at
       ) VALUES ($1,$2,1,$3,$4,$5,$6)`,
      [revisionId, directory.id, stored.body_object_key,
        stored.body_size_bytes, stored.body_content_hash, directory.updated_at],
    );
    await client.query(
      `INSERT INTO knowledge_pages(
         id,current_path,current_version_id,created_at,updated_at,search_vector
       ) VALUES ($1,NULL,$2,$3,$4,''::tsvector)`,
      [directory.id, revisionId, directory.created_at, directory.updated_at],
    );
    await client.query(
      `INSERT INTO knowledge_page_versions(
         id,page_id,version_number,path,title,summary,commit_message,
         actor_kind,actor_subject,created_at
       ) VALUES ($1,$2,1,NULL,$3,$4,$5,'dashboard',$6,$7)`,
      [revisionId, directory.id, directory.title, directory.summary,
        UPGRADE_COMMIT_MESSAGE, UPGRADE_ACTOR, directory.updated_at],
    );
    await client.query(
      "SELECT register_generic_knowledge_revision($1,$2,'{}'::uuid[])",
      [revisionId, EMPTY_MARKDOWN],
    );
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

/**
 * Materialize only the directory metadata stranded by the exact v0.1.84
 * release. Every other migration ledger is intentionally a no-op.
 */
export async function prepareReleasedV084DirectoryUpgrade(
  pool: Pool,
  bodies: MarkdownObjectStore,
): Promise<ReleasedV084DirectoryUpgradeResult> {
  const client = await pool.connect();
  try {
    const migrations = await client.query<{ relation: string | null }>(
      "SELECT to_regclass('public.schema_migrations')::text AS relation",
    );
    if (!migrations.rows[0]?.relation) return { applicable: false, converted: 0 };
    await client.query(
      "SELECT pg_advisory_lock(hashtextextended($1,0))",
      [MIGRATION_LOCK],
    );
    try {
      const ledger = await client.query<{ version: string; checksum: string | null }>(
        "SELECT version,checksum FROM schema_migrations ORDER BY version",
      );
      if (!matchesReleasedV0_1_84Ledger(ledger.rows)) {
        return { applicable: false, converted: 0 };
      }
      const candidates = await client.query<ReleasedV084Directory>(BLOCKING_DIRECTORIES);
      const publicCandidate = candidates.rows.find(({ public_prefix_exists }) => public_prefix_exists);
      if (publicCandidate) {
        throw new Error(
          `Released v0.1.84 public directory requires immutable publication evidence: ${publicCandidate.id}`,
        );
      }
      const partialCandidate = candidates.rows.find(
        ({ document_exists, page_exists }) => document_exists !== page_exists,
      );
      if (partialCandidate) {
        throw new Error(
          `Released v0.1.84 directory has partial canonical state: ${partialCandidate.id}`,
        );
      }

      let converted = 0;
      for (const candidate of candidates.rows) {
        if (await convertDirectory(client, bodies, candidate)) converted += 1;
      }
      const remaining = await client.query<ReleasedV084Directory>(BLOCKING_DIRECTORIES);
      if (remaining.rows.length) {
        throw new Error(
          `Released v0.1.84 directory upgrade left ${remaining.rows.length} filesystem blockers`,
        );
      }
      return { applicable: true, converted };
    } finally {
      await client.query(
        "SELECT pg_advisory_unlock(hashtextextended($1,0))",
        [MIGRATION_LOCK],
      );
    }
  } finally {
    client.release();
  }
}
