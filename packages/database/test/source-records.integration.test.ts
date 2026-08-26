import { afterAll, describe, expect, test } from "bun:test";
import { Pool } from "pg";
import {
  ObjectLinkRepository,
  markdownBlobMetadata,
  SourceRecordRepository,
  type MarkdownBlobMetadata,
  type MarkdownBlobStore,
} from "../src/index.ts";
import { disposableDatabaseUrl } from "../src/disposable-database.ts";

const databaseUrl = await disposableDatabaseUrl();
const describeDatabase = databaseUrl ? describe : describe.skip;

class MemoryMarkdownStore implements MarkdownBlobStore {
  readonly bodies = new Map<string, string>();

  async write(revisionId: string, markdown: string): Promise<MarkdownBlobMetadata> {
    const metadata = markdownBlobMetadata(revisionId, markdown);
    this.bodies.set(metadata.body_object_key, markdown);
    return metadata;
  }

  async read(metadata: MarkdownBlobMetadata): Promise<string> {
    const body = this.bodies.get(metadata.body_object_key);
    if (body === undefined) throw new Error("missing body");
    return body;
  }
}

describeDatabase("object-backed source records", () => {
  const pool = new Pool({ connectionString: databaseUrl });

  afterAll(async () => pool.end());

  test("reconciles source-native identity and creates revisions only when Markdown changes", async () => {
    const connectionId = `connection-${crypto.randomUUID()}`;
    const store = new MemoryMarkdownStore();
    const records = new SourceRecordRepository(pool, store);
    const base = {
      integration: "github",
      connectionInstanceId: 101,
      connectionId,
      model: "GithubIssue",
      sourceRecordId: "issue-42",
      sourceCreatedAt: "2026-08-20T08:00:00.000Z",
    };
    try {
      const added = await records.write({
        ...base,
        action: "added",
        sourceUpdatedAt: "2026-08-20T08:00:00.000Z",
        markdown: "# Issue 42\n\nOpen.\n",
      });
      expect(added.reference).toBe(`context-use://object/${added.object_id}`);
      expect(added.current_revision_id).not.toBeNull();
      const initialSearchChunks = await pool.query<{ ctid: string }>(
        `SELECT ctid::text AS ctid FROM source_record_search_chunks
         WHERE document_id=$1 ORDER BY chunk_number`,
        [added.object_id],
      );
      expect(initialSearchChunks.rowCount).toBeGreaterThan(0);

      const replayedBody = await records.write({
        ...base,
        action: "updated",
        sourceUpdatedAt: "2026-08-20T09:00:00.000Z",
        markdown: "# Issue 42\n\nOpen.\n",
      });
      expect(replayedBody).toEqual(added);
      expect((await pool.query<{ ctid: string }>(
        `SELECT ctid::text AS ctid FROM source_record_search_chunks
         WHERE document_id=$1 ORDER BY chunk_number`,
        [added.object_id],
      )).rows).toEqual(initialSearchChunks.rows);

      // A pre-chunk upgrade row may have only the legacy base vector. An
      // unchanged-body replay must not clear that last searchable projection
      // when it has no chunks to rebuild.
      await pool.query(
        `UPDATE source_records
         SET search_vector=to_tsvector('english','legacyupgradevector')
         WHERE document_id=$1`,
        [added.object_id],
      );
      await pool.query(
        "DELETE FROM source_record_search_chunks WHERE document_id=$1",
        [added.object_id],
      );
      await records.write({
        ...base,
        action: "updated",
        sourceUpdatedAt: "2026-08-20T09:30:00.000Z",
        markdown: "# Issue 42\n\nOpen.\n",
      });
      expect((await pool.query(
        `SELECT 1 FROM source_records
         WHERE document_id=$1
           AND search_vector @@ plainto_tsquery('english','legacyupgradevector')`,
        [added.object_id],
      )).rowCount).toBe(1);
      expect((await pool.query(
        "SELECT 1 FROM source_record_search_chunks WHERE document_id=$1",
        [added.object_id],
      )).rowCount).toBe(0);

      const changed = await records.write({
        ...base,
        action: "updated",
        // A sync-code-only formatting change keeps the provider timestamp.
        sourceUpdatedAt: "2026-08-20T09:30:00.000Z",
        markdown: "# Issue 42\n\nClosed.\n",
      });
      expect(changed.object_id).toBe(added.object_id);
      expect(changed.current_revision_id).not.toBe(added.current_revision_id);
      expect(changed.reference).toBe(added.reference);

      const source = await pool.query<{
        document_id: string;
        deleted_at: Date | null;
        source_updated_at: Date;
      }>(
        "SELECT document_id,deleted_at,source_updated_at FROM source_records WHERE connection_id=$1",
        [connectionId],
      );
      expect(source.rowCount).toBe(1);
      expect(source.rows[0]?.deleted_at).toBeNull();
      expect(source.rows[0]?.source_updated_at.toISOString()).toBe("2026-08-20T09:30:00.000Z");
      expect((await pool.query(
        "SELECT 1 FROM hypermedia_document_revisions WHERE document_id=$1",
        [source.rows[0]!.document_id],
      )).rowCount).toBe(2);
      expect([...store.bodies.values()]).toContain("# Issue 42\n\nClosed.\n");

      const superseded = await records.write({
        ...base,
        action: "updated",
        sourceUpdatedAt: "2026-08-20T09:00:00.000Z",
        markdown: "# Issue 42\n\nStale re-open.\n",
      });
      expect(superseded).toEqual(changed);
      expect((await pool.query(
        "SELECT 1 FROM hypermedia_document_revisions WHERE document_id=$1",
        [source.rows[0]!.document_id],
      )).rowCount).toBe(2);
      expect(store.bodies.size).toBe(2);

      const deleted = await records.write({
        ...base,
        action: "deleted",
        sourceUpdatedAt: "2026-08-20T11:00:00.000Z",
        markdown: null,
      });
      expect(deleted).toEqual(changed);
      expect(await records.get(deleted.object_id)).toMatchObject({
        ...deleted,
        authority: "source",
        revision_number: 2,
        integration: "github",
        connection_instance_id: 101,
        connection_id: connectionId,
        model: "GithubIssue",
        source_record_id: "issue-42",
        deleted_at: new Date("2026-08-20T11:00:00.000Z"),
        body_markdown: "# Issue 42\n\nClosed.\n",
      });
      expect(await records.searchMetadata("Closed")).toEqual([
        expect.objectContaining({
          ...deleted,
          authority: "source",
          deleted_at: new Date("2026-08-20T11:00:00.000Z"),
        }),
      ]);
      expect(await records.metadata(deleted.object_id)).toMatchObject({
        ...deleted,
        authority: "source",
        deleted_at: new Date("2026-08-20T11:00:00.000Z"),
      });
      await records.write({
        ...base,
        action: "updated",
        sourceUpdatedAt: "2026-08-20T10:30:00.000Z",
        markdown: "# Issue 42\n\nClosed.\n",
      });
      expect((await pool.query<{ deleted: boolean }>(
        "SELECT deleted_at IS NOT NULL AS deleted FROM source_records WHERE connection_id=$1",
        [connectionId],
      )).rows[0]?.deleted).toBe(true);

      const restored = await records.write({
        ...base,
        action: "added",
        sourceUpdatedAt: "2026-08-20T12:00:00.000Z",
        markdown: "# Issue 42\n\nClosed.\n",
      });
      expect(restored).toEqual(changed);
      expect((await pool.query<{ deleted: boolean }>(
        "SELECT deleted_at IS NOT NULL AS deleted FROM source_records WHERE connection_id=$1",
        [connectionId],
      )).rows[0]?.deleted).toBe(false);

      const unknownDeletion = await records.write({
        ...base,
        sourceRecordId: "unknown-deletion",
        action: "deleted",
        sourceUpdatedAt: "2026-08-20T13:00:00.000Z",
        markdown: null,
      });
      expect(unknownDeletion.current_revision_id).toBeNull();
      expect(unknownDeletion.reference).toBe(
        `context-use://object/${unknownDeletion.object_id}`,
      );
      const tombstone = await pool.query<{ document_id: string; current_revision_id: string | null }>(
        `SELECT document_id,current_revision_id FROM source_records
         WHERE connection_id=$1 AND source_record_id='unknown-deletion'`,
        [connectionId],
      );
      expect(tombstone.rows[0]?.current_revision_id).toBeNull();
      expect((await pool.query(
        "SELECT 1 FROM hypermedia_document_revisions WHERE document_id=$1",
        [tombstone.rows[0]!.document_id],
      )).rowCount).toBe(0);
      expect(await records.get(unknownDeletion.object_id)).toMatchObject({
        ...unknownDeletion,
        authority: "source",
        source_record_id: "unknown-deletion",
        deleted_at: new Date("2026-08-20T13:00:00.000Z"),
        body_markdown: null,
      });
      expect(await records.get(crypto.randomUUID())).toBeNull();
    } finally {
      await pool.query(
        `DELETE FROM hypermedia_documents
         WHERE id IN (SELECT document_id FROM source_records WHERE connection_id=$1)`,
        [connectionId],
      );
    }
  });

  test("archives an exact source revision before permanently deleting its object", async () => {
    const store = new MemoryMarkdownStore();
    const records = new SourceRecordRepository(pool, store);
    const created = await records.write({
      integration: "granola",
      connectionInstanceId: 801,
      connectionId: `lifecycle-${crypto.randomUUID()}`,
      model: "GranolaMeeting",
      sourceRecordId: `meeting-${crypto.randomUUID()}`,
      action: "added",
      sourceCreatedAt: "2026-08-26T08:00:00.000Z",
      sourceUpdatedAt: "2026-08-26T09:00:00.000Z",
      markdown: "# Lifecycle meeting\n\nRetained source evidence.\n",
    });
    expect(created.current_revision_id).not.toBeNull();

    expect(await records.archive(created.object_id, crypto.randomUUID()))
      .toBe("revision_conflict");
    expect(await records.delete(created.object_id, created.current_revision_id))
      .toBe("not_archived");
    expect((await records.metadata(created.object_id))?.deleted_at).toBeNull();

    expect(await records.archive(created.object_id, created.current_revision_id))
      .toBe("archived");
    expect(await records.archive(created.object_id, created.current_revision_id))
      .toBe("archived");
    expect((await records.metadata(created.object_id))?.deleted_at).not.toBeNull();
    expect((await pool.query(
      "SELECT 1 FROM source_record_search_chunks WHERE document_id=$1",
      [created.object_id],
    )).rowCount).toBe(0);
    expect((await pool.query<{ empty: boolean }>(
      "SELECT search_vector=''::tsvector AS empty FROM source_records WHERE document_id=$1",
      [created.object_id],
    )).rows[0]?.empty).toBe(true);

    expect(await records.delete(created.object_id, crypto.randomUUID()))
      .toBe("revision_conflict");
    expect(await records.delete(created.object_id, created.current_revision_id))
      .toBe("deleted");
    expect(await records.metadata(created.object_id)).toBeNull();
    expect((await pool.query(
      "SELECT 1 FROM hypermedia_documents WHERE id=$1",
      [created.object_id],
    )).rowCount).toBe(0);
    expect((await pool.query(
      "SELECT 1 FROM hypermedia_document_revisions WHERE document_id=$1",
      [created.object_id],
    )).rowCount).toBe(0);
    expect(await records.delete(created.object_id, created.current_revision_id))
      .toBe("not_found");
  });

  test("adopts a legacy record and preserves it across a re-created Nango connection", async () => {
    const connectionId = `reused-connection-${crypto.randomUUID()}`;
    const sourceRecordId = `reused-record-${crypto.randomUUID()}`;
    const legacyDocumentId = crypto.randomUUID();
    const store = new MemoryMarkdownStore();
    const records = new SourceRecordRepository(pool, store);
    const base = {
      integration: "github",
      connectionId,
      model: "GithubIssue",
      sourceRecordId,
      sourceCreatedAt: "2026-08-20T08:00:00.000Z",
    };
    try {
      await pool.query(
        "INSERT INTO hypermedia_documents(id,authority) VALUES ($1,'source')",
        [legacyDocumentId],
      );
      await pool.query(
        `INSERT INTO source_records(
           document_id,integration,connection_id,model,source_record_id,
           source_updated_at,search_vector
         ) VALUES ($1,$2,$3,$4,$5,$6,''::tsvector)`,
        [legacyDocumentId, base.integration, connectionId, base.model,
          sourceRecordId, "2026-08-20T09:00:00.000Z"],
      );

      const original = await records.write({
        ...base,
        connectionInstanceId: 701,
        action: "added",
        sourceUpdatedAt: "2026-08-20T10:00:00.000Z",
        markdown: "# Reused issue\n\nOriginal connection.\n",
      });
      expect(original.object_id).toBe(legacyDocumentId);
      expect(await records.metadata(original.object_id)).toMatchObject({
        connection_instance_id: 701,
        connection_id: connectionId,
      });

      const replacementConnectionId = `${connectionId}-replacement`;
      const reconnected = await records.write({
        ...base,
        connectionInstanceId: 702,
        connectionId: replacementConnectionId,
        action: "added",
        sourceUpdatedAt: "2026-08-20T10:00:00.000Z",
        markdown: "# Reused issue\n\nRe-created connection.\n",
      });

      expect(reconnected.object_id).toBe(original.object_id);
      expect(await records.metadata(reconnected.object_id)).toMatchObject({
        connection_instance_id: 702,
        connection_id: replacementConnectionId,
      });

      await records.write({
        ...base,
        connectionInstanceId: 702,
        connectionId: replacementConnectionId,
        action: "deleted",
        sourceUpdatedAt: "2026-08-20T11:00:00.000Z",
        markdown: null,
      });
      const streams = await pool.query<{
        document_id: string;
        connection_instance_id: string | null;
        deleted: boolean;
      }>(
        `SELECT document_id,connection_instance_id::text,
           deleted_at IS NOT NULL AS deleted
         FROM source_records
         WHERE integration=$1 AND model=$2 AND source_record_id=$3
         ORDER BY connection_instance_id NULLS FIRST`,
        [base.integration, base.model, sourceRecordId],
      );
      expect(streams.rows).toEqual([
        { document_id: legacyDocumentId, connection_instance_id: "702", deleted: true },
      ]);
    } finally {
      await pool.query(
        `DELETE FROM hypermedia_documents
         WHERE id IN (
           SELECT document_id FROM source_records
           WHERE integration=$1 AND model=$2 AND source_record_id=$3
         )`,
        [base.integration, base.model, sourceRecordId],
      );
    }
  });

  test("indexes a varied raw record above four megabytes without building one oversized tsvector", async () => {
    const connectionId = `large-connection-${crypto.randomUUID()}`;
    const store = new MemoryMarkdownStore();
    const records = new SourceRecordRepository(pool, store);
    const crossingTerm = "crosschunkneedle";
    const opening = "boundaryfirstneedle ";
    const crossingTarget = 64 * 1024 - Math.floor(crossingTerm.length / 2);
    const paddingBytes = crossingTarget - opening.length
      - ((crossingTarget - opening.length) % 2);
    const boundaryPrefix = `${opening}${"p ".repeat(paddingBytes / 2)}`;
    expect(Buffer.byteLength(boundaryPrefix, "utf8")).toBeLessThan(64 * 1024);
    expect(Buffer.byteLength(`${boundaryPrefix}${crossingTerm}`, "utf8"))
      .toBeGreaterThan(64 * 1024);
    const markdown = `${boundaryPrefix}${crossingTerm} ${Array.from(
      { length: 450_000 },
      (_, index) => `distinctterm${index.toString(36)}`,
    ).join(" ")} finalsearchneedle`;
    expect(Buffer.byteLength(markdown, "utf8")).toBeGreaterThan(4_000_000);
    try {
      const written = await records.write({
        integration: "agent-conversations",
        connectionInstanceId: 202,
        connectionId,
        model: "AgentConversation",
        sourceRecordId: "large-varied-record",
        action: "added",
        sourceCreatedAt: "2026-08-20T08:00:00.000Z",
        sourceUpdatedAt: "2026-08-20T09:00:00.000Z",
        markdown,
      });

      expect(await records.searchMetadata(
        `boundaryfirstneedle ${crossingTerm} finalsearchneedle`,
      ))
        .toEqual([expect.objectContaining({ object_id: written.object_id })]);
      expect((await pool.query<{ count: number }>(
        `SELECT count(*)::int AS count
         FROM source_record_search_chunks WHERE document_id=$1`,
        [written.object_id],
      )).rows[0]!.count).toBeGreaterThan(1);
      expect((await records.get(written.object_id))?.body_markdown).toBe(markdown);
    } finally {
      await pool.query(
        `DELETE FROM hypermedia_documents
         WHERE id IN (SELECT document_id FROM source_records WHERE connection_id=$1)`,
        [connectionId],
      );
    }
  });

  test("treats internal-URI text in raw evidence as an authoritative empty outbound set", async () => {
    const connectionId = `inert-link-connection-${crypto.randomUUID()}`;
    const store = new MemoryMarkdownStore();
    const records = new SourceRecordRepository(pool, store);
    const links = new ObjectLinkRepository(pool);
    try {
      const target = await records.write({
        integration: "agent-conversations",
        connectionInstanceId: 303,
        connectionId,
        model: "AgentConversation",
        sourceRecordId: "evidence-target",
        action: "added",
        sourceCreatedAt: "2026-08-20T08:00:00.000Z",
        sourceUpdatedAt: "2026-08-20T09:00:00.000Z",
        markdown: "# Evidence target\n",
      });
      const markdown = `[Incidental raw URI](context-use://object/${target.object_id})`;
      const written = await records.write({
        integration: "agent-conversations",
        connectionInstanceId: 303,
        connectionId,
        model: "AgentConversation",
        sourceRecordId: "evidence-with-uri-text",
        action: "added",
        sourceCreatedAt: "2026-08-20T08:00:00.000Z",
        sourceUpdatedAt: "2026-08-20T09:00:00.000Z",
        markdown,
      });

      expect((await records.get(written.object_id))?.body_markdown).toBe(markdown);
      expect(await links.revisionIndex(written.current_revision_id!)).toMatchObject({
        source_revision_id: written.current_revision_id,
        links_indexed_at: expect.anything(),
        target_document_ids: [],
      });
      expect(await links.backlinks(target.object_id)).toEqual({
        backlinks: [],
        has_more: false,
      });
    } finally {
      await pool.query(
        `DELETE FROM hypermedia_documents
         WHERE id IN (SELECT document_id FROM source_records WHERE connection_id=$1)`,
        [connectionId],
      );
    }
  });
});
