import { expect, test } from "bun:test";
import { Pool } from "pg";
import {
  markdownObjectMetadata,
  prepareReleasedV084DirectoryUpgrade,
  releasedV084DirectoryRevisionId,
  type MarkdownObjectMetadata,
  type MarkdownObjectStore,
} from "../src/index.ts";

const databaseUrl = process.env.TEST_RELEASED_V084_DIRECTORY_UPGRADE_DATABASE_URL;
const integrationTest = databaseUrl ? test : test.skip;
const DIRECTORY_ID = "4b815deb-8d1c-4d26-9b1b-8f9e405b12da";
const ROOT_ID = "d364bbef-209b-4519-b46e-c1f1f87a9765";
const CREATED_AT = "2025-04-05T06:07:08.000Z";
const UPDATED_AT = "2026-07-08T09:10:11.000Z";

class MemoryMarkdownObjectStore implements MarkdownObjectStore {
  readonly bodies = new Map<string, string>();

  async write(revisionId: string, markdown: string): Promise<MarkdownObjectMetadata> {
    this.bodies.set(revisionId, markdown);
    return markdownObjectMetadata(revisionId, markdown);
  }

  async read(metadata: MarkdownObjectMetadata): Promise<string> {
    const revisionId = metadata.body_object_key.slice(
      "documents/private/".length,
      -".md".length,
    );
    const body = this.bodies.get(revisionId);
    if (body === undefined) throw new Error("Missing in-memory Markdown object");
    return body;
  }
}

integrationTest("preserves released v0.1.84 directory metadata before filesystem removal", async () => {
  const pool = new Pool({ connectionString: databaseUrl! });
  const bodies = new MemoryMarkdownObjectStore();
  try {
    await pool.query(
      `INSERT INTO knowledge_directories(
         id,current_path,title,summary,search_vector,created_at,updated_at
       ) VALUES ($1,'','Knowledge','Private knowledge root',''::tsvector,$2,$3)
       ON CONFLICT (current_path) DO NOTHING`,
      [ROOT_ID, CREATED_AT, UPDATED_AT],
    );
    await pool.query(
      `INSERT INTO knowledge_directories(
         id,current_path,title,summary,search_vector,created_at,updated_at
       ) VALUES ($1,'retained-directory-metadata','Retained directory',
         'Authored summary that must survive filesystem removal',''::tsvector,$2,$3)`,
      [DIRECTORY_ID, CREATED_AT, UPDATED_AT],
    );

    const first = await prepareReleasedV084DirectoryUpgrade(pool, bodies);
    expect(first.applicable).toBe(true);
    expect(first.converted).toBeGreaterThanOrEqual(1);
    const revisionId = releasedV084DirectoryRevisionId(DIRECTORY_ID);
    expect(bodies.bodies.get(revisionId)).toBe("");

    const preserved = await pool.query<{
      title: string;
      summary: string;
      document_created_at: Date;
      document_updated_at: Date;
      page_created_at: Date;
      page_updated_at: Date;
      revision_created_at: Date;
      contract_revision_id: string | null;
      search_revision_id: string | null;
    }>(
      `SELECT version.title,version.summary,
         document.created_at AS document_created_at,
         document.updated_at AS document_updated_at,
         page.created_at AS page_created_at,page.updated_at AS page_updated_at,
         revision.created_at AS revision_created_at,
         contract.revision_id::text AS contract_revision_id,
         search.revision_id::text AS search_revision_id
       FROM hypermedia_documents document
       JOIN hypermedia_document_revisions revision
         ON revision.document_id=document.id
       JOIN knowledge_pages page
         ON page.id=document.id AND page.current_version_id=revision.id
       JOIN knowledge_page_versions version
         ON version.page_id=page.id AND version.id=revision.id
       LEFT JOIN knowledge_revision_contracts contract
         ON contract.document_id=document.id AND contract.revision_id=revision.id
       LEFT JOIN pathless_knowledge_search search
         ON search.document_id=document.id AND search.revision_id=revision.id
       WHERE document.id=$1`,
      [DIRECTORY_ID],
    );
    expect(preserved.rows[0]).toMatchObject({
      title: "Retained directory",
      summary: "Authored summary that must survive filesystem removal",
      contract_revision_id: revisionId,
      search_revision_id: revisionId,
    });
    expect(preserved.rows[0]?.document_created_at.toISOString()).toBe(CREATED_AT);
    expect(preserved.rows[0]?.document_updated_at.toISOString()).toBe(UPDATED_AT);
    expect(preserved.rows[0]?.page_created_at.toISOString()).toBe(CREATED_AT);
    expect(preserved.rows[0]?.page_updated_at.toISOString()).toBe(UPDATED_AT);
    expect(preserved.rows[0]?.revision_created_at.toISOString()).toBe(UPDATED_AT);

    const retry = await prepareReleasedV084DirectoryUpgrade(pool, bodies);
    expect(retry).toEqual({ applicable: true, converted: 0 });
  } finally {
    await pool.end();
  }
});
