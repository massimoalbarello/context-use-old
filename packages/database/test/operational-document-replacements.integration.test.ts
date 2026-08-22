import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client, Pool } from "pg";
import { disposableDatabaseUrl } from "../src/disposable-database.ts";
import type { MarkdownObjectStore } from "../src/documents.ts";
import { OperationalDocumentReplacementRepository } from "../src/operational-document-replacements.ts";
import { PageRepository } from "../src/pages.ts";

const databaseUrl = await disposableDatabaseUrl();
const describeDatabase = databaseUrl ? describe : describe.skip;

function metadata(revisionId: string, body: string) {
  return {
    id: revisionId,
    body_object_key: `documents/private/${revisionId}.md`,
    body_size_bytes: Buffer.byteLength(body, "utf8"),
    body_content_hash: createHash("sha256").update(body).digest("hex"),
  };
}

describeDatabase("managed operational document replacement", () => {
  let admin: Client;
  let dashboardPool: Pool;
  let repository: OperationalDocumentReplacementRepository;

  beforeAll(async () => {
    admin = new Client({ connectionString: databaseUrl });
    await admin.connect();
    dashboardPool = new Pool({ connectionString: databaseUrl, max: 1 });
    const client = await dashboardPool.connect();
    await client.query("SET ROLE context_use_corpus");
    client.release();
    repository = new OperationalDocumentReplacementRepository(dashboardPool);
  });

  afterAll(async () => {
    await dashboardPool?.end().catch(() => undefined);
    await admin?.end().catch(() => undefined);
  });

  async function createPage(input: {
    path: string;
    title: string;
    summary: string;
    body: string;
    published?: boolean;
  }) {
    const documentId = randomUUID();
    const revisionId = randomUUID();
    const object = metadata(revisionId, input.body);
    await admin.query("BEGIN");
    try {
      await admin.query("SET CONSTRAINTS ALL DEFERRED");
      await admin.query(
        "INSERT INTO hypermedia_documents(id,authority,representation) VALUES ($1,'knowledge','markdown')",
        [documentId],
      );
      await admin.query(
        `INSERT INTO hypermedia_document_revisions(
           id,document_id,revision_number,body_object_key,body_size_bytes,body_content_hash
         ) VALUES ($1,$2,1,$3,$4,$5)`,
        [revisionId, documentId, object.body_object_key,
          object.body_size_bytes, object.body_content_hash],
      );
      await admin.query(
        `INSERT INTO knowledge_pages(
           id,current_path,current_version_id,published_version_id,public_path,search_vector
         ) VALUES ($1,$2,$3,$4,$5,page_search_vector($2,$6,$7,$8))`,
        [documentId, input.path, revisionId, input.published ? revisionId : null,
          input.published ? input.path : null, input.title, input.summary, input.body],
      );
      await admin.query(
        `INSERT INTO knowledge_page_versions(
           id,page_id,version_number,path,title,summary,commit_message,actor_kind,actor_subject
         ) VALUES ($1,$2,1,$3,$4,$5,'Create replacement fixture','dashboard','test')`,
        [revisionId, documentId, input.path, input.title, input.summary],
      );
      await admin.query("SELECT replace_knowledge_revision_projections($1,'{}'::uuid[])", [revisionId]);
      await admin.query("COMMIT");
    } catch (error) {
      await admin.query("ROLLBACK");
      throw error;
    }
    return { documentId, revisionId, object };
  }

  async function appendRevision(input: {
    documentId: string;
    path: string;
    title: string;
    summary: string;
    body: string;
  }) {
    const revisionId = randomUUID();
    const object = metadata(revisionId, input.body);
    const revisionNumber = Number((await admin.query<{ next: string }>(
      `SELECT coalesce(max(version_number),0)+1 AS next
       FROM knowledge_page_versions WHERE page_id=$1`,
      [input.documentId],
    )).rows[0]!.next);
    await admin.query("BEGIN");
    try {
      await admin.query("SET CONSTRAINTS ALL DEFERRED");
      await admin.query(
        `INSERT INTO hypermedia_document_revisions(
           id,document_id,revision_number,body_object_key,body_size_bytes,body_content_hash
         ) VALUES ($1,$2,$3,$4,$5,$6)`,
        [revisionId,input.documentId,revisionNumber,object.body_object_key,
          object.body_size_bytes,object.body_content_hash],
      );
      await admin.query(
        `INSERT INTO knowledge_page_versions(
           id,page_id,version_number,path,title,summary,commit_message,actor_kind,actor_subject
         ) VALUES ($1,$2,$3,$4,$5,$6,'Owner edit','dashboard','test')`,
        [revisionId,input.documentId,revisionNumber,input.path,input.title,input.summary],
      );
      await admin.query(
        `UPDATE knowledge_pages
         SET current_version_id=$2,
             search_vector=page_search_vector($3,$4,$5,$6),updated_at=now()
         WHERE id=$1`,
        [input.documentId,revisionId,input.path,input.title,input.summary,input.body],
      );
      await admin.query("SELECT replace_knowledge_revision_projections($1,'{}'::uuid[])", [
        revisionId,
      ]);
      await admin.query("COMMIT");
    } catch (error) {
      await admin.query("ROLLBACK");
      throw error;
    }
    return { revisionId,revisionNumber,object };
  }

  async function createPublishedArtifact(input: {
    documentId: string;
    revisionId: string;
    object: ReturnType<typeof metadata>;
  }) {
    const artifactId = randomUUID();
    const generation = (await admin.query<{ generation: string }>(
      "SELECT generation::text FROM public_projection_state WHERE singleton",
    )).rows[0]!.generation;
    const objectKey = `documents/public/${artifactId}.md`;
    await admin.query(
      `INSERT INTO published_page_artifacts(
         page_id,version_id,projection_generation,artifact_id,
         body_object_key,body_size_bytes,body_content_hash
       ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [input.documentId,input.revisionId,generation,artifactId,objectKey,
        input.object.body_size_bytes,input.object.body_content_hash],
    );
    return { artifactId,generation,objectKey };
  }

  test("clones a published legacy state and atomically registers private replacements as corpus preparer", async () => {
    const suffix = randomUUID();
    const instructionsBody = "# Owner-custom instructions\n";
    const stateBody = "# Published checkpoint\n\nDo not lose this state.\n";
    const managedBody = "# Managed instructions\n";
    const instructions = await createPage({
      path: `legacy-instructions-${suffix}`,
      title: "Custom automation instructions",
      summary: "Owner-custom instructions that must remain ordinary knowledge.",
      body: instructionsBody,
    });
    const state = await createPage({
      path: `legacy-state-${suffix}`,
      title: "Published automation state",
      summary: "A legacy public checkpoint that must remain pinned.",
      body: stateBody,
      published: true,
    });
    const artifactId = randomUUID();
    const generation = Number((await admin.query<{ generation: string }>(
      "SELECT generation::text FROM public_projection_state WHERE singleton",
    )).rows[0]!.generation);
    await admin.query(
      `INSERT INTO published_page_artifacts(
         page_id,version_id,projection_generation,artifact_id,
         body_object_key,body_size_bytes,body_content_hash
       ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [state.documentId, state.revisionId, generation, artifactId,
        `documents/public/${artifactId}.md`, state.object.body_size_bytes,
        state.object.body_content_hash],
    );

    const managed = metadata(randomUUID(), managedBody);
    let appliedDocumentIds: string[] = [];
    try {
      const input = {
        target: {
          kind: "automation_instructions" as const,
          key: `replacement-${suffix}`,
          name: "Managed replacement fixture",
          state: {
            mode: "clone" as const,
            source_document_id: state.documentId,
            source_revision_id: state.revisionId,
            title: "Published automation state",
            summary: "A legacy public checkpoint that must remain pinned.",
            body_size_bytes: state.object.body_size_bytes,
            body_content_hash: state.object.body_content_hash,
          },
        },
        source_document_id: instructions.documentId,
        source_revision_id: instructions.revisionId,
        managed: {
          title: "Managed automation instructions",
          summary: "Private template-managed operational instructions.",
          body_size_bytes: Buffer.byteLength(managedBody, "utf8"),
          body_content_hash: createHash("sha256").update(managedBody).digest("hex"),
        },
        actor_subject: "context-use-template/default",
      };
      const planned = await repository.beginOrResume(input);
      const resumed = await repository.beginOrResume(input);
      expect(resumed).toEqual(planned);
      expect(planned.state?.mode).toBe("clone");
      if (planned.state?.mode !== "clone") throw new Error("state clone was not allocated");
      appliedDocumentIds = [planned.replacement_document_id, planned.state.replacement_document_id];

      const applyInput = {
        replacement_id: planned.replacement_id,
        revision: {
          id: planned.replacement_revision.revision_id,
          body_object_key: planned.replacement_revision.body_object_key,
          body_size_bytes: input.managed.body_size_bytes,
          body_content_hash: input.managed.body_content_hash,
        },
        body_markdown_for_index: managedBody,
        target_document_ids: [],
        state_clone: {
          revision: {
            id: planned.state.replacement_revision.revision_id,
            body_object_key: planned.state.replacement_revision.body_object_key,
            body_size_bytes: state.object.body_size_bytes,
            body_content_hash: state.object.body_content_hash,
          },
          body_markdown_for_index: stateBody,
          target_document_ids: [],
        },
      };
      const applied = await repository.apply(applyInput);
      expect(applied.phase).toBe("applied");
      expect(await repository.apply(applyInput)).toEqual(applied);

      expect((await admin.query(
        `SELECT id,key,name,instructions_document_id,state_document_id,disabled_at
         FROM automation_registry WHERE key=$1`,
        [input.target.key],
      )).rows).toEqual([{
        id: planned.registration_id,
        key: input.target.key,
        name: input.target.name,
        instructions_document_id: planned.replacement_document_id,
        state_document_id: planned.state.replacement_document_id,
        disabled_at: null,
      }]);
      expect((await admin.query(
        `SELECT current_version_id,published_version_id,public_path
         FROM knowledge_pages WHERE id=$1`,
        [state.documentId],
      )).rows).toEqual([{
        current_version_id: state.revisionId,
        published_version_id: state.revisionId,
        public_path: `legacy-state-${suffix}`,
      }]);
      expect((await admin.query(
        `SELECT artifact_id,body_object_key,body_content_hash
         FROM published_page_artifacts WHERE artifact_id=$1`,
        [artifactId],
      )).rows).toEqual([{
        artifact_id: artifactId,
        body_object_key: `documents/public/${artifactId}.md`,
        body_content_hash: state.object.body_content_hash,
      }]);
      expect((await admin.query(
        `SELECT version.title,version.summary,revision.body_size_bytes,revision.body_content_hash
         FROM knowledge_page_versions version
         JOIN hypermedia_document_revisions revision ON revision.id=version.id
         WHERE version.id=$1`,
        [planned.state.replacement_revision.revision_id],
      )).rows).toEqual([{
        title: input.target.state.title,
        summary: input.target.state.summary,
        body_size_bytes: state.object.body_size_bytes,
        body_content_hash: state.object.body_content_hash,
      }]);
    } finally {
      await admin.query("BEGIN");
      try {
        await admin.query("SET CONSTRAINTS ALL DEFERRED");
        await admin.query("DELETE FROM automation_registry WHERE key=$1", [`replacement-${suffix}`]);
        await admin.query(
          `DELETE FROM operational_document_replacements
           WHERE source_document_id IN ($1,$2)`,
          [instructions.documentId, state.documentId],
        );
        await admin.query(
          `UPDATE knowledge_pages SET published_version_id=NULL,public_path=NULL,archived_at=now()
           WHERE id=ANY($1::uuid[])`,
          [[instructions.documentId, state.documentId, ...appliedDocumentIds]],
        );
        await admin.query(
          "DELETE FROM knowledge_page_versions WHERE page_id=ANY($1::uuid[])",
          [[instructions.documentId, state.documentId, ...appliedDocumentIds]],
        );
        await admin.query(
          "DELETE FROM knowledge_pages WHERE id=ANY($1::uuid[])",
          [[instructions.documentId, state.documentId, ...appliedDocumentIds]],
        );
        await admin.query("COMMIT");
      } catch (error) {
        await admin.query("ROLLBACK");
        throw error;
      }
    }
  });

  test("retargets an existing disabled registration without changing its identity, state, or owner setting", async () => {
    const suffix = randomUUID();
    const key = `existing-${suffix}`;
    const sourceBody = "# Custom registered instructions\n";
    const stateBody = "# Private checkpoint\n";
    const managedBody = "# Managed registered instructions\n";
    const instructions = await createPage({
      path: `registered-instructions-${suffix}`,
      title: "Registered custom instructions",
      summary: "Owner-custom registered instructions.",
      body: sourceBody,
    });
    const state = await createPage({
      path: `registered-state-${suffix}`,
      title: "Registered private state",
      summary: "The existing private state identity.",
      body: stateBody,
    });
    const registrationId = randomUUID();
    const disabledAt = new Date("2026-08-01T12:00:00.000Z");
    await admin.query(
      `INSERT INTO automation_registry(
         id,key,name,instructions_document_id,state_document_id,disabled_at
       ) VALUES ($1,$2,'Owner automation',$3,$4,$5)`,
      [registrationId, key, instructions.documentId, state.documentId, disabledAt],
    );
    let replacementDocumentId: string | null = null;
    try {
      const body = metadata(randomUUID(), managedBody);
      const plan = await repository.beginOrResume({
        target: {
          kind: "automation_instructions",
          key,
          name: "Template presentation must not overwrite owner presentation",
          state: { mode: "existing", document_id: state.documentId },
        },
        source_document_id: instructions.documentId,
        source_revision_id: instructions.revisionId,
        managed: {
          title: "Managed registered instructions",
          summary: "Private template-managed registered instructions.",
          body_size_bytes: body.body_size_bytes,
          body_content_hash: body.body_content_hash,
        },
        actor_subject: "context-use-template/default",
      });
      replacementDocumentId = plan.replacement_document_id;
      await repository.apply({
        replacement_id: plan.replacement_id,
        revision: {
          id: plan.replacement_revision.revision_id,
          body_object_key: plan.replacement_revision.body_object_key,
          body_size_bytes: body.body_size_bytes,
          body_content_hash: body.body_content_hash,
        },
        body_markdown_for_index: managedBody,
        target_document_ids: [],
      });
      expect((await admin.query(
        `SELECT id,key,name,instructions_document_id,state_document_id,disabled_at
         FROM automation_registry WHERE id=$1`,
        [registrationId],
      )).rows).toEqual([{
        id: registrationId,
        key,
        name: "Owner automation",
        instructions_document_id: plan.replacement_document_id,
        state_document_id: state.documentId,
        disabled_at: disabledAt,
      }]);
      expect((await admin.query(
        "SELECT current_version_id,current_path FROM knowledge_pages WHERE id=$1",
        [instructions.documentId],
      )).rows).toEqual([{
        current_version_id: instructions.revisionId,
        current_path: `registered-instructions-${suffix}`,
      }]);
    } finally {
      await admin.query("BEGIN");
      try {
        await admin.query("SET CONSTRAINTS ALL DEFERRED");
        await admin.query("DELETE FROM automation_registry WHERE id=$1", [registrationId]);
        await admin.query(
          "DELETE FROM operational_document_replacements WHERE source_document_id=$1",
          [instructions.documentId],
        );
        const ids = [instructions.documentId, state.documentId,
          ...(replacementDocumentId ? [replacementDocumentId] : [])];
        await admin.query(
          "UPDATE knowledge_pages SET archived_at=now() WHERE id=ANY($1::uuid[])",
          [ids],
        );
        await admin.query("DELETE FROM knowledge_page_versions WHERE page_id=ANY($1::uuid[])", [ids]);
        await admin.query("DELETE FROM knowledge_pages WHERE id=ANY($1::uuid[])", [ids]);
        await admin.query("COMMIT");
      } catch (error) {
        await admin.query("ROLLBACK");
        throw error;
      }
    }
  });

  test("atomically restores agents while preserving a distinct published occupant and configured guide", async () => {
    const suffix = randomUUID();
    const sourceBody = "# Configured owner guide\n\nThis published page remains ordinary knowledge.\n";
    const occupantV1Body = "# Public legacy root\n";
    const occupantV2Body = "# Private owner root\n\n[Missing reference](context-use://document/00000000-0000-4000-8000-000000000099)\n";
    const descendantBody = "# Scoped owner guide\n";
    const managedBody = "# Managed global maintenance guide\n";
    const originalGuideId = (await admin.query<{ global_guide_document_id: string | null }>(
      "SELECT global_guide_document_id FROM knowledge_settings WHERE singleton",
    )).rows[0]?.global_guide_document_id ?? null;
    const existingOccupant = (await admin.query<{
      document_id: string;
      revision_id: string;
      version_number: number;
      title: string;
      summary: string;
      body_object_key: string;
      body_size_bytes: number | string;
      body_content_hash: string;
      published_version_id: string | null;
      public_path: string | null;
      archived_at: Date | null;
      search_vector: string;
      updated_at: Date;
    }>(
      `SELECT page.id AS document_id,page.current_version_id AS revision_id,
         version.version_number,version.title,version.summary,
         revision.body_object_key,revision.body_size_bytes,revision.body_content_hash,
         page.published_version_id,page.public_path,page.archived_at,
         page.search_vector::text AS search_vector,page.updated_at
       FROM knowledge_pages page
       JOIN knowledge_page_versions version ON version.id=page.current_version_id
       JOIN hypermedia_document_revisions revision ON revision.id=version.id
       WHERE page.current_path='agents' AND page.archived_at IS NULL`,
    )).rows[0] ?? null;
    const priorOccupantArtifacts = existingOccupant ? (await admin.query<{
      page_id: string;
      version_id: string;
      projection_generation: number | string;
      artifact_id: string;
      body_object_key: string;
      body_size_bytes: number;
      body_content_hash: string;
      created_at: Date;
    }>(
      `SELECT page_id,version_id,projection_generation,artifact_id,
         body_object_key,body_size_bytes,body_content_hash,created_at
       FROM published_page_artifacts WHERE page_id=$1`,
      [existingOccupant.document_id],
    )).rows : [];
    const source = await createPage({
      path: `custom-global-guide-${suffix}`,
      title: "Configured owner guide",
      summary: "Published owner guidance that remains at its original identity.",
      body: sourceBody,
    });
    const occupant = existingOccupant ? {
      documentId: existingOccupant.document_id,
      revisionId: existingOccupant.revision_id,
      object: {
        id: existingOccupant.revision_id,
        body_object_key: existingOccupant.body_object_key,
        body_size_bytes: Number(existingOccupant.body_size_bytes),
        body_content_hash: existingOccupant.body_content_hash,
      },
      title: existingOccupant.title,
      summary: existingOccupant.summary,
      versionNumber: existingOccupant.version_number,
    } : {
      ...await createPage({
        path: "agents",
        title: "Published legacy root",
        summary: "The pinned public root revision.",
        body: occupantV1Body,
      }),
      title: "Published legacy root",
      summary: "The pinned public root revision.",
      versionNumber: 1,
    };
    const occupantCurrent = await appendRevision({
      documentId: occupant.documentId,
      path: "agents",
      title: "Private owner root",
      summary: "The current owner-authored root guide.",
      body: occupantV2Body,
    });
    const scopedPath = `scope-${suffix}`;
    await admin.query(
      `INSERT INTO knowledge_directories(id,current_path,title,summary,search_vector)
       VALUES ($1,$2,'Scoped fixture','A scoped guide fixture.',
         directory_search_vector($2,'Scoped fixture','A scoped guide fixture.',''))`,
      [randomUUID(),scopedPath],
    );
    const descendant = await createPage({
      path: `${scopedPath}/agents`,
      title: "Scoped owner guide",
      summary: "Owner guidance that remains path-scoped for rollback.",
      body: descendantBody,
    });
    await admin.query("SET session_replication_role='replica'");
    try {
      await admin.query("DELETE FROM published_page_artifacts WHERE page_id=$1", [
        occupant.documentId,
      ]);
      await admin.query(
        `UPDATE knowledge_pages
         SET published_version_id=$2,public_path=$3
         WHERE id=$1`,
        [source.documentId,source.revisionId,`custom-global-guide-${suffix}`],
      );
      await admin.query(
        `UPDATE knowledge_pages
         SET published_version_id=$2,public_path=$3
         WHERE id=$1`,
        [occupant.documentId,occupant.revisionId,`legacy-agents-${suffix}`],
      );
      await admin.query(
        "UPDATE knowledge_settings SET global_guide_document_id=$1,updated_at=now() WHERE singleton",
        [source.documentId],
      );
    } finally {
      await admin.query("SET session_replication_role='origin'");
    }
    const sourceArtifact = await createPublishedArtifact(source);
    const occupantArtifact = await createPublishedArtifact(occupant);
    let replacementDocumentId: string | null = null;
    let preservationRevisionId: string | null = null;
    try {
      const body = metadata(randomUUID(), managedBody);
      const plan = await repository.beginOrResume({
        target: { kind: "global_guide" },
        source_document_id: source.documentId,
        source_revision_id: source.revisionId,
        managed: {
          title: "Global hypermedia maintenance guide",
          summary: "Private template-managed guidance loaded before knowledge mutation.",
          body_size_bytes: body.body_size_bytes,
          body_content_hash: body.body_content_hash,
        },
        actor_subject: "context-use-template/default",
      });
      replacementDocumentId = plan.replacement_document_id;
      expect(plan.agents_occupant_preservation).toMatchObject({
        document_id: occupant.documentId,
        source_revision_id: occupantCurrent.revisionId,
        title: "Private owner root",
        summary: "The current owner-authored root guide.",
        body_size_bytes: occupantCurrent.object.body_size_bytes,
        body_content_hash: occupantCurrent.object.body_content_hash,
      });
      if (!plan.agents_occupant_preservation) {
        throw new Error("agents occupant preservation was not allocated");
      }
      preservationRevisionId = plan.agents_occupant_preservation.revision.revision_id;
      const applyInput = {
        replacement_id: plan.replacement_id,
        revision: {
          id: plan.replacement_revision.revision_id,
          body_object_key: plan.replacement_revision.body_object_key,
          body_size_bytes: body.body_size_bytes,
          body_content_hash: body.body_content_hash,
        },
        body_markdown_for_index: managedBody,
        target_document_ids: [],
        agents_occupant_preservation: {
          revision: {
            id: plan.agents_occupant_preservation.revision.revision_id,
            body_object_key: plan.agents_occupant_preservation.revision.body_object_key,
            body_size_bytes: occupantCurrent.object.body_size_bytes,
            body_content_hash: occupantCurrent.object.body_content_hash,
          },
          body_markdown_for_index: occupantV2Body,
          target_document_ids: ["00000000-0000-4000-8000-000000000099"],
        },
      };
      const applied = await repository.apply(applyInput);
      expect(await repository.apply(applyInput)).toEqual(applied);
      expect((await admin.query(
        "SELECT global_guide_document_id FROM knowledge_settings WHERE singleton",
      )).rows).toEqual([{ global_guide_document_id: plan.replacement_document_id }]);
      expect((await admin.query(
        `SELECT page.current_path,page.current_version_id,page.published_version_id,
           page.public_path,version.title,version.summary,
           revision.body_object_key,revision.body_size_bytes,revision.body_content_hash
         FROM knowledge_pages page
         JOIN knowledge_page_versions version ON version.id=page.current_version_id
         JOIN hypermedia_document_revisions revision ON revision.id=version.id
         WHERE page.id=$1`,
        [occupant.documentId],
      )).rows).toEqual([{
        current_path: plan.agents_occupant_preservation.path,
        current_version_id: plan.agents_occupant_preservation.revision.revision_id,
        published_version_id: occupant.revisionId,
        public_path: `legacy-agents-${suffix}`,
        title: "Private owner root",
        summary: "The current owner-authored root guide.",
        body_object_key: plan.agents_occupant_preservation.revision.body_object_key,
        body_size_bytes: occupantCurrent.object.body_size_bytes,
        body_content_hash: occupantCurrent.object.body_content_hash,
      }]);
      expect((await admin.query(
        `SELECT current_path,current_version_id,published_version_id,public_path
         FROM knowledge_pages WHERE id=$1`,
        [source.documentId],
      )).rows).toEqual([{
        current_path: `custom-global-guide-${suffix}`,
        current_version_id: source.revisionId,
        published_version_id: source.revisionId,
        public_path: `custom-global-guide-${suffix}`,
      }]);
      expect((await admin.query(
        `SELECT version.id,version.version_number,version.path,version.title,version.summary,
           revision.body_object_key,revision.body_size_bytes,revision.body_content_hash
         FROM knowledge_page_versions version
         JOIN hypermedia_document_revisions revision ON revision.id=version.id
         WHERE version.id=ANY($1::uuid[]) ORDER BY version.version_number`,
        [[occupant.revisionId,occupantCurrent.revisionId]],
      )).rows).toEqual([
        { id: occupant.revisionId,version_number: occupant.versionNumber,path: "agents",
          title: occupant.title,summary: occupant.summary,
          body_object_key: occupant.object.body_object_key,
          body_size_bytes: occupant.object.body_size_bytes,
          body_content_hash: occupant.object.body_content_hash },
        { id: occupantCurrent.revisionId,version_number: occupantCurrent.revisionNumber,
          path: "agents",title: "Private owner root",
          summary: "The current owner-authored root guide.",
          body_object_key: occupantCurrent.object.body_object_key,
          body_size_bytes: occupantCurrent.object.body_size_bytes,
          body_content_hash: occupantCurrent.object.body_content_hash },
      ]);
      for (const expected of [
        { artifact: sourceArtifact,page: source },
        { artifact: occupantArtifact,page: occupant },
      ]) {
        expect((await admin.query(
          `SELECT version_id,projection_generation,body_object_key,
             body_size_bytes,body_content_hash
           FROM published_page_artifacts WHERE artifact_id=$1`,
          [expected.artifact.artifactId],
        )).rows).toEqual([{
          version_id: expected.page.revisionId,
          projection_generation: expected.artifact.generation,
          body_object_key: expected.artifact.objectKey,
          body_size_bytes: expected.page.object.body_size_bytes,
          body_content_hash: expected.page.object.body_content_hash,
        }]);
      }
      expect((await admin.query(
        `SELECT path FROM knowledge_page_changes
         WHERE page_id=$1 AND version_id=$2 AND change_kind='created'`,
        [plan.replacement_document_id,plan.replacement_revision.revision_id],
      )).rows).toEqual([{ path: "agents" }]);
      const bodies = new Map([
        [plan.replacement_revision.body_object_key,managedBody],
        [descendant.object.body_object_key,descendantBody],
      ]);
      const store: MarkdownObjectStore = {
        async write() { throw new Error("not used"); },
        async read(object) {
          const markdown = bodies.get(object.body_object_key);
          if (markdown === undefined) throw new Error("fixture body missing");
          return markdown;
        },
      };
      const pages = new PageRepository(dashboardPool,store);
      expect((await pages.guidesForPath("unscoped/page")).map(({ id }) => id)).toEqual([
        plan.replacement_document_id,
      ]);
      expect((await pages.guidesForPath(`${scopedPath}/page`)).map(({ id }) => id)).toEqual([
        plan.replacement_document_id,descendant.documentId,
      ]);
    } finally {
      await admin.query("BEGIN");
      try {
        await admin.query("SET CONSTRAINTS ALL DEFERRED");
        await admin.query("SET LOCAL session_replication_role='replica'");
        if (replacementDocumentId) {
          await admin.query(
            `UPDATE knowledge_page_versions
             SET path=(SELECT replacement_path FROM operational_document_replacements
                       WHERE replacement_document_id=$1)
             WHERE id=(SELECT current_version_id FROM knowledge_pages WHERE id=$1)`,
            [replacementDocumentId],
          );
          await admin.query(
            `UPDATE knowledge_pages
             SET current_path=(SELECT replacement_path FROM operational_document_replacements
                               WHERE replacement_document_id=$1)
             WHERE id=$1`,
            [replacementDocumentId],
          );
        }
        if (existingOccupant) {
          await admin.query(
            `UPDATE knowledge_pages
             SET current_path='agents',current_version_id=$2,
                 published_version_id=$3,public_path=$4,archived_at=$5,
                 search_vector=$6::tsvector,updated_at=$7
             WHERE id=$1`,
            [existingOccupant.document_id,existingOccupant.revision_id,
              existingOccupant.published_version_id,existingOccupant.public_path,
              existingOccupant.archived_at,existingOccupant.search_vector,
              existingOccupant.updated_at],
          );
        }
        await admin.query(
          "UPDATE knowledge_settings SET global_guide_document_id=$1,updated_at=now() WHERE singleton",
          [originalGuideId],
        );
        await admin.query(
          `UPDATE knowledge_pages SET published_version_id=NULL,public_path=NULL
           WHERE id=ANY($1::uuid[])`,
          [[source.documentId,...(!existingOccupant ? [occupant.documentId] : [])]],
        );
        await admin.query("SET LOCAL session_replication_role='origin'");
        await admin.query(
          "DELETE FROM operational_document_replacements WHERE source_document_id=$1",
          [source.documentId],
        );
        const ids = [source.documentId,descendant.documentId,
          ...(!existingOccupant ? [occupant.documentId] : []),
          ...(replacementDocumentId ? [replacementDocumentId] : [])];
        await admin.query("DELETE FROM published_page_artifacts WHERE page_id=ANY($1::uuid[])", [ids]);
        await admin.query("DELETE FROM knowledge_page_changes WHERE page_id=ANY($1::uuid[])", [ids]);
        if (existingOccupant) {
          await admin.query(
            "DELETE FROM published_page_artifacts WHERE page_id=$1",
            [existingOccupant.document_id],
          );
          for (const artifact of priorOccupantArtifacts) {
            await admin.query(
              `INSERT INTO published_page_artifacts(
                 page_id,version_id,projection_generation,artifact_id,
                 body_object_key,body_size_bytes,body_content_hash,created_at
               ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
              [artifact.page_id,artifact.version_id,artifact.projection_generation,
                artifact.artifact_id,artifact.body_object_key,artifact.body_size_bytes,
                artifact.body_content_hash,artifact.created_at],
            );
          }
          const fixtureRevisionIds = [occupantCurrent.revisionId,
            ...(preservationRevisionId ? [preservationRevisionId] : [])];
          await admin.query(
            "DELETE FROM knowledge_page_changes WHERE version_id=ANY($1::uuid[])",
            [fixtureRevisionIds],
          );
          await admin.query(
            "DELETE FROM knowledge_page_versions WHERE id=ANY($1::uuid[])",
            [fixtureRevisionIds],
          );
          await admin.query(
            "DELETE FROM hypermedia_document_revisions WHERE id=ANY($1::uuid[])",
            [fixtureRevisionIds],
          );
        }
        await admin.query(
          "UPDATE knowledge_pages SET archived_at=now() WHERE id=ANY($1::uuid[])",
          [ids],
        );
        await admin.query("DELETE FROM knowledge_page_versions WHERE page_id=ANY($1::uuid[])", [ids]);
        await admin.query("DELETE FROM knowledge_pages WHERE id=ANY($1::uuid[])", [ids]);
        await admin.query("DELETE FROM hypermedia_document_revisions WHERE document_id=ANY($1::uuid[])", [ids]);
        await admin.query("DELETE FROM hypermedia_documents WHERE id=ANY($1::uuid[])", [ids]);
        await admin.query("DELETE FROM knowledge_directories WHERE current_path=$1", [scopedPath]);
        await admin.query("COMMIT");
      } catch (error) {
        await admin.query("ROLLBACK");
        throw error;
      }
    }
  });

  test("hands off a configured agents occupant without mutating its pinned revision", async () => {
    const suffix = randomUUID();
    const ownerBody = "# Owner-custom root\n\nThis private revision must be copied exactly.\n";
    const managedBody = "# Managed same-identity replacement\n";
    const originalGuideId = (await admin.query<{ global_guide_document_id: string | null }>(
      "SELECT global_guide_document_id FROM knowledge_settings WHERE singleton",
    )).rows[0]?.global_guide_document_id ?? null;
    const existingOccupant = (await admin.query<{
      document_id: string;
      revision_id: string;
      version_number: number;
      title: string;
      summary: string;
      body_object_key: string;
      body_size_bytes: number | string;
      body_content_hash: string;
      published_version_id: string | null;
      public_path: string | null;
      archived_at: Date | null;
      search_vector: string;
      updated_at: Date;
    }>(
      `SELECT page.id AS document_id,page.current_version_id AS revision_id,
         version.version_number,version.title,version.summary,
         revision.body_object_key,revision.body_size_bytes,revision.body_content_hash,
         page.published_version_id,page.public_path,page.archived_at,
         page.search_vector::text AS search_vector,page.updated_at
       FROM knowledge_pages page
       JOIN knowledge_page_versions version ON version.id=page.current_version_id
       JOIN hypermedia_document_revisions revision ON revision.id=version.id
       WHERE page.current_path='agents' AND page.archived_at IS NULL`,
    )).rows[0] ?? null;
    const priorArtifacts = existingOccupant ? (await admin.query<{
      page_id: string;
      version_id: string;
      projection_generation: number | string;
      artifact_id: string;
      body_object_key: string;
      body_size_bytes: number;
      body_content_hash: string;
      created_at: Date;
    }>(
      `SELECT page_id,version_id,projection_generation,artifact_id,
         body_object_key,body_size_bytes,body_content_hash,created_at
       FROM published_page_artifacts WHERE page_id=$1`,
      [existingOccupant.document_id],
    )).rows : [];
    const occupant = existingOccupant ? {
      documentId: existingOccupant.document_id,
      revisionId: existingOccupant.revision_id,
      object: {
        id: existingOccupant.revision_id,
        body_object_key: existingOccupant.body_object_key,
        body_size_bytes: Number(existingOccupant.body_size_bytes),
        body_content_hash: existingOccupant.body_content_hash,
      },
    } : await createPage({
      path: "agents",
      title: "Pinned same-identity root",
      summary: "The public revision retained during the handoff.",
      body: "# Pinned same-identity root\n",
    });
    const ownerRevision = await appendRevision({
      documentId: occupant.documentId,
      path: "agents",
      title: "Owner-custom root",
      summary: "The configured private root immediately before replacement.",
      body: ownerBody,
    });
    await admin.query("SET session_replication_role='replica'");
    try {
      await admin.query("DELETE FROM published_page_artifacts WHERE page_id=$1", [
        occupant.documentId,
      ]);
      await admin.query(
        `UPDATE knowledge_pages
         SET published_version_id=$2,public_path=$3
         WHERE id=$1`,
        [occupant.documentId,occupant.revisionId,`legacy-same-root-${suffix}`],
      );
      await admin.query(
        "UPDATE knowledge_settings SET global_guide_document_id=$1,updated_at=now() WHERE singleton",
        [occupant.documentId],
      );
    } finally {
      await admin.query("SET session_replication_role='origin'");
    }
    const artifact = await createPublishedArtifact(occupant);
    let replacementDocumentId: string | null = null;
    let preservationRevisionId: string | null = null;
    try {
      const managed = metadata(randomUUID(),managedBody);
      const planned = await repository.beginOrResume({
        target: { kind: "global_guide" },
        source_document_id: occupant.documentId,
        source_revision_id: ownerRevision.revisionId,
        managed: {
          title: "Managed same-identity guide",
          summary: "Private managed guidance at the rollback-compatible root path.",
          body_size_bytes: managed.body_size_bytes,
          body_content_hash: managed.body_content_hash,
        },
        actor_subject: "context-use-template/default",
      });
      replacementDocumentId = planned.replacement_document_id;
      preservationRevisionId = planned.agents_occupant_preservation?.revision.revision_id ?? null;
      expect(planned.agents_occupant_preservation).toMatchObject({
        document_id: occupant.documentId,
        source_revision_id: ownerRevision.revisionId,
        title: "Owner-custom root",
        summary: "The configured private root immediately before replacement.",
      });
      if (!planned.agents_occupant_preservation) {
        throw new Error("same-ID agents preservation was not allocated");
      }
      const input = {
        replacement_id: planned.replacement_id,
        revision: {
          id: planned.replacement_revision.revision_id,
          body_object_key: planned.replacement_revision.body_object_key,
          body_size_bytes: managed.body_size_bytes,
          body_content_hash: managed.body_content_hash,
        },
        body_markdown_for_index: managedBody,
        target_document_ids: [],
        agents_occupant_preservation: {
          revision: {
            id: planned.agents_occupant_preservation.revision.revision_id,
            body_object_key: planned.agents_occupant_preservation.revision.body_object_key,
            body_size_bytes: ownerRevision.object.body_size_bytes,
            body_content_hash: ownerRevision.object.body_content_hash,
          },
          body_markdown_for_index: ownerBody,
          target_document_ids: [],
        },
      };
      const applied = await repository.apply(input);
      expect(await repository.apply(input)).toEqual(applied);
      expect((await admin.query(
        `SELECT settings.global_guide_document_id,
           target.current_path AS target_path,source.current_path AS source_path,
           source.current_version_id,
           source.published_version_id,source.public_path
         FROM knowledge_settings settings
         JOIN knowledge_pages target ON target.id=settings.global_guide_document_id
         JOIN knowledge_pages source ON source.id=$1
         WHERE settings.singleton`,
        [occupant.documentId],
      )).rows).toEqual([{
        global_guide_document_id: planned.replacement_document_id,
        target_path: "agents",
        source_path: planned.agents_occupant_preservation.path,
        current_version_id: planned.agents_occupant_preservation.revision.revision_id,
        published_version_id: occupant.revisionId,
        public_path: `legacy-same-root-${suffix}`,
      }]);
      const sourceAfter = (await admin.query(
        `SELECT current_path,current_version_id,published_version_id,public_path
         FROM knowledge_pages WHERE id=$1`,
        [occupant.documentId],
      )).rows[0];
      expect(sourceAfter).toEqual({
        current_path: planned.agents_occupant_preservation.path,
        current_version_id: planned.agents_occupant_preservation.revision.revision_id,
        published_version_id: occupant.revisionId,
        public_path: `legacy-same-root-${suffix}`,
      });
      expect((await admin.query(
        `SELECT version.path,version.title,version.summary,
           revision.body_object_key,revision.body_size_bytes,revision.body_content_hash
         FROM knowledge_page_versions version
         JOIN hypermedia_document_revisions revision ON revision.id=version.id
         WHERE version.id=$1`,
        [occupant.revisionId],
      )).rows).toEqual([{
        path: "agents",
        title: existingOccupant?.title ?? "Pinned same-identity root",
        summary: existingOccupant?.summary ?? "The public revision retained during the handoff.",
        body_object_key: occupant.object.body_object_key,
        body_size_bytes: occupant.object.body_size_bytes,
        body_content_hash: occupant.object.body_content_hash,
      }]);
      expect((await admin.query(
        `SELECT version_id,projection_generation,artifact_id,body_object_key,
           body_size_bytes,body_content_hash
         FROM published_page_artifacts WHERE artifact_id=$1`,
        [artifact.artifactId],
      )).rows).toEqual([{
        version_id: occupant.revisionId,
        projection_generation: artifact.generation,
        artifact_id: artifact.artifactId,
        body_object_key: artifact.objectKey,
        body_size_bytes: occupant.object.body_size_bytes,
        body_content_hash: occupant.object.body_content_hash,
      }]);
    } finally {
      await admin.query("BEGIN");
      try {
        await admin.query("SET CONSTRAINTS ALL DEFERRED");
        await admin.query("SET LOCAL session_replication_role='replica'");
        if (replacementDocumentId) {
          await admin.query(
            `UPDATE knowledge_page_versions
             SET path=(SELECT replacement_path FROM operational_document_replacements
                       WHERE replacement_document_id=$1)
             WHERE id=(SELECT current_version_id FROM knowledge_pages WHERE id=$1)`,
            [replacementDocumentId],
          );
          await admin.query(
            `UPDATE knowledge_pages
             SET current_path=(SELECT replacement_path FROM operational_document_replacements
                               WHERE replacement_document_id=$1)
             WHERE id=$1`,
            [replacementDocumentId],
          );
        }
        if (existingOccupant) {
          await admin.query(
            `UPDATE knowledge_pages
             SET current_path='agents',current_version_id=$2,
                 published_version_id=$3,public_path=$4,archived_at=$5,
                 search_vector=$6::tsvector,updated_at=$7
             WHERE id=$1`,
            [existingOccupant.document_id,existingOccupant.revision_id,
              existingOccupant.published_version_id,existingOccupant.public_path,
              existingOccupant.archived_at,existingOccupant.search_vector,
              existingOccupant.updated_at],
          );
        }
        await admin.query(
          "UPDATE knowledge_settings SET global_guide_document_id=$1,updated_at=now() WHERE singleton",
          [originalGuideId],
        );
        await admin.query(
          `UPDATE knowledge_pages SET published_version_id=NULL,public_path=NULL
           WHERE id=ANY($1::uuid[])`,
          [[...(!existingOccupant ? [occupant.documentId] : [])]],
        );
        await admin.query("SET LOCAL session_replication_role='origin'");
        await admin.query(
          "DELETE FROM operational_document_replacements WHERE source_document_id=$1",
          [occupant.documentId],
        );
        if (existingOccupant) {
          await admin.query("DELETE FROM published_page_artifacts WHERE page_id=$1", [
            occupant.documentId,
          ]);
          for (const prior of priorArtifacts) {
            await admin.query(
              `INSERT INTO published_page_artifacts(
                 page_id,version_id,projection_generation,artifact_id,
                 body_object_key,body_size_bytes,body_content_hash,created_at
               ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
              [prior.page_id,prior.version_id,prior.projection_generation,prior.artifact_id,
                prior.body_object_key,prior.body_size_bytes,prior.body_content_hash,prior.created_at],
            );
          }
          const revisionIds = [ownerRevision.revisionId,
            ...(preservationRevisionId ? [preservationRevisionId] : [])];
          await admin.query("DELETE FROM knowledge_page_changes WHERE version_id=ANY($1::uuid[])", [
            revisionIds,
          ]);
          await admin.query("DELETE FROM knowledge_page_versions WHERE id=ANY($1::uuid[])", [
            revisionIds,
          ]);
          await admin.query(
            "DELETE FROM hypermedia_document_revisions WHERE id=ANY($1::uuid[])",
            [revisionIds],
          );
        }
        const ids = [...(!existingOccupant ? [occupant.documentId] : []),
          ...(replacementDocumentId ? [replacementDocumentId] : [])];
        await admin.query("DELETE FROM published_page_artifacts WHERE page_id=ANY($1::uuid[])", [ids]);
        await admin.query("DELETE FROM knowledge_page_changes WHERE page_id=ANY($1::uuid[])", [ids]);
        await admin.query("UPDATE knowledge_pages SET archived_at=now() WHERE id=ANY($1::uuid[])", [ids]);
        await admin.query("DELETE FROM knowledge_page_versions WHERE page_id=ANY($1::uuid[])", [ids]);
        await admin.query("DELETE FROM knowledge_pages WHERE id=ANY($1::uuid[])", [ids]);
        await admin.query("DELETE FROM hypermedia_document_revisions WHERE document_id=ANY($1::uuid[])", [ids]);
        await admin.query("DELETE FROM hypermedia_documents WHERE id=ANY($1::uuid[])", [ids]);
        await admin.query("COMMIT");
      } catch (error) {
        await admin.query("ROLLBACK");
        throw error;
      }
    }
  });

  test("installs the managed guide directly at agents when no occupant exists", async () => {
    const suffix = randomUUID();
    const managedBody = "# Managed guide for an empty root path\n";
    const originalGuideId = (await admin.query<{ global_guide_document_id: string | null }>(
      "SELECT global_guide_document_id FROM knowledge_settings WHERE singleton",
    )).rows[0]?.global_guide_document_id ?? null;
    const priorOccupant = (await admin.query<{
      document_id: string;
      revision_id: string;
      version_path: string;
      search_vector: string;
      updated_at: Date;
    }>(
      `SELECT page.id AS document_id,page.current_version_id AS revision_id,
         version.path AS version_path,page.search_vector::text AS search_vector,page.updated_at
       FROM knowledge_pages page
       JOIN knowledge_page_versions version ON version.id=page.current_version_id
       WHERE page.current_path='agents' AND page.archived_at IS NULL`,
    )).rows[0] ?? null;
    const temporarilyVacatedPath = `vacated-agents-${suffix}`;
    const source = await createPage({
      path: `off-path-guide-${suffix}`,
      title: "Off-path configured guide",
      summary: "The source guide used when the legacy root path is empty.",
      body: "# Off-path source guide\n",
    });
    await admin.query("SET session_replication_role='replica'");
    try {
      if (priorOccupant) {
        await admin.query("UPDATE knowledge_page_versions SET path=$2 WHERE id=$1", [
          priorOccupant.revision_id,temporarilyVacatedPath,
        ]);
        await admin.query(
          "UPDATE knowledge_pages SET current_path=$2,updated_at=now() WHERE id=$1",
          [priorOccupant.document_id,temporarilyVacatedPath],
        );
      }
      await admin.query(
        "UPDATE knowledge_settings SET global_guide_document_id=$1,updated_at=now() WHERE singleton",
        [source.documentId],
      );
    } finally {
      await admin.query("SET session_replication_role='origin'");
    }
    let replacementDocumentId: string | null = null;
    try {
      const managed = metadata(randomUUID(),managedBody);
      const planned = await repository.beginOrResume({
        target: { kind: "global_guide" },
        source_document_id: source.documentId,
        source_revision_id: source.revisionId,
        managed: {
          title: "Managed empty-root guide",
          summary: "Private managed guidance installed at the legacy root path.",
          body_size_bytes: managed.body_size_bytes,
          body_content_hash: managed.body_content_hash,
        },
        actor_subject: "context-use-template/default",
      });
      replacementDocumentId = planned.replacement_document_id;
      expect(planned.agents_occupant_preservation).toBeNull();
      const applied = await repository.apply({
        replacement_id: planned.replacement_id,
        revision: {
          id: planned.replacement_revision.revision_id,
          body_object_key: planned.replacement_revision.body_object_key,
          body_size_bytes: managed.body_size_bytes,
          body_content_hash: managed.body_content_hash,
        },
        body_markdown_for_index: managedBody,
        target_document_ids: [],
      });
      expect(applied.phase).toBe("applied");
      expect((await admin.query(
        `SELECT settings.global_guide_document_id,page.current_path,version.path,
           page.current_version_id
         FROM knowledge_settings settings
         JOIN knowledge_pages page ON page.id=settings.global_guide_document_id
         JOIN knowledge_page_versions version ON version.id=page.current_version_id
         WHERE settings.singleton`,
      )).rows).toEqual([{
        global_guide_document_id: planned.replacement_document_id,
        current_path: "agents",
        path: "agents",
        current_version_id: planned.replacement_revision.revision_id,
      }]);
    } finally {
      await admin.query("BEGIN");
      try {
        await admin.query("SET CONSTRAINTS ALL DEFERRED");
        await admin.query("SET LOCAL session_replication_role='replica'");
        if (replacementDocumentId) {
          await admin.query(
            `UPDATE knowledge_page_versions
             SET path=(SELECT replacement_path FROM operational_document_replacements
                       WHERE replacement_document_id=$1)
             WHERE id=(SELECT current_version_id FROM knowledge_pages WHERE id=$1)`,
            [replacementDocumentId],
          );
          await admin.query(
            `UPDATE knowledge_pages
             SET current_path=(SELECT replacement_path FROM operational_document_replacements
                               WHERE replacement_document_id=$1)
             WHERE id=$1`,
            [replacementDocumentId],
          );
        }
        if (priorOccupant) {
          await admin.query("UPDATE knowledge_page_versions SET path=$2 WHERE id=$1", [
            priorOccupant.revision_id,priorOccupant.version_path,
          ]);
          await admin.query(
            `UPDATE knowledge_pages
             SET current_path='agents',search_vector=$2::tsvector,updated_at=$3 WHERE id=$1`,
            [priorOccupant.document_id,priorOccupant.search_vector,priorOccupant.updated_at],
          );
        }
        await admin.query(
          "UPDATE knowledge_settings SET global_guide_document_id=$1,updated_at=now() WHERE singleton",
          [originalGuideId],
        );
        await admin.query("SET LOCAL session_replication_role='origin'");
        await admin.query(
          "DELETE FROM operational_document_replacements WHERE source_document_id=$1",
          [source.documentId],
        );
        const ids = [source.documentId,
          ...(replacementDocumentId ? [replacementDocumentId] : [])];
        await admin.query("DELETE FROM knowledge_page_changes WHERE page_id=ANY($1::uuid[])", [ids]);
        await admin.query("UPDATE knowledge_pages SET archived_at=now() WHERE id=ANY($1::uuid[])", [ids]);
        await admin.query("DELETE FROM knowledge_page_versions WHERE page_id=ANY($1::uuid[])", [ids]);
        await admin.query("DELETE FROM knowledge_pages WHERE id=ANY($1::uuid[])", [ids]);
        await admin.query("DELETE FROM hypermedia_document_revisions WHERE document_id=ANY($1::uuid[])", [ids]);
        await admin.query("DELETE FROM hypermedia_documents WHERE id=ANY($1::uuid[])", [ids]);
        await admin.query("COMMIT");
      } catch (error) {
        await admin.query("ROLLBACK");
        throw error;
      }
    }
  });
});
