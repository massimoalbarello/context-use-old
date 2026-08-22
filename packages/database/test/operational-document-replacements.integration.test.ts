import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client, Pool } from "pg";
import { disposableDatabaseUrl } from "../src/disposable-database.ts";
import { OperationalDocumentReplacementRepository } from "../src/operational-document-replacements.ts";

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

  test("replaces a custom configured guide by ID without moving or rewriting the owner page", async () => {
    const suffix = randomUUID();
    const sourceBody = "# Owner-custom global guide\n\nPreserve this page as ordinary knowledge.\n";
    const managedBody = "# Managed global maintenance guide\n";
    const source = await createPage({
      path: `custom-global-guide-${suffix}`,
      title: "Owner global guide",
      summary: "Owner-authored guidance that must survive operational replacement.",
      body: sourceBody,
    });
    const originalGuideId = (await admin.query<{ global_guide_document_id: string | null }>(
      "SELECT global_guide_document_id FROM knowledge_settings WHERE singleton",
    )).rows[0]?.global_guide_document_id;
    if (!originalGuideId) throw new Error("global guide fixture is missing");
    await admin.query(
      "UPDATE knowledge_settings SET global_guide_document_id=$1,updated_at=now() WHERE singleton",
      [source.documentId],
    );
    let replacementDocumentId: string | null = null;
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
        "SELECT global_guide_document_id FROM knowledge_settings WHERE singleton",
      )).rows).toEqual([{ global_guide_document_id: plan.replacement_document_id }]);
      expect((await admin.query(
        `SELECT page.current_path,page.current_version_id,version.title,version.summary
         FROM knowledge_pages page
         JOIN knowledge_page_versions version ON version.id=page.current_version_id
         WHERE page.id=$1`,
        [source.documentId],
      )).rows).toEqual([{
        current_path: `custom-global-guide-${suffix}`,
        current_version_id: source.revisionId,
        title: "Owner global guide",
        summary: "Owner-authored guidance that must survive operational replacement.",
      }]);
    } finally {
      await admin.query("BEGIN");
      try {
        await admin.query("SET CONSTRAINTS ALL DEFERRED");
        await admin.query(
          "UPDATE knowledge_settings SET global_guide_document_id=$1,updated_at=now() WHERE singleton",
          [originalGuideId],
        );
        await admin.query(
          "DELETE FROM operational_document_replacements WHERE source_document_id=$1",
          [source.documentId],
        );
        const ids = [source.documentId,
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
});
