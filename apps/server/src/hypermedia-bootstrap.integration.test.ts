import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client, Pool } from "pg";
import {
  AutomationRegistryRepository,
  defaultHypermediaBootstrapTemplate,
  HypermediaBootstrapRepository,
  KnowledgePageRepository,
  KnowledgeSettingsRepository,
  markdownBlobMetadata,
  type MarkdownBlobMetadata,
  type MarkdownBlobStore,
} from "@context-use/database";
import { disposableDatabaseUrl } from "@context-use/database/disposable-database";
import { developmentResetSql } from "../../../packages/database/src/reset-development.ts";
import {
  applyHypermediaBootstrap,
  hypermediaBootstrapPages,
  synchronizeGlobalGuide,
} from "./hypermedia-bootstrap-command.ts";

const enabled = process.env.TEST_HYPERMEDIA_BOOTSTRAP_ISOLATED === "1";
const describeBootstrap = enabled ? describe : describe.skip;
const adminUrl = await disposableDatabaseUrl();
const corpusUrl = process.env.CORPUS_DATABASE_URL;
const admin = enabled ? new Client({ connectionString: adminUrl }) : null;
const corpus = enabled && corpusUrl ? new Pool({ connectionString: corpusUrl }) : null;
const objects = new Map<string, string>();
const bodies: MarkdownBlobStore = {
  async write(revisionId, markdown) {
    const metadata = markdownBlobMetadata(revisionId, markdown);
    const existing = objects.get(metadata.body_object_key);
    if (existing !== undefined && existing !== markdown) {
      throw new Error("Bootstrap object changed across replay");
    }
    objects.set(metadata.body_object_key, markdown);
    return metadata;
  },
  async read(metadata: MarkdownBlobMetadata) {
    const markdown = objects.get(metadata.body_object_key);
    if (markdown === undefined) throw new Error("Bootstrap object is missing");
    return markdown;
  },
};

describeBootstrap("fresh hypermedia bootstrap", () => {
  beforeAll(async () => {
    if (!corpusUrl) throw new Error("CORPUS_DATABASE_URL is required");
    await admin!.connect();
    await admin!.query(developmentResetSql());
  });

  afterAll(async () => {
    try {
      await corpus?.end();
      await admin?.query(developmentResetSql());
    } finally {
      await admin?.end();
    }
  });

  test("installs and replays an identity-wired object-backed knowledge contract", async () => {
    const bootstrap = new HypermediaBootstrapRepository(corpus!, bodies);
    const retainedDocumentId = crypto.randomUUID();
    await admin!.query(
      `INSERT INTO hypermedia_documents(id,authority,representation)
       VALUES ($1,'source','markdown')`,
      [retainedDocumentId],
    );
    await expect(bootstrap.begin()).rejects.toThrow(
      "hypermedia bootstrap requires an empty installation",
    );
    expect((await admin!.query(
      "SELECT count(*)::integer AS count FROM hypermedia_bootstrap_allocations",
    )).rows[0]?.count).toBe(0);
    await admin!.query("DELETE FROM hypermedia_documents WHERE id=$1", [retainedDocumentId]);

    const allocations = await bootstrap.begin();
    expect(await bootstrap.begin()).toEqual(allocations);
    const allocatedIds = allocations.flatMap(({ document_id, revision_id }) => [
      document_id,
      revision_id,
    ]);
    expect((await admin!.query<{ reserved: boolean }>(
      `SELECT bool_and(public_uuid_has_private_identity(id)) AS reserved
       FROM unnest($1::uuid[]) AS id`,
      [allocatedIds],
    )).rows[0]?.reserved).toBe(true);
    await admin!.query("BEGIN");
    try {
      await expect(admin!.query(
        `UPDATE hypermedia_bootstrap_allocations
         SET document_id=gen_random_uuid()
         WHERE object_kind='global_guide'`,
      )).rejects.toMatchObject({ code: "55000" });
    } finally {
      await admin!.query("ROLLBACK");
    }
    const documents = hypermediaBootstrapPages(defaultHypermediaBootstrapTemplate, allocations);
    const completedAt = await applyHypermediaBootstrap({
      allocations,
      template: defaultHypermediaBootstrapTemplate,
      repositories: {
        bootstrap,
        settings: new KnowledgeSettingsRepository(corpus!),
        registry: new AutomationRegistryRepository(corpus!),
      },
    });

    expect(allocations).toHaveLength(5);
    expect(completedAt).toBeTruthy();
    expect(await bootstrap.begin()).toEqual([]);
    for (const document of documents) await bootstrap.ensurePage(document);
    expect(await bootstrap.complete()).toEqual(completedAt);

    const state = await admin!.query<{
      pages: string;
      revisions: string;
      contracts: string;
      search: string;
      completed_allocations: string;
      automations: string;
      guide_configured: boolean;
      entrypoint_latched: boolean;
    }>(
      `SELECT
         (SELECT count(*)::text FROM knowledge_pages) AS documents,
         (SELECT count(*)::text FROM hypermedia_document_revisions) AS revisions,
         (SELECT count(*)::text FROM knowledge_revision_contracts) AS contracts,
         (SELECT count(*)::text FROM knowledge_search) AS search,
         (SELECT count(*)::text FROM hypermedia_bootstrap_allocations
           WHERE completed_at IS NOT NULL) AS completed_allocations,
         (SELECT count(*)::text FROM automation_registry WHERE disabled_at IS NULL)
           AS automations,
         (SELECT global_guide_document_id IS NOT NULL FROM knowledge_settings WHERE singleton)
           AS guide_configured,
         (SELECT updated_at IS NOT NULL FROM publication_settings WHERE singleton)
           AS entrypoint_latched`,
    );
    expect(state.rows[0]).toEqual({
      pages: "5",
      revisions: "5",
      contracts: "5",
      search: "5",
      completed_allocations: "5",
      automations: "2",
      guide_configured: true,
      entrypoint_latched: true,
    });
    expect(objects.size).toBe(5);

    const settings = new KnowledgeSettingsRepository(corpus!);
    const knowledgePages = new KnowledgePageRepository(corpus!, bodies);
    const current = await synchronizeGlobalGuide({
      repositories: { settings, pages: knowledgePages },
      guide: defaultHypermediaBootstrapTemplate.pages.global_guide,
      templateName: defaultHypermediaBootstrapTemplate.name,
    });
    expect(current).toMatchObject({ revision_number: 1, updated: false });

    const changedGuide = {
      ...defaultHypermediaBootstrapTemplate.pages.global_guide,
      body_markdown: `${defaultHypermediaBootstrapTemplate.pages.global_guide.body_markdown}\nManaged upgrade.\n`,
    };
    const updated = await synchronizeGlobalGuide({
      repositories: { settings, pages: knowledgePages },
      guide: changedGuide,
      templateName: defaultHypermediaBootstrapTemplate.name,
    });
    expect(updated).toMatchObject({
      object_id: current.object_id,
      revision_number: 2,
      updated: true,
    });
    expect(await knowledgePages.get(current.object_id)).toMatchObject({
      revision_number: 2,
      body_markdown: changedGuide.body_markdown,
    });
    expect(await synchronizeGlobalGuide({
      repositories: { settings, pages: knowledgePages },
      guide: changedGuide,
      templateName: defaultHypermediaBootstrapTemplate.name,
    })).toMatchObject({ revision_number: 2, updated: false });
  }, 15_000);
});
