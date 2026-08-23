import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { MarkdownObjectMetadata } from "./documents.ts";
import { extractDocumentLinks } from "./links.ts";

export type CorpusMigrationPhase = "applying" | "ready" | "superseded";
export type CorpusMigrationItemKind = "directory" | "page" | "asset" | "record";
export type CorpusDirectoryDisposition =
  | "root_entrypoint"
  | "operational"
  | "public_compatibility"
  | "hub"
  | "retired_template_scaffold";

export class CorpusMigrationInventoryDriftError extends Error {
  readonly code = "corpus_migration_inventory_drift";

  constructor(message: string, readonly run_id: string | null = null) {
    super(message);
    this.name = "CorpusMigrationInventoryDriftError";
  }
}

export type CorpusObjectRef = MarkdownObjectMetadata & {
  revision_id: string;
  revision_number: number;
  links_indexed_at: Date | string | null;
};

export type CorpusPublicAlias = {
  alias_path: string;
  route_kind: "page" | "directory" | "markdown" | "asset";
};

export type CorpusPublishedArtifactRef = MarkdownObjectMetadata & {
  artifact_id: string;
  projection_generation: string;
};

export type LegacyCorpusDirectory = {
  directory_id: string;
  path: string;
  parent_path: string | null;
  version_number: number;
  title: string;
  summary: string;
  created_at: Date | string;
  updated_at: Date | string;
  legacy_public_reachable: boolean;
  public_title: string | null;
  public_summary: string | null;
  has_existing_hub: boolean;
  direct_directory_ids: string[];
  direct_page_ids: string[];
  direct_asset_ids: string[];
};

export type LegacyCorpusPage = {
  document_id: string;
  path: string;
  title: string;
  summary: string;
  archived_at: Date | string | null;
  current_revision: CorpusObjectRef;
  published_revision: CorpusObjectRef | null;
  published_artifact: CorpusPublishedArtifactRef | null;
  published_title: string | null;
  published_summary: string | null;
  public_path: string | null;
  public_id: string | null;
  public_aliases: CorpusPublicAlias[];
  is_global_guide: boolean;
};

export type LegacyCorpusAsset = {
  document_id: string;
  path: string;
  deleted_at: Date | string | null;
  filename: string;
  content_type: string;
  size_bytes: number;
  content_hash: string;
  object_key: string;
  public_path: string | null;
  public_id: string | null;
  public_aliases: CorpusPublicAlias[];
};

export type LegacyCorpusRecord = {
  document_id: string;
  integration: string;
  connection_id: string;
  connection_instance_id: string | null;
  model: string;
  source_record_id: string;
  source_created_at: Date | string | null;
  source_updated_at: Date | string;
  deleted_at: Date | string | null;
  current_revision: CorpusObjectRef | null;
};

export type CorpusMigrationInspection = {
  active_run_id: string | null;
  inventory_token: string;
  readable_document_ids: string[];
  global_guide_document_id: string | null;
  public_entrypoint_document_id: string | null;
  automation_registrations: CorpusAutomationRegistration[];
  directories: LegacyCorpusDirectory[];
  pages: LegacyCorpusPage[];
  assets: LegacyCorpusAsset[];
  records: LegacyCorpusRecord[];
};

export type CorpusAutomationRegistration = {
  id: string;
  key: string;
  name: string;
  instructions_document_id: string;
  state_document_id: string | null;
  disabled_at: Date | string | null;
};

export type PlannedCorpusAutomation = {
  id: string;
  key: string;
  name: string;
  instructions_document_id: string;
  state_document_id: string | null;
};

export type PlannedRevisionRef = {
  revision_id: string;
  revision_number: number;
  body_object_key: string;
};

export type PlannedCorpusDirectory = LegacyCorpusDirectory & {
  disposition: CorpusDirectoryDisposition;
  hub: null | {
    document_id: string;
    temporary_path: string;
    private_revision_mode: "render" | "copy" | "existing";
    public_revision_mode: "render" | "existing" | null;
    private_revision: PlannedRevisionRef;
    public_revision: PlannedRevisionRef | null;
    private_source_revision: CorpusObjectRef | null;
    public_source_revision: CorpusObjectRef | null;
    public_body_markdown: string | null;
    public_id: string | null;
  };
};

export type PlannedCorpusPage = LegacyCorpusPage & {
  rewrite_revision: PlannedRevisionRef | null;
};

export type CorpusMigrationPlan = {
  run_id: string;
  inventory_token: string;
  phase: "applying" | "ready";
  readable_document_ids: string[];
  global_guide_document_id: string | null;
  public_entrypoint_document_id: string | null;
  directories: PlannedCorpusDirectory[];
  pages: PlannedCorpusPage[];
  assets: LegacyCorpusAsset[];
  records: LegacyCorpusRecord[];
  automations: PlannedCorpusAutomation[];
};

export type BeginCorpusMigrationInput = {
  inventory_token: string;
  actor_subject: string;
  directories: Array<{
    directory_id: string;
    disposition: CorpusDirectoryDisposition;
  }>;
  automations: Array<{
    key: string;
    name: string;
    instructions_document_id: string;
    state_document_id: string | null;
  }>;
};

export type CompleteExistingCorpusItemInput = {
  run_id: string;
  item_kind: "page" | "asset" | "record";
  item_id: string;
  verified_revision_ids: string[];
  verified_public_artifact_ids: string[];
  body_markdown_for_index?: string;
  target_document_ids?: string[];
  actor_subject: string;
};

export type PlannedObjectWrite = MarkdownObjectMetadata & {
  id: string;
  body_object_key: string;
};

export type ApplyCorpusPageInput = {
  run_id: string;
  document_id: string;
  source_revision_id: string;
  revision: PlannedObjectWrite;
  body_markdown_for_index: string;
  target_document_ids: string[];
  verified_source_revision_ids: string[];
  verified_public_artifact_ids: string[];
  actor_subject: string;
};

export type ApplyDirectoryHubInput = {
  run_id: string;
  directory_id: string;
  private_revision: PlannedObjectWrite & {
    body_markdown_for_index: string;
    target_document_ids: string[];
  };
  public_revision: null | PlannedObjectWrite & {
    body_markdown_for_index: string;
    target_document_ids: string[];
  };
  actor_subject: string;
};

export type CorpusMigrationBlocker = {
  code: string;
  item_kind?: CorpusMigrationItemKind;
  item_id?: string;
  detail: string;
};

export type CorpusMigrationStatus = {
  run_id: string;
  phase: CorpusMigrationPhase;
  inventory_token: string;
  counts: { total: number; completed: number };
  blockers: CorpusMigrationBlocker[];
};

export type CorpusReadyObject = {
  document_id: string;
  kind: "knowledge" | "published";
  revision: CorpusObjectRef;
  target_document_ids: string[];
  indexed_document_ids: string[];
  target_asset_ids: string[];
};

export type HydrateCorpusKnowledgeInput = {
  run_id: string;
  document_id: string;
  revision_id: string;
  body_markdown_for_index: string;
  target_document_ids: string[];
};

type InventoryItem = {
  item_kind: CorpusMigrationItemKind;
  item_id: string;
  legacy_path: string;
  source_fingerprint: string;
  snapshot: LegacyCorpusDirectory | LegacyCorpusPage | LegacyCorpusAsset | LegacyCorpusRecord;
};

type RunRow = {
  id: string;
  inventory_token: string;
  plan_token: string;
  settings_snapshot: {
    global_guide_document_id: string | null;
    public_entrypoint_document_id: string | null;
  };
  readable_document_ids: string[];
  phase: CorpusMigrationPhase;
};

function canonical(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== "links_indexed_at")
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([key, entry]) => [key, canonical(entry)]));
  }
  return value;
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.map((value) => value.toLowerCase()))].sort();
}

function aliases(value: unknown): CorpusPublicAlias[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => entry as CorpusPublicAlias)
    .sort((left, right) => left.alias_path.localeCompare(right.alias_path, "en"));
}

function objectRef(row: Record<string, unknown>, prefix: string): CorpusObjectRef | null {
  const revisionId = row[`${prefix}_revision_id`];
  if (typeof revisionId !== "string") return null;
  return {
    revision_id: revisionId,
    revision_number: Number(row[`${prefix}_revision_number`]),
    body_object_key: String(row[`${prefix}_body_object_key`]),
    body_size_bytes: Number(row[`${prefix}_body_size_bytes`]),
    body_content_hash: String(row[`${prefix}_body_content_hash`]),
    links_indexed_at: row[`${prefix}_links_indexed_at`] as Date | string | null,
  };
}

function assertObjectWrite(write: PlannedObjectWrite): void {
  if (write.body_object_key !== `documents/private/${write.id.toLowerCase()}.md`
      || !Number.isSafeInteger(write.body_size_bytes)
      || write.body_size_bytes < 0
      || write.body_size_bytes > 4_000_000
      || !/^[a-f0-9]{64}$/.test(write.body_content_hash)) {
    throw new Error("Corpus migration object metadata is invalid");
  }
}

function assertBodyMatches(write: PlannedObjectWrite, body: string): void {
  assertObjectWrite(write);
  const bytes = Buffer.from(body, "utf8");
  if (bytes.byteLength !== write.body_size_bytes
      || createHash("sha256").update(bytes).digest("hex") !== write.body_content_hash) {
    throw new Error("Corpus migration object metadata does not match its Markdown");
  }
}

function assertExistingBodyMatches(ref: CorpusObjectRef, body: string): void {
  assertBodyMatches({
    id: ref.revision_id,
    body_object_key: ref.body_object_key,
    body_size_bytes: ref.body_size_bytes,
    body_content_hash: ref.body_content_hash,
  }, body);
}

async function exactDocumentTargets(
  client: Pick<Pool, "query">,
  runId: string,
  body: string,
  submitted: string[],
  label: string,
  requireAllTargets = false,
): Promise<{ receipt: string[]; indexed: string[] }> {
  const targets = uniqueSorted(submitted);
  if (JSON.stringify(targets) !== JSON.stringify(uniqueSorted(extractDocumentLinks(body)))) {
    throw new Error(`${label} link receipt does not match its Markdown`);
  }
  if (targets.length > 100_000) throw new Error(`${label} has too many document links`);
  const indexed = targets.length ? (await client.query<{ id: string }>(
    `SELECT document.id
     FROM hypermedia_documents document
     JOIN corpus_migration_runs run
       ON run.id=$1 AND document.id=ANY(run.readable_document_ids)
     WHERE document.id=ANY($2::uuid[])
     ORDER BY document.id`,
    [runId, targets],
  )).rows.map(({ id }) => id) : [];
  if (requireAllTargets) {
    try {
      await client.query(
        "SELECT lock_corpus_migration_generated_targets($1,$2::uuid[])",
        [runId, targets],
      );
    } catch (error) {
      if ((error as { code?: string }).code === "23514") {
        throw new Error(`${label} contains a dangling document link`);
      }
      throw error;
    }
    if (indexed.length !== targets.length) {
      throw new Error(`${label} contains a dangling document link`);
    }
  }
  return { receipt: targets, indexed };
}

async function replaceKnowledgeProjections(
  client: Pick<Pool, "query">,
  revisionId: string,
  targetIds: string[],
): Promise<void> {
  await client.query(
    "SELECT replace_knowledge_revision_projections($1,$2::uuid[])",
    [revisionId, targetIds],
  );
}

async function hydrateCorpusKnowledge(
  client: Pick<Pool, "query">,
  input: HydrateCorpusKnowledgeInput,
): Promise<void> {
  await client.query(
    `SELECT hydrate_corpus_knowledge_revision(
       $1,$2,$3,$4,$5::uuid[]
     )`,
    [input.run_id, input.document_id, input.revision_id,
      input.body_markdown_for_index, uniqueSorted(input.target_document_ids)],
  );
}

async function transaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('filesystem-hypermedia-corpus-transition',0))",
    );
    await client.query("SET CONSTRAINTS ALL DEFERRED");
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

async function activeRun(client: Pick<Pool, "query">): Promise<RunRow | null> {
  const result = await client.query<RunRow>(
    `SELECT id,inventory_token,plan_token,settings_snapshot,readable_document_ids,phase
     FROM corpus_migration_runs
     WHERE phase IN ('applying','ready')
     ORDER BY created_at DESC LIMIT 1`,
  );
  return result.rows[0] ?? null;
}

async function throwForMissingActiveRunItem(
  client: Pick<Pool, "query">,
  runId: string,
  fallbackMessage: string,
): Promise<never> {
  const phase = (await client.query<{ phase: CorpusMigrationPhase }>(
    "SELECT phase FROM corpus_migration_runs WHERE id=$1",
    [runId],
  )).rows[0]?.phase;
  if (phase === "superseded") {
    throw new CorpusMigrationInventoryDriftError(
      "Corpus migration was superseded by concurrent authority drift",
      runId,
    );
  }
  throw new Error(fallbackMessage);
}

async function liveInspection(
  client: Pick<Pool, "query">,
  activeRunId: string | null,
): Promise<CorpusMigrationInspection> {
  const settingsResult = await client.query<{
    global_guide_document_id: string | null;
    public_entrypoint_document_id: string | null;
  }>(
    `SELECT knowledge.global_guide_document_id,
       entrypoint.id AS public_entrypoint_document_id
     FROM knowledge_settings knowledge
     CROSS JOIN public_knowledge_settings publication
     LEFT JOIN knowledge_pages entrypoint
       ON entrypoint.id=publication.entrypoint_page_id
      AND entrypoint.archived_at IS NULL
      AND entrypoint.published_version_id IS NOT NULL
      AND entrypoint.public_path IS NOT NULL
     WHERE knowledge.singleton AND publication.singleton`,
  );
  const settings = settingsResult.rows[0];
  if (!settings) throw new Error("Knowledge/public settings singletons are missing");

  const automationRegistrations = (await client.query<CorpusAutomationRegistration>(
    `SELECT id,key,name,instructions_document_id,state_document_id,disabled_at
     FROM automation_registry ORDER BY key,id`,
  )).rows;

  const directoryResult = await client.query<{
    directory_id: string;
    path: string;
    parent_path: string | null;
    version_number: number;
    title: string;
    summary: string;
    created_at: Date | string;
    updated_at: Date | string;
    legacy_public_reachable: boolean;
    public_title: string | null;
    public_summary: string | null;
    has_existing_hub: boolean;
    direct_directory_ids: string[];
    direct_page_ids: string[];
    direct_asset_ids: string[];
  }>(
    `WITH directory_view AS (
       SELECT directory.id,directory.current_path AS projected_path,
         directory.current_path AS storage_path,directory.version_number,
         directory.title,directory.summary,directory.created_at,directory.updated_at,
         false AS synthetic,
         CASE
           WHEN directory.current_path='' THEN NULL
           WHEN strpos(directory.current_path,'/')=0 THEN ''
           ELSE regexp_replace(directory.current_path,'/[^/]+$','')
         END AS projected_parent_path
       FROM knowledge_directories directory
       UNION ALL
       SELECT synthetic.directory_id,synthetic.legacy_path AS projected_path,
         NULL::text AS storage_path,1 AS version_number,
         synthetic.title,synthetic.summary,synthetic.created_at,synthetic.created_at,
         true AS synthetic,
         CASE
           WHEN strpos(synthetic.legacy_path,'/')=0 THEN ''
           ELSE regexp_replace(synthetic.legacy_path,'/[^/]+$','')
         END AS projected_parent_path
       FROM legacy_public_directory_prefixes synthetic
     )
     SELECT directory.id AS directory_id,directory.projected_path AS path,
       directory.projected_parent_path AS parent_path,
       directory.version_number,directory.title,directory.summary,
       directory.created_at,directory.updated_at,
       EXISTS (
         SELECT 1 FROM knowledge_pages published
         WHERE published.archived_at IS NULL
           AND published.published_version_id IS NOT NULL
           AND published.public_path IS NOT NULL
           AND (directory.projected_path='' OR left(
             published.public_path,length(directory.projected_path)+1
           )=directory.projected_path||'/')
       ) AS legacy_public_reachable,
       CASE WHEN EXISTS (
         SELECT 1
         FROM knowledge_pages published
         JOIN knowledge_page_versions published_version
           ON published_version.id=published.published_version_id
          AND published_version.page_id=published.id
         WHERE NOT directory.synthetic AND published.archived_at IS NULL
           AND (directory.projected_path='' OR left(
             published_version.path,length(directory.projected_path)+1
           )=directory.projected_path||'/')
       ) THEN directory.title ELSE NULL END AS public_title,
       CASE WHEN EXISTS (
         SELECT 1
         FROM knowledge_pages published
         JOIN knowledge_page_versions published_version
           ON published_version.id=published.published_version_id
          AND published_version.page_id=published.id
         WHERE NOT directory.synthetic AND published.archived_at IS NULL
           AND (directory.projected_path='' OR left(
             published_version.path,length(directory.projected_path)+1
           )=directory.projected_path||'/')
       ) THEN directory.summary ELSE NULL END AS public_summary,
       EXISTS (
         SELECT 1 FROM directory_hub_migrations hub
         WHERE hub.directory_id=directory.id
       ) AS has_existing_hub,
       ARRAY(
         SELECT child.id FROM directory_view child
         WHERE child.projected_parent_path=directory.projected_path
         ORDER BY child.projected_path COLLATE "C",child.id
       ) AS direct_directory_ids,
       ARRAY(
         SELECT page.id FROM knowledge_pages page
         WHERE NOT directory.synthetic
           AND page.parent_path=directory.storage_path AND page.archived_at IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM directory_hub_migrations hub WHERE hub.document_id=page.id
           )
         ORDER BY page.current_path COLLATE "C",page.id
       ) AS direct_page_ids,
       ARRAY(
         SELECT asset.id FROM assets asset
         WHERE NOT directory.synthetic AND asset.deleted_at IS NULL
           AND CASE
             WHEN strpos(asset.current_path,'/')=0 THEN ''
             ELSE regexp_replace(asset.current_path,'/[^/]+$','')
           END=directory.storage_path
         ORDER BY asset.current_path COLLATE "C",asset.id
       ) AS direct_asset_ids
     FROM directory_view directory
     ORDER BY directory.projected_path COLLATE "C",directory.id`,
  );
  const directories: LegacyCorpusDirectory[] = directoryResult.rows.map((row) => ({
    ...row,
    version_number: Number(row.version_number),
    direct_directory_ids: row.direct_directory_ids ?? [],
    direct_page_ids: row.direct_page_ids ?? [],
    direct_asset_ids: row.direct_asset_ids ?? [],
  }));

  const pageResult = await client.query<Record<string, unknown>>(
    `SELECT page.id AS document_id,page.current_path AS path,
       current_version.title,current_version.summary,page.archived_at,page.public_path,
       current_revision.id AS current_revision_id,
       current_revision.revision_number AS current_revision_number,
       current_revision.body_object_key AS current_body_object_key,
       current_revision.body_size_bytes AS current_body_size_bytes,
       current_revision.body_content_hash AS current_body_content_hash,
       current_revision.links_indexed_at AS current_links_indexed_at,
       published_revision.id AS published_revision_id,
       published_revision.revision_number AS published_revision_number,
       published_revision.body_object_key AS published_body_object_key,
       published_revision.body_size_bytes AS published_body_size_bytes,
       published_revision.body_content_hash AS published_body_content_hash,
       published_revision.links_indexed_at AS published_links_indexed_at,
       artifact.artifact_id AS published_artifact_id,
       artifact.projection_generation::text AS published_artifact_projection_generation,
       artifact.body_object_key AS published_artifact_body_object_key,
       artifact.body_size_bytes AS published_artifact_body_size_bytes,
       artifact.body_content_hash AS published_artifact_body_content_hash,
       published_version.title AS published_title,
       published_version.summary AS published_summary,
       resource.public_id,
       coalesce(
         jsonb_agg(jsonb_build_object(
           'alias_path',alias.alias_path,'route_kind',alias.route_kind
         ) ORDER BY alias.alias_path) FILTER (WHERE alias.alias_path IS NOT NULL),
         '[]'::jsonb
       ) AS public_aliases,
       (settings.global_guide_document_id=page.id) AS is_global_guide
     FROM knowledge_pages page
     JOIN knowledge_page_versions current_version
       ON current_version.id=page.current_version_id AND current_version.page_id=page.id
     JOIN hypermedia_document_revisions current_revision
       ON current_revision.id=current_version.id AND current_revision.document_id=page.id
     LEFT JOIN knowledge_page_versions published_version
       ON published_version.id=page.published_version_id AND published_version.page_id=page.id
     LEFT JOIN hypermedia_document_revisions published_revision
       ON published_revision.id=published_version.id AND published_revision.document_id=page.id
     CROSS JOIN public_projection_state projection
     LEFT JOIN published_page_artifacts artifact
       ON artifact.page_id=page.id
      AND artifact.version_id=page.published_version_id
      AND artifact.projection_generation=projection.generation
     LEFT JOIN public_resources resource ON resource.document_id=page.id
     LEFT JOIN public_route_aliases alias ON alias.public_id=resource.public_id
     CROSS JOIN knowledge_settings settings
     WHERE settings.singleton AND page.archived_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM directory_hub_migrations hub WHERE hub.document_id=page.id
       )
     GROUP BY page.id,current_version.id,current_revision.id,published_version.id,
       published_revision.id,artifact.artifact_id,artifact.projection_generation,
       artifact.body_object_key,artifact.body_size_bytes,artifact.body_content_hash,
       resource.public_id,
       settings.global_guide_document_id
     ORDER BY page.current_path COLLATE "C",page.id`,
  );
  const pages: LegacyCorpusPage[] = pageResult.rows.map((row) => ({
    document_id: String(row.document_id),
    path: String(row.path),
    title: String(row.title),
    summary: String(row.summary),
    archived_at: row.archived_at as Date | string | null,
    current_revision: objectRef(row, "current")!,
    published_revision: objectRef(row, "published"),
    published_artifact: typeof row.published_artifact_id === "string" ? {
      artifact_id: row.published_artifact_id,
      projection_generation: String(row.published_artifact_projection_generation),
      body_object_key: String(row.published_artifact_body_object_key),
      body_size_bytes: Number(row.published_artifact_body_size_bytes),
      body_content_hash: String(row.published_artifact_body_content_hash),
    } : null,
    published_title: row.published_title === null ? null : String(row.published_title),
    published_summary: row.published_summary === null ? null : String(row.published_summary),
    public_path: row.public_path === null ? null : String(row.public_path),
    public_id: row.public_id === null ? null : String(row.public_id),
    public_aliases: aliases(row.public_aliases),
    is_global_guide: row.is_global_guide === true,
  }));

  const assetResult = await client.query<Record<string, unknown>>(
    `SELECT asset.id AS document_id,asset.current_path AS path,asset.deleted_at,
       asset.filename,asset.content_type,asset.size_bytes,asset.content_hash,
       asset.s3_object_key AS object_key,asset.public_path,resource.public_id,
       coalesce(
         jsonb_agg(jsonb_build_object(
           'alias_path',alias.alias_path,'route_kind',alias.route_kind
         ) ORDER BY alias.alias_path) FILTER (WHERE alias.alias_path IS NOT NULL),
         '[]'::jsonb
       ) AS public_aliases
     FROM assets asset
     LEFT JOIN public_resources resource ON resource.document_id=asset.id
     LEFT JOIN public_route_aliases alias ON alias.public_id=resource.public_id
     WHERE asset.deleted_at IS NULL
     GROUP BY asset.id,resource.public_id
     ORDER BY asset.current_path COLLATE "C",asset.id`,
  );
  const assets: LegacyCorpusAsset[] = assetResult.rows.map((row) => ({
    document_id: String(row.document_id),
    path: String(row.path),
    deleted_at: row.deleted_at as Date | string | null,
    filename: String(row.filename),
    content_type: String(row.content_type),
    size_bytes: Number(row.size_bytes),
    content_hash: String(row.content_hash),
    object_key: String(row.object_key),
    public_path: row.public_path === null ? null : String(row.public_path),
    public_id: row.public_id === null ? null : String(row.public_id),
    public_aliases: aliases(row.public_aliases),
  }));

  const recordResult = await client.query<Record<string, unknown>>(
    `SELECT record.document_id,record.integration,record.connection_id,
       record.connection_instance_id::text,record.model,record.source_record_id,
       record.source_created_at::text AS source_created_at,
       record.source_updated_at::text AS source_updated_at,
       record.deleted_at::text AS deleted_at,
       revision.id AS current_revision_id,
       revision.revision_number AS current_revision_number,
       revision.body_object_key AS current_body_object_key,
       revision.body_size_bytes AS current_body_size_bytes,
       revision.body_content_hash AS current_body_content_hash,
       revision.links_indexed_at AS current_links_indexed_at
     FROM source_records record
     LEFT JOIN hypermedia_document_revisions revision
       ON revision.id=record.current_revision_id AND revision.document_id=record.document_id
     ORDER BY record.document_id`,
  );
  const records: LegacyCorpusRecord[] = recordResult.rows.map((row) => ({
    document_id: String(row.document_id),
    integration: String(row.integration),
    connection_id: String(row.connection_id),
    connection_instance_id: row.connection_instance_id === null
      ? null
      : String(row.connection_instance_id),
    model: String(row.model),
    source_record_id: String(row.source_record_id),
    source_created_at: row.source_created_at as Date | string | null,
    source_updated_at: row.source_updated_at as Date | string,
    deleted_at: row.deleted_at as Date | string | null,
    current_revision: objectRef(row, "current"),
  }));

  const readableDocumentIds = (await client.query<{ id: string }>(
    `SELECT id FROM knowledge_pages
     UNION
     SELECT document_id AS id FROM source_records
     UNION
     SELECT id FROM assets WHERE deleted_at IS NULL
     ORDER BY id`,
  )).rows.map(({ id }) => id);

  const inventoryValue = {
    readable_document_ids: readableDocumentIds,
    global_guide_document_id: settings.global_guide_document_id,
    public_entrypoint_document_id: settings.public_entrypoint_document_id,
    automation_registrations: automationRegistrations,
    directories,
    pages,
    assets,
    records,
  };
  return {
    active_run_id: activeRunId,
    inventory_token: hash(inventoryValue),
    ...inventoryValue,
  };
}

function inventoryItems(inspection: CorpusMigrationInspection): InventoryItem[] {
  const groups: Array<[CorpusMigrationItemKind, Array<LegacyCorpusDirectory | LegacyCorpusPage | LegacyCorpusAsset | LegacyCorpusRecord>]> = [
    ["directory", inspection.directories],
    ["page", inspection.pages],
    ["asset", inspection.assets],
    ["record", inspection.records],
  ];
  return groups.flatMap(([item_kind, values]) => values.map((snapshot) => ({
    item_kind,
    item_id: "directory_id" in snapshot ? snapshot.directory_id : snapshot.document_id,
    legacy_path: "path" in snapshot ? snapshot.path : "",
    source_fingerprint: "directory_id" in snapshot
      ? hash({ ...snapshot, has_existing_hub: false })
      : hash(snapshot),
    snapshot,
  })));
}

function expectedVerifiedRevisionIds(
  kind: "page" | "asset" | "record",
  snapshot: LegacyCorpusPage | LegacyCorpusAsset | LegacyCorpusRecord,
): string[] {
  if (kind === "asset") return [];
  if (kind === "record") {
    const record = snapshot as LegacyCorpusRecord;
    return record.current_revision ? [record.current_revision.revision_id] : [];
  }
  const page = snapshot as LegacyCorpusPage;
  return uniqueSorted([
    page.current_revision.revision_id,
    ...(page.published_revision ? [page.published_revision.revision_id] : []),
  ]);
}

function expectedVerifiedArtifactIds(
  kind: "page" | "asset" | "record",
  snapshot: LegacyCorpusPage | LegacyCorpusAsset | LegacyCorpusRecord,
): string[] {
  if (kind !== "page") return [];
  const artifact = (snapshot as LegacyCorpusPage).published_artifact;
  return artifact ? [artifact.artifact_id.toLowerCase()] : [];
}

function plannedObject(revisionId: string, revisionNumber: number): PlannedRevisionRef {
  return {
    revision_id: revisionId,
    revision_number: revisionNumber,
    body_object_key: `documents/private/${revisionId}.md`,
  };
}

function publicPathAncestors(path: string): string[] {
  const parts = path.split("/");
  return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join("/"));
}

function parentPath(path: string): string {
  return path.includes("/") ? path.replace(/\/[^/]+$/, "") : "";
}

function materializesDirectoryDocument(disposition: CorpusDirectoryDisposition): boolean {
  return disposition === "hub" || disposition === "public_compatibility";
}

function directoryProjectionTargets(
  inspection: CorpusMigrationInspection,
  dispositions: Map<string, CorpusDirectoryDisposition>,
  directory: LegacyCorpusDirectory,
): { privateTargets: string[]; publicTargets: string[] } {
  const operationalDocumentIds = new Set(uniqueSorted([
    ...(inspection.global_guide_document_id ? [inspection.global_guide_document_id] : []),
    ...inspection.automation_registrations.flatMap((registration) => [
      registration.instructions_document_id,
      ...(registration.state_document_id ? [registration.state_document_id] : []),
    ]),
  ]));
  const privateTargets = uniqueSorted([
    ...directory.direct_page_ids.filter((id) => !operationalDocumentIds.has(id.toLowerCase())),
    ...directory.direct_asset_ids,
    ...directory.direct_directory_ids.filter((id) => (
      dispositions.get(id.toLowerCase()) === "hub"
    )),
  ]);
  const publicTargets = uniqueSorted([
    ...inspection.pages
      .filter((page) => page.published_revision !== null && page.public_path !== null
        && parentPath(page.public_path) === directory.path
        && !operationalDocumentIds.has(page.document_id.toLowerCase()))
      .map((page) => page.document_id),
    ...inspection.directories
      .filter((child) => child.parent_path === directory.path
        && child.legacy_public_reachable
        && materializesDirectoryDocument(dispositions.get(child.directory_id.toLowerCase())!))
      .map((child) => child.directory_id),
  ]);
  return {
    privateTargets: dispositions.get(directory.directory_id.toLowerCase())
        === "public_compatibility"
      ? publicTargets
      : privateTargets,
    publicTargets,
  };
}

function directoryProjectionFingerprints(
  inspection: CorpusMigrationInspection,
  dispositions: Map<string, CorpusDirectoryDisposition>,
): Map<string, { privateFingerprint: string; publicFingerprint: string | null }> {
  const pageById = new Map(inspection.pages
    .map((page) => [page.document_id.toLowerCase(), page] as const));
  const assetById = new Map(inspection.assets
    .map((asset) => [asset.document_id.toLowerCase(), asset] as const));
  const directoryById = new Map(inspection.directories
    .map((directory) => [directory.directory_id.toLowerCase(), directory] as const));
  const operationalDocumentIds = new Set(uniqueSorted([
    ...(inspection.global_guide_document_id ? [inspection.global_guide_document_id] : []),
    ...inspection.automation_registrations.flatMap((registration) => [
      registration.instructions_document_id,
      ...(registration.state_document_id ? [registration.state_document_id] : []),
    ]),
  ]));
  return new Map<string, { privateFingerprint: string; publicFingerprint: string | null }>(
    inspection.directories.map((directory) => {
    const privatePages = directory.direct_page_ids
      .map((id) => pageById.get(id.toLowerCase()))
      .filter((page): page is LegacyCorpusPage => Boolean(page)
        && !operationalDocumentIds.has(page!.document_id.toLowerCase()))
      .map((page) => ({
        document_id: page.document_id,
        path: page.path,
        title: page.title,
        summary: page.summary,
      }));
    const privateAssets = directory.direct_asset_ids
      .map((id) => assetById.get(id.toLowerCase()))
      .filter((asset): asset is LegacyCorpusAsset => Boolean(asset))
      .map((asset) => ({
        document_id: asset.document_id,
        path: asset.path,
        filename: asset.filename,
      }));
    const privateChildren = directory.direct_directory_ids
      .map((id) => directoryById.get(id.toLowerCase()))
      .filter((child): child is LegacyCorpusDirectory => Boolean(child)
        && dispositions.get(child!.directory_id.toLowerCase()) === "hub")
      .map((child) => ({
        document_id: child.directory_id,
        path: child.path,
        title: child.title,
        summary: child.summary,
      }));
    const privateFingerprint = hash({
      path: directory.path,
      title: directory.title,
      summary: directory.summary,
      pages: privatePages,
      assets: privateAssets,
      children: privateChildren,
    });
    const disposition = dispositions.get(directory.directory_id.toLowerCase())!;
    if (!materializesDirectoryDocument(disposition)
        || !directory.legacy_public_reachable) {
      return [directory.directory_id.toLowerCase(), {
        privateFingerprint,
        publicFingerprint: null,
      }] as const;
    }
    const publicPages = inspection.pages
      .filter((page) => page.published_revision !== null && page.public_path !== null
        && parentPath(page.public_path) === directory.path
        && !operationalDocumentIds.has(page.document_id.toLowerCase()))
      .map((page) => ({
        document_id: page.document_id,
        public_path: page.public_path,
        published_revision_id: page.published_revision!.revision_id,
        title: page.published_title ?? "Untitled",
        summary: page.published_summary,
      }));
    const publicChildren = inspection.directories
      .filter((child) => child.parent_path === directory.path
        && child.legacy_public_reachable
        && materializesDirectoryDocument(dispositions.get(child.directory_id.toLowerCase())!))
      .map((child) => ({
        document_id: child.directory_id,
        path: child.path,
        ...publicDirectoryMetadata(child),
      }));
    const publicFingerprint = hash({
        path: directory.path,
        ...publicDirectoryMetadata(directory),
        pages: publicPages,
        children: publicChildren,
      });
    return [directory.directory_id.toLowerCase(), {
      privateFingerprint: disposition === "public_compatibility"
        ? publicFingerprint
        : privateFingerprint,
      publicFingerprint,
    }] as const;
    }),
  );
}

export function neutralPublicDirectoryTitle(path: string): string {
  const segment = path.split("/").at(-1) ?? "";
  const normalized = segment.replace(/[-_]/g, " ").replace(/\s+/g, " ").trim();
  return (normalized || "Published knowledge").slice(0, 240);
}

function publicDirectoryMetadata(directory: LegacyCorpusDirectory): {
  title: string;
  summary: string;
} {
  return {
    title: neutralPublicDirectoryTitle(directory.path),
    summary: "Published knowledge formerly available under this public collection.",
  };
}

const defaultPrivateDirectoryHubSummary = "Knowledge collected in this directory.";

function privateDirectoryHubSummary(summary: string): string {
  return summary.trim() ? summary : defaultPrivateDirectoryHubSummary;
}

async function assertPublishedArtifactCurrent(
  client: Pick<Pool, "query">,
  page: LegacyCorpusPage,
): Promise<boolean> {
  if (!page.published_revision) return true;
  if (!page.published_artifact) return false;
  const artifact = await client.query<{ matches: boolean }>(
    `SELECT corpus_published_artifact_matches($1,$2,$3,$4,$5,$6) AS matches`,
    [page.document_id, page.published_revision.revision_id,
      page.published_artifact.artifact_id, page.published_artifact.body_object_key,
      page.published_artifact.body_size_bytes, page.published_artifact.body_content_hash],
  );
  return artifact.rows[0]?.matches === true;
}

export class CorpusMigrationRepository {
  constructor(private readonly pool: Pool) {}

  async inspectSource(): Promise<CorpusMigrationInspection> {
    const run = await activeRun(this.pool);
    if (!run) return liveInspection(this.pool, null);
    return this.inspectionFromRun(this.pool, run);
  }

  private async inspectionFromRun(
    client: Pick<Pool, "query">,
    run: RunRow,
  ): Promise<CorpusMigrationInspection> {
    const result = await client.query<InventoryItem>(
      `SELECT item_kind,item_id,legacy_path,source_fingerprint,snapshot
       FROM corpus_migration_inventory WHERE run_id=$1
       ORDER BY item_kind,legacy_path COLLATE "C",item_id`,
      [run.id],
    );
    const items = result.rows;
    const automationRegistrations = (await client.query<CorpusAutomationRegistration>(
      `SELECT plan.id,plan.key,plan.name,plan.instructions_document_id,
         plan.state_document_id,registry.disabled_at
       FROM corpus_migration_automation_plans plan
       LEFT JOIN automation_registry registry
         ON registry.id=plan.id AND registry.key=plan.key
        AND registry.instructions_document_id=plan.instructions_document_id
        AND registry.state_document_id IS NOT DISTINCT FROM plan.state_document_id
       WHERE plan.run_id=$1 ORDER BY plan.key,plan.id`,
      [run.id],
    )).rows;
    const settings = run.settings_snapshot;
    return {
      active_run_id: run.id,
      inventory_token: run.inventory_token,
      readable_document_ids: run.readable_document_ids,
      global_guide_document_id: settings.global_guide_document_id,
      public_entrypoint_document_id: settings.public_entrypoint_document_id,
      automation_registrations: automationRegistrations,
      directories: items.filter(({ item_kind }) => item_kind === "directory")
        .map(({ snapshot }) => snapshot as LegacyCorpusDirectory),
      pages: items.filter(({ item_kind }) => item_kind === "page")
        .map(({ snapshot }) => snapshot as LegacyCorpusPage),
      assets: items.filter(({ item_kind }) => item_kind === "asset")
        .map(({ snapshot }) => snapshot as LegacyCorpusAsset),
      records: items.filter(({ item_kind }) => item_kind === "record")
        .map(({ snapshot }) => snapshot as LegacyCorpusRecord),
    };
  }

  async beginOrResume(input: BeginCorpusMigrationInput): Promise<CorpusMigrationPlan> {
    return transaction(this.pool, async (client) => {
      const dispositions = [...input.directories]
        .map((value) => ({ ...value, directory_id: value.directory_id.toLowerCase() }))
        .sort((left, right) => left.directory_id.localeCompare(right.directory_id));
      const automations = [...input.automations]
        .map((value) => ({
          ...value,
          instructions_document_id: value.instructions_document_id.toLowerCase(),
          state_document_id: value.state_document_id?.toLowerCase() ?? null,
        }))
        .sort((left, right) => left.key.localeCompare(right.key, "en"));
      const planToken = hash({ dispositions, automations });
      const existing = await activeRun(client);
      if (existing) {
        if (existing.inventory_token !== input.inventory_token || existing.plan_token !== planToken) {
          throw new Error("A different corpus migration is already active");
        }
        return this.loadPlan(client, existing);
      }

      await client.query("SELECT lock_corpus_migration_audit_tables()");

      const inspection = await liveInspection(client, null);
      if (inspection.inventory_token !== input.inventory_token) {
        throw new CorpusMigrationInventoryDriftError("Corpus migration inventory is stale");
      }
      if (new Set(dispositions.map(({ directory_id }) => directory_id)).size !== dispositions.length
          || dispositions.length !== inspection.directories.length) {
        throw new Error("Every legacy directory needs exactly one migration disposition");
      }
      const dispositionById = new Map(dispositions
        .map((value) => [value.directory_id, value.disposition] as const));
      const directoryById = new Map(inspection.directories
        .map((value) => [value.directory_id.toLowerCase(), value] as const));
      const operationalDocumentIds = new Set(uniqueSorted([
        ...(inspection.global_guide_document_id ? [inspection.global_guide_document_id] : []),
        ...inspection.automation_registrations.flatMap((registration) => [
          registration.instructions_document_id,
          ...(registration.state_document_id ? [registration.state_document_id] : []),
        ]),
      ]));
      const directoryPaths = new Set(inspection.directories.map(({ path }) => path));
      const requiredPublicAncestors = new Set([
        ...inspection.pages.flatMap((page) => page.public_path
          ? publicPathAncestors(page.public_path)
          : []),
      ]);
      const missingPublicAncestor = [...requiredPublicAncestors]
        .sort((left, right) => left.localeCompare(right, "en"))
        .find((path) => !directoryPaths.has(path));
      if (missingPublicAncestor) {
        throw new Error(`Published route ancestor is missing from directory inventory: ${missingPublicAncestor}`);
      }
      if ([...dispositionById.keys()].some((id) => !directoryById.has(id))) {
        throw new Error("Directory plan contains an item outside the audited inventory");
      }
      for (const directory of inspection.directories) {
        const disposition = dispositionById.get(directory.directory_id.toLowerCase())!;
        const operationalScaffold = /^automations(?:\/|$)/.test(directory.path);
        if (directory.path === "" && disposition !== "root_entrypoint") {
          throw new Error("The legacy root must remain the root entrypoint projection");
        }
        if (directory.path !== "" && disposition === "root_entrypoint") {
          throw new Error("Only the legacy root may use the root entrypoint disposition");
        }
        const expectedOperationalDisposition = directory.legacy_public_reachable
          || directory.has_existing_hub
          ? "public_compatibility"
          : "operational";
        if (operationalScaffold
          ? disposition !== expectedOperationalDisposition
          : disposition === "operational" || disposition === "public_compatibility") {
          throw new Error(
            "Legacy automation scaffolds require their audited operational compatibility disposition",
          );
        }
        if (directory.has_existing_hub && !materializesDirectoryDocument(disposition)) {
          throw new Error("A converted directory must retain its stable hub identity");
        }
        if (disposition === "retired_template_scaffold") {
          if (directory.legacy_public_reachable
              || directory.direct_page_ids.some((id) => !operationalDocumentIds.has(id.toLowerCase()))
              || directory.direct_asset_ids.length) {
            throw new Error("A visible or non-empty directory cannot be retired as template scaffolding");
          }
          const retainedChild = directory.direct_directory_ids.some((childId) => {
            const child = dispositionById.get(childId.toLowerCase());
            return child === "hub";
          });
          if (retainedChild) {
            throw new Error("A directory containing an eligible hub descendant cannot be retired");
          }
        }
      }
      const projectionFingerprints = directoryProjectionFingerprints(
        inspection,
        dispositionById,
      );

      const pageById = new Map(inspection.pages
        .filter(({ archived_at }) => archived_at === null)
        .map((value) => [value.document_id.toLowerCase(), value] as const));
      for (const page of inspection.pages) {
        if (page.published_revision && !page.published_artifact) {
          throw new Error(`Published page artifact is missing for ${page.document_id}`);
        }
      }
      if (new Set(automations.map(({ key }) => key)).size !== automations.length) {
        throw new Error("Automation migration keys must be unique");
      }
      for (const automation of automations) {
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(automation.key)
            || automation.name.trim().length < 1 || automation.name.trim().length > 160) {
          throw new Error("Automation migration metadata is invalid");
        }
        const instructions = pageById.get(automation.instructions_document_id);
        const state = automation.state_document_id
          ? pageById.get(automation.state_document_id)
          : null;
        if (!instructions || instructions.public_path !== null
            || (automation.state_document_id && (!state || state.public_path !== null))) {
          throw new Error("Automation plan does not match active private documents");
        }
        const registered = inspection.automation_registrations
          .find(({ key }) => key === automation.key);
        if (registered && (
          registered.instructions_document_id !== automation.instructions_document_id
          || registered.state_document_id !== automation.state_document_id
        )) {
          throw new Error("Automation plan conflicts with its registered document identities");
        }
      }
      for (const registered of inspection.automation_registrations) {
        if (!automations.some((automation) => automation.key === registered.key
          && automation.instructions_document_id === registered.instructions_document_id
          && automation.state_document_id === registered.state_document_id)) {
          throw new Error("Every registered automation must be preserved in the corpus plan");
        }
      }

      const runId = randomUUID();
      const readableDocumentIds = uniqueSorted([
        ...inspection.readable_document_ids,
        ...inspection.directories
          .filter(({ directory_id }) => materializesDirectoryDocument(
            dispositionById.get(directory_id.toLowerCase())!,
          ))
          .map(({ directory_id }) => directory_id),
      ]);
      const settingsSnapshot = {
        global_guide_document_id: inspection.global_guide_document_id,
        public_entrypoint_document_id: inspection.public_entrypoint_document_id,
      };
      await client.query(
        `INSERT INTO corpus_migration_runs(
           id,inventory_token,plan_token,settings_snapshot,readable_document_ids,actor_subject
         ) VALUES ($1,$2,$3,$4::jsonb,$5::uuid[],$6)`,
        [runId, inspection.inventory_token, planToken, JSON.stringify(settingsSnapshot),
          readableDocumentIds, input.actor_subject],
      );
      const items = inventoryItems(inspection);
      for (const item of items) {
        await client.query(
          `INSERT INTO corpus_migration_inventory(
             run_id,item_kind,item_id,legacy_path,source_fingerprint,snapshot
           ) VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
          [runId, item.item_kind, item.item_id, item.legacy_path,
            item.source_fingerprint, JSON.stringify(item.snapshot)],
        );
      }

      for (const directory of inspection.directories) {
        const disposition = dispositionById.get(directory.directory_id.toLowerCase())!;
        const projectionFingerprint = projectionFingerprints.get(
          directory.directory_id.toLowerCase(),
        )!;
        let temporaryPath: string | null = null;
        let privateRevision: PlannedRevisionRef | null = null;
        let publicRevision: PlannedRevisionRef | null = null;
        let publicId: string | null = null;
        let privateRevisionMode: "render" | "copy" | "existing" | null = null;
        let publicRevisionMode: "render" | "existing" | null = null;
        let privateSourceRevisionId: string | null = null;
        let publicSourceRevisionId: string | null = null;
        if (materializesDirectoryDocument(disposition)) {
          const existingHub = (await client.query<{
            document_id: string;
            legacy_path: string;
            temporary_path: string;
            public_id: string | null;
            current_path: string;
            archived_at: Date | string | null;
            mapped_private_revision_id: string;
            mapped_public_revision_id: string | null;
            current_version_id: string;
            current_revision_number: number;
            public_revision_number: number | null;
            mapped_public_projection_fingerprint: string | null;
          }>(
            `SELECT mapping.document_id,mapping.legacy_path,mapping.temporary_path,
               mapping.public_id,page.current_path,page.archived_at,
               mapping.private_revision_id AS mapped_private_revision_id,
               mapping.public_revision_id AS mapped_public_revision_id,
               page.current_version_id,
               revision.revision_number AS current_revision_number,
               public_revision.revision_number AS public_revision_number,
               mapping.public_projection_fingerprint AS mapped_public_projection_fingerprint
             FROM directory_hub_migrations mapping
             JOIN knowledge_pages page ON page.id=mapping.document_id
             JOIN hypermedia_document_revisions revision
               ON revision.id=page.current_version_id AND revision.document_id=page.id
             LEFT JOIN hypermedia_document_revisions public_revision
               ON public_revision.id=mapping.public_revision_id
              AND public_revision.document_id=mapping.document_id
             WHERE mapping.directory_id=$1`,
            [directory.directory_id],
          )).rows[0];
          if (existingHub) {
            if (existingHub.document_id !== directory.directory_id
                || existingHub.legacy_path !== directory.path
                || existingHub.current_path !== existingHub.temporary_path
                || existingHub.archived_at !== null) {
              throw new Error(`Existing directory hub mapping drifted: ${directory.directory_id}`);
            }
            temporaryPath = existingHub.temporary_path;
            const fingerprints = projectionFingerprints.get(
              directory.directory_id.toLowerCase(),
            )!;
            const publicProjectionChanged = existingHub.mapped_public_projection_fingerprint
              !== fingerprints.publicFingerprint;
            privateSourceRevisionId = existingHub.current_version_id;
            publicId = existingHub.public_id;
            const needsPublicRevision = directory.legacy_public_reachable
              && (!existingHub.mapped_public_revision_id || publicProjectionChanged);
            if (needsPublicRevision) {
              privateRevisionMode = "copy";
              privateRevision = plannedObject(
                randomUUID(),
                Number(existingHub.current_revision_number) + 2,
              );
              publicRevisionMode = "render";
              publicRevision = plannedObject(
                randomUUID(),
                Number(existingHub.current_revision_number) + 1,
              );
              publicId ??= randomUUID();
            } else {
              privateRevisionMode = "existing";
              privateRevision = plannedObject(
                existingHub.current_version_id,
                Number(existingHub.current_revision_number),
              );
            }
            if (!needsPublicRevision
                && directory.legacy_public_reachable
                && existingHub.mapped_public_revision_id) {
              publicRevisionMode = "existing";
              publicSourceRevisionId = existingHub.mapped_public_revision_id;
              publicRevision = plannedObject(
                existingHub.mapped_public_revision_id,
                Number(existingHub.public_revision_number),
              );
            }
          } else {
            if ((await client.query(
              "SELECT 1 FROM hypermedia_documents WHERE id=$1",
              [directory.directory_id],
            )).rowCount) {
              throw new Error(`Directory hub identity collides: ${directory.directory_id}`);
            }
            temporaryPath = `migration-hub-${directory.directory_id}`;
            const collision = await client.query(
              `SELECT 1 FROM knowledge_directories WHERE current_path=$1
               UNION ALL SELECT 1 FROM knowledge_pages WHERE current_path=$1 AND archived_at IS NULL
               UNION ALL SELECT 1 FROM assets WHERE current_path=$1 AND deleted_at IS NULL
               LIMIT 1`,
              [temporaryPath],
            );
            if (collision.rowCount) throw new Error(`Directory hub temporary path collides: ${temporaryPath}`);
            if (directory.legacy_public_reachable) {
              privateRevisionMode = "render";
              publicRevisionMode = "render";
              publicId = randomUUID();
              publicRevision = plannedObject(randomUUID(), 1);
              privateRevision = plannedObject(randomUUID(), 2);
            } else {
              privateRevisionMode = "render";
              privateRevision = plannedObject(randomUUID(), 1);
            }
          }
          if (directory.legacy_public_reachable) {
            const aliasPath = `/p/${directory.path}/`;
            const existingAlias = (await client.query<{ public_id: string }>(
              "SELECT public_id FROM public_route_aliases WHERE alias_path=$1",
              [aliasPath],
            )).rows[0];
            if (existingAlias && existingAlias.public_id !== publicId) {
              throw new Error(`Legacy directory alias is already permanently assigned: ${aliasPath}`);
            }
          }
        }
        await client.query(
          `INSERT INTO corpus_directory_migration_plans(
             run_id,directory_id,disposition,private_revision_mode,public_revision_mode,
             private_source_revision_id,public_source_revision_id,temporary_path,
             private_revision_id,private_revision_number,
             public_revision_id,public_revision_number,public_id,
             private_projection_fingerprint,public_projection_fingerprint
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
          [runId, directory.directory_id, disposition,
            privateRevisionMode, publicRevisionMode,
            privateSourceRevisionId, publicSourceRevisionId, temporaryPath,
            privateRevision?.revision_id ?? null, privateRevision?.revision_number ?? null,
            publicRevision?.revision_id ?? null, publicRevision?.revision_number ?? null, publicId,
            materializesDirectoryDocument(disposition)
              ? projectionFingerprint.privateFingerprint : null,
            materializesDirectoryDocument(disposition)
              ? projectionFingerprint.publicFingerprint : null],
        );
        if (!materializesDirectoryDocument(disposition)) {
          const item = items.find((value) => value.item_kind === "directory"
            && value.item_id === directory.directory_id)!;
          await client.query(
            `INSERT INTO corpus_migration_completions(
               run_id,item_kind,item_id,source_fingerprint,result_kind,
               output_document_id,output_revision_id,actor_subject
             ) VALUES ($1,'directory',$2,$3,$4,NULL,NULL,$5)`,
            [runId, directory.directory_id, item.source_fingerprint, disposition,
              input.actor_subject],
          );
        }
      }

      for (const page of inspection.pages) {
        const rewrite = page.archived_at === null
          ? plannedObject(randomUUID(), page.current_revision.revision_number + 1)
          : null;
        await client.query(
          `INSERT INTO corpus_page_migration_plans(
             run_id,document_id,source_revision_id,rewrite_revision_id,
             rewrite_revision_number,rewrite_object_key
           ) VALUES ($1,$2,$3,$4,$5,$6)`,
          [runId, page.document_id, page.current_revision.revision_id,
            rewrite?.revision_id ?? null, rewrite?.revision_number ?? null,
            rewrite?.body_object_key ?? null],
        );
      }
      for (const automation of automations) {
        const registered = inspection.automation_registrations
          .find(({ key }) => key === automation.key);
        await client.query(
          `INSERT INTO corpus_migration_automation_plans(
             run_id,id,key,name,instructions_document_id,state_document_id
           ) VALUES ($1,$2,$3,$4,$5,$6)`,
          [runId, registered?.id ?? randomUUID(), automation.key, automation.name,
            automation.instructions_document_id, automation.state_document_id],
        );
      }
      return this.loadPlan(client, {
        id: runId,
        inventory_token: inspection.inventory_token,
        plan_token: planToken,
        settings_snapshot: settingsSnapshot,
        readable_document_ids: readableDocumentIds,
        phase: "applying",
      });
    });
  }

  private async loadPlan(client: Pick<Pool, "query">, run: RunRow): Promise<CorpusMigrationPlan> {
    if (run.phase === "superseded") throw new Error("Corpus migration was superseded");
    const inspection = await this.inspectionFromRun(client, run);
    const directoryPlans = await client.query<{
      directory_id: string;
      disposition: CorpusDirectoryDisposition;
      private_revision_mode: "render" | "copy" | "existing" | null;
      public_revision_mode: "render" | "existing" | null;
      private_source_revision_id: string | null;
      public_source_revision_id: string | null;
      temporary_path: string | null;
      private_revision_id: string | null;
      private_revision_number: number | null;
      public_revision_id: string | null;
      public_revision_number: number | null;
      public_id: string | null;
      public_body_markdown: string | null;
    }>(
      `SELECT directory_id,disposition,private_revision_mode,public_revision_mode,
         private_source_revision_id,public_source_revision_id,
         temporary_path,private_revision_id,
         private_revision_number,public_revision_id,public_revision_number,public_id,
         CASE WHEN public_revision_id IS NULL THEN NULL
           ELSE render_corpus_public_directory_hub(run_id,directory_id)
         END AS public_body_markdown
       FROM corpus_directory_migration_plans WHERE run_id=$1`,
      [run.id],
    );
    const directoryPlanById = new Map(directoryPlans.rows
      .map((value) => [value.directory_id, value] as const));
    const sourceRevisionIds = uniqueSorted(directoryPlans.rows.flatMap((plan) => [
      ...(plan.private_source_revision_id ? [plan.private_source_revision_id] : []),
      ...(plan.public_source_revision_id ? [plan.public_source_revision_id] : []),
    ]));
    const sourceRevisions = sourceRevisionIds.length
      ? await client.query<Record<string, unknown>>(
          `SELECT id AS source_revision_id,revision_number AS source_revision_number,
             body_object_key AS source_body_object_key,
             body_size_bytes AS source_body_size_bytes,
             body_content_hash AS source_body_content_hash,
             links_indexed_at AS source_links_indexed_at
           FROM hypermedia_document_revisions WHERE id=ANY($1::uuid[])`,
          [sourceRevisionIds],
        )
      : { rows: [] as Record<string, unknown>[] };
    const sourceRevisionById = new Map(sourceRevisions.rows.map((row) => [
      String(row.source_revision_id),
      objectRef(row, "source")!,
    ] as const));
    const pagePlans = await client.query<{
      document_id: string;
      rewrite_revision_id: string | null;
      rewrite_revision_number: number | null;
      rewrite_object_key: string | null;
    }>(
      `SELECT document_id,rewrite_revision_id,rewrite_revision_number,rewrite_object_key
       FROM corpus_page_migration_plans WHERE run_id=$1`,
      [run.id],
    );
    const pagePlanById = new Map(pagePlans.rows.map((value) => [value.document_id, value] as const));
    const automationResult = await client.query<{
      id: string;
      key: string;
      name: string;
      instructions_document_id: string;
      state_document_id: string | null;
    }>(
      `SELECT plan.id,plan.key,plan.name,
         plan.instructions_document_id,plan.state_document_id
       FROM corpus_migration_automation_plans plan
       WHERE plan.run_id=$1 ORDER BY plan.key COLLATE "C"`,
      [run.id],
    );
    return {
      run_id: run.id,
      inventory_token: run.inventory_token,
      phase: run.phase,
      readable_document_ids: run.readable_document_ids,
      global_guide_document_id: inspection.global_guide_document_id,
      public_entrypoint_document_id: inspection.public_entrypoint_document_id,
      directories: inspection.directories.map((directory) => {
        const plan = directoryPlanById.get(directory.directory_id)!;
        const privateRevision = plan.private_revision_id
          ? plannedObject(plan.private_revision_id, Number(plan.private_revision_number))
          : null;
        const publicRevision = plan.public_revision_id
          ? plannedObject(plan.public_revision_id, Number(plan.public_revision_number))
          : null;
        return {
          ...directory,
          disposition: plan.disposition,
          hub: privateRevision ? {
            document_id: directory.directory_id,
            temporary_path: plan.temporary_path!,
            private_revision_mode: plan.private_revision_mode!,
            public_revision_mode: plan.public_revision_mode,
            private_revision: privateRevision,
            public_revision: publicRevision,
            private_source_revision: plan.private_source_revision_id
              ? sourceRevisionById.get(plan.private_source_revision_id) ?? null
              : null,
            public_source_revision: plan.public_source_revision_id
              ? sourceRevisionById.get(plan.public_source_revision_id) ?? null
              : null,
            public_body_markdown: plan.public_body_markdown,
            public_id: plan.public_id,
          } : null,
        };
      }),
      pages: inspection.pages.map((page) => {
        const plan = pagePlanById.get(page.document_id)!;
        return {
          ...page,
          rewrite_revision: plan.rewrite_revision_id
            ? plannedObject(plan.rewrite_revision_id, Number(plan.rewrite_revision_number))
            : null,
        };
      }),
      assets: inspection.assets,
      records: inspection.records,
      automations: automationResult.rows,
    };
  }

  async completeExisting(input: CompleteExistingCorpusItemInput): Promise<void> {
    const driftError = await transaction(this.pool, async (client): Promise<string | null> => {
      const found = await client.query<{
        source_fingerprint: string;
        snapshot: LegacyCorpusPage | LegacyCorpusAsset | LegacyCorpusRecord;
      }>(
        `SELECT inventory.source_fingerprint,inventory.snapshot
         FROM corpus_migration_inventory inventory
         JOIN corpus_migration_runs run ON run.id=inventory.run_id
         WHERE inventory.run_id=$1 AND inventory.item_kind=$2 AND inventory.item_id=$3
           AND run.phase='applying'
         FOR UPDATE OF run`,
        [input.run_id, input.item_kind, input.item_id],
      );
      const item = found.rows[0];
      if (!item) {
        return throwForMissingActiveRunItem(
          client,
          input.run_id,
          "Active corpus migration item not found",
        );
      }
      const locked = await client.query<{ locked: boolean }>(
        "SELECT lock_corpus_migration_item($1,$2) AS locked",
        [input.item_kind, input.item_id],
      );
      if (locked.rows[0]?.locked !== true) {
        await client.query(
          `UPDATE corpus_migration_runs
           SET phase='superseded',updated_at=now(),superseded_at=now()
           WHERE id=$1 AND phase='applying'`,
          [input.run_id],
        );
        return "Corpus item was removed after inventory";
      }
      const expected = expectedVerifiedRevisionIds(input.item_kind, item.snapshot);
      const expectedArtifacts = expectedVerifiedArtifactIds(input.item_kind, item.snapshot);
      if (JSON.stringify(uniqueSorted(input.verified_revision_ids)) !== JSON.stringify(expected)) {
        throw new Error("Corpus item object verification receipt is incomplete");
      }
      if (JSON.stringify(uniqueSorted(input.verified_public_artifact_ids))
          !== JSON.stringify(expectedArtifacts)) {
        throw new Error("Corpus item public artifact verification receipt is incomplete");
      }
      const drift = await this.assertExistingItemUnchanged(
        client,
        input.item_kind,
        input.item_id,
        item.snapshot,
      );
      if (drift) {
        await client.query(
          `UPDATE corpus_migration_runs
           SET phase='superseded',updated_at=now(),superseded_at=now()
           WHERE id=$1 AND phase='applying'`,
          [input.run_id],
        );
        return drift;
      }
      let targetIds: string[] = [];
      let indexedTargetIds: string[] = [];
      let knowledgeHydration: HydrateCorpusKnowledgeInput | null = null;
      if (input.item_kind === "page") {
        if (typeof input.body_markdown_for_index !== "string"
            || !Array.isArray(input.target_document_ids)) {
          throw new Error("Preserved knowledge page requires an exact Markdown link receipt");
        }
        const page = item.snapshot as LegacyCorpusPage;
        assertExistingBodyMatches(page.current_revision, input.body_markdown_for_index);
        const targets = await exactDocumentTargets(
          client,
          input.run_id,
          input.body_markdown_for_index,
          input.target_document_ids,
          "Knowledge page",
        );
        targetIds = targets.receipt;
        indexedTargetIds = targets.indexed;
        await replaceKnowledgeProjections(
          client,
          page.current_revision.revision_id,
          indexedTargetIds,
        );
        knowledgeHydration = {
          run_id: input.run_id,
          document_id: input.item_id,
          revision_id: page.current_revision.revision_id,
          body_markdown_for_index: input.body_markdown_for_index,
          target_document_ids: targetIds,
        };
      } else if (input.body_markdown_for_index !== undefined
          || input.target_document_ids !== undefined) {
        throw new Error("Only knowledge pages accept Markdown link receipts");
      }
      const existing = await client.query<{
        result_kind: string;
        details: { target_document_ids?: string[] };
      }>(
        `SELECT result_kind,details FROM corpus_migration_completions
         WHERE run_id=$1 AND item_kind=$2 AND item_id=$3`,
        [input.run_id, input.item_kind, input.item_id],
      );
      if (existing.rowCount) {
        if (existing.rows[0]!.result_kind !== "preserved"
            || JSON.stringify(uniqueSorted(
              existing.rows[0]!.details.target_document_ids ?? [],
            )) !== JSON.stringify(targetIds)) {
          await client.query(
            `UPDATE corpus_migration_runs
             SET phase='superseded',updated_at=now(),superseded_at=now()
             WHERE id=$1 AND phase='applying'`,
            [input.run_id],
          );
          return "Corpus item completion receipt changed across migration code versions";
        }
        if (knowledgeHydration) {
          await hydrateCorpusKnowledge(client, knowledgeHydration);
        }
        return null;
      }
      const outputRevisionId = input.item_kind === "page"
        ? (item.snapshot as LegacyCorpusPage).current_revision.revision_id
        : input.item_kind === "record"
          ? (item.snapshot as LegacyCorpusRecord).current_revision?.revision_id ?? null
          : null;
      await client.query(
        `INSERT INTO corpus_migration_completions(
           run_id,item_kind,item_id,source_fingerprint,result_kind,
           output_document_id,output_revision_id,verified_revision_ids,
           verified_public_artifact_ids,actor_subject,details
         ) VALUES ($1,$2,$3,$4,'preserved',$3,$5,$6::uuid[],$7::uuid[],$8,
           jsonb_build_object('target_document_ids',$9::uuid[]))`,
        [input.run_id, input.item_kind, input.item_id, item.source_fingerprint,
          outputRevisionId, expected, expectedArtifacts, input.actor_subject, targetIds],
      );
      if (knowledgeHydration) {
        await hydrateCorpusKnowledge(client, knowledgeHydration);
      }
      return null;
    });
    if (driftError) {
      throw new CorpusMigrationInventoryDriftError(driftError, input.run_id);
    }
  }

  private async assertExistingItemUnchanged(
    client: Pick<Pool, "query">,
    kind: "page" | "asset" | "record",
    itemId: string,
    snapshot: LegacyCorpusPage | LegacyCorpusAsset | LegacyCorpusRecord,
  ): Promise<string | null> {
    if (kind === "page") {
      const page = snapshot as LegacyCorpusPage;
      const current = await client.query<{
        current_version_id: string;
        published_version_id: string | null;
        current_path: string;
        public_path: string | null;
        archived_at: Date | string | null;
      }>(
        `SELECT current_version_id,published_version_id,current_path,public_path,archived_at
         FROM knowledge_pages WHERE id=$1`,
        [itemId],
      );
      const row = current.rows[0];
      if (!row || row.current_version_id !== page.current_revision.revision_id
          || row.published_version_id !== page.published_revision?.revision_id && !(
            row.published_version_id === null && page.published_revision === null
          )
          || row.current_path !== page.path
          || row.public_path !== page.public_path
          || String(row.archived_at) !== String(page.archived_at)) {
        return "Knowledge page changed after corpus inventory";
      }
      if (!await assertPublishedArtifactCurrent(client, page)) {
        return "Published page artifact changed after corpus inventory";
      }
      return null;
    }
    if (kind === "asset") {
      const asset = snapshot as LegacyCorpusAsset;
      const current = await client.query(
        `SELECT 1 FROM assets
         WHERE id=$1 AND deleted_at IS NULL AND current_path=$2
           AND s3_object_key=$3 AND size_bytes=$4 AND content_hash=$5
           AND public_path IS NOT DISTINCT FROM $6
           AND filename=$7 AND content_type=$8`,
        [itemId, asset.path, asset.object_key, asset.size_bytes, asset.content_hash,
          asset.public_path, asset.filename, asset.content_type],
      );
      return current.rowCount ? null : "Asset changed after corpus inventory";
    }
    const record = snapshot as LegacyCorpusRecord;
    const current = await client.query(
      `SELECT 1 FROM source_records
       WHERE document_id=$1 AND deleted_at::text IS NOT DISTINCT FROM $2
         AND current_revision_id IS NOT DISTINCT FROM $3
         AND connection_instance_id::text IS NOT DISTINCT FROM $4
         AND integration=$5 AND connection_id=$6 AND model=$7 AND source_record_id=$8
         AND source_created_at IS NOT DISTINCT FROM $9
         AND source_updated_at=$10`,
      [itemId, record.deleted_at === null ? null : String(record.deleted_at),
        record.current_revision?.revision_id ?? null, record.connection_instance_id,
        record.integration, record.connection_id, record.model, record.source_record_id,
        record.source_created_at, record.source_updated_at],
    );
    return current.rowCount ? null : "Source record changed after corpus inventory";
  }

  async applyPage(input: ApplyCorpusPageInput): Promise<void> {
    assertBodyMatches(input.revision, input.body_markdown_for_index);
    const driftError = await transaction(this.pool, async (client): Promise<string | null> => {
      const result = await client.query<{
        source_fingerprint: string;
        snapshot: LegacyCorpusPage;
        rewrite_revision_id: string;
        rewrite_revision_number: number;
        rewrite_object_key: string;
      }>(
        `SELECT inventory.source_fingerprint,inventory.snapshot,
           plan.rewrite_revision_id,plan.rewrite_revision_number,plan.rewrite_object_key
         FROM corpus_page_migration_plans plan
         JOIN corpus_migration_inventory inventory
           ON inventory.run_id=plan.run_id AND inventory.item_kind='page'
          AND inventory.item_id=plan.document_id
         JOIN corpus_migration_runs run ON run.id=plan.run_id
         WHERE plan.run_id=$1 AND plan.document_id=$2 AND run.phase='applying'
         FOR UPDATE OF run`,
        [input.run_id, input.document_id],
      );
      const planned = result.rows[0];
      if (!planned) {
        return throwForMissingActiveRunItem(
          client,
          input.run_id,
          "Active knowledge page migration plan not found",
        );
      }
      if (planned.rewrite_revision_id !== input.revision.id
          || planned.rewrite_object_key !== input.revision.body_object_key
          || planned.snapshot.current_revision.revision_id !== input.source_revision_id) {
        throw new Error("Knowledge page rewrite does not match its stable migration plan");
      }
      const expectedVerified = expectedVerifiedRevisionIds("page", planned.snapshot);
      const expectedArtifacts = expectedVerifiedArtifactIds("page", planned.snapshot);
      if (JSON.stringify(uniqueSorted(input.verified_source_revision_ids))
          !== JSON.stringify(expectedVerified)) {
        throw new Error("Knowledge page source object verification receipt is incomplete");
      }
      if (JSON.stringify(uniqueSorted(input.verified_public_artifact_ids))
          !== JSON.stringify(expectedArtifacts)) {
        throw new Error("Knowledge page public artifact verification receipt is incomplete");
      }
      const submittedTargets = uniqueSorted(input.target_document_ids);
      if (JSON.stringify(submittedTargets)
          !== JSON.stringify(uniqueSorted(extractDocumentLinks(input.body_markdown_for_index)))) {
        throw new Error("Knowledge page rewrite link receipt does not match its Markdown");
      }
      const completed = await client.query<{
        output_revision_id: string | null;
        details: { target_document_ids?: string[] };
      }>(
        `SELECT output_revision_id,details FROM corpus_migration_completions
         WHERE run_id=$1 AND item_kind='page' AND item_id=$2`,
        [input.run_id, input.document_id],
      );
      if (completed.rowCount) {
        if (completed.rows[0]!.output_revision_id !== input.revision.id
            || JSON.stringify(uniqueSorted(
              completed.rows[0]!.details.target_document_ids ?? [],
            )) !== JSON.stringify(submittedTargets)) {
          await client.query(
            `UPDATE corpus_migration_runs
             SET phase='superseded',updated_at=now(),superseded_at=now()
             WHERE id=$1 AND phase='applying'`,
            [input.run_id],
          );
          return "Knowledge page completion receipt changed across migration code versions";
        }
        await hydrateCorpusKnowledge(client, {
          run_id: input.run_id,
          document_id: input.document_id,
          revision_id: input.revision.id,
          body_markdown_for_index: input.body_markdown_for_index,
          target_document_ids: submittedTargets,
        });
        return null;
      }
      const locked = await client.query<{ locked: boolean }>(
        "SELECT lock_corpus_migration_item('page',$1) AS locked",
        [input.document_id],
      );
      const drift = locked.rows[0]?.locked === true
        ? await this.assertExistingItemUnchanged(
            client,
            "page",
            input.document_id,
            planned.snapshot,
          )
        : "Knowledge page was removed after corpus inventory";
      if (drift) {
        await client.query(
          `UPDATE corpus_migration_runs
           SET phase='superseded',updated_at=now(),superseded_at=now()
           WHERE id=$1 AND phase='applying'`,
          [input.run_id],
        );
        return drift;
      }
      const targets = await exactDocumentTargets(
        client,
        input.run_id,
        input.body_markdown_for_index,
        input.target_document_ids,
        "Knowledge page rewrite",
      );
      await client.query(
        `INSERT INTO hypermedia_document_revisions(
           id,document_id,revision_number,body_object_key,body_size_bytes,body_content_hash
         ) VALUES ($1,$2,$3,$4,$5,$6)`,
        [input.revision.id, input.document_id, planned.rewrite_revision_number,
          input.revision.body_object_key, input.revision.body_size_bytes,
          input.revision.body_content_hash],
      );
      await client.query(
        `INSERT INTO knowledge_page_versions(
           id,page_id,version_number,path,title,summary,commit_message,actor_kind,actor_subject
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,'dashboard',$8)`,
        [input.revision.id, input.document_id, planned.rewrite_revision_number,
          planned.snapshot.path, planned.snapshot.title, planned.snapshot.summary,
          "Rewrite legacy links for path-independent hypermedia", input.actor_subject],
      );
      await client.query(
        `UPDATE knowledge_pages
         SET current_version_id=$2,
           search_vector=page_search_vector(current_path,$3,$4,$5),updated_at=now()
         WHERE id=$1`,
        [input.document_id, input.revision.id, planned.snapshot.title,
          planned.snapshot.summary, input.body_markdown_for_index],
      );
      await replaceKnowledgeProjections(client, input.revision.id, targets.indexed);
      await client.query("UPDATE hypermedia_documents SET updated_at=now() WHERE id=$1", [input.document_id]);
      await client.query(
        `INSERT INTO corpus_migration_completions(
           run_id,item_kind,item_id,source_fingerprint,result_kind,
           output_document_id,output_revision_id,verified_revision_ids,
           verified_public_artifact_ids,actor_subject,
           details
         ) VALUES ($1,'page',$2,$3,'rewritten',$2,$4,$5::uuid[],$6::uuid[],$7,
           jsonb_build_object('target_document_ids',$8::uuid[]))`,
        [input.run_id, input.document_id, planned.source_fingerprint, input.revision.id,
          expectedVerified, expectedArtifacts, input.actor_subject, targets.receipt],
      );
      await hydrateCorpusKnowledge(client, {
        run_id: input.run_id,
        document_id: input.document_id,
        revision_id: input.revision.id,
        body_markdown_for_index: input.body_markdown_for_index,
        target_document_ids: targets.receipt,
      });
      return null;
    });
    if (driftError) {
      throw new CorpusMigrationInventoryDriftError(driftError, input.run_id);
    }
  }

  async applyHub(input: ApplyDirectoryHubInput): Promise<void> {
    assertBodyMatches(input.private_revision, input.private_revision.body_markdown_for_index);
    if (input.public_revision) {
      assertBodyMatches(input.public_revision, input.public_revision.body_markdown_for_index);
    }
    const driftError = await transaction(this.pool, async (client): Promise<string | null> => {
      // A new hub's page row points at the private version while both version rows point
      // back at the page; the schema intentionally makes this cycle deferrable.
      await client.query("SET CONSTRAINTS ALL DEFERRED");
      const result = await client.query<{
        source_fingerprint: string;
        snapshot: LegacyCorpusDirectory;
        disposition: CorpusDirectoryDisposition;
        temporary_path: string;
        private_revision_mode: "render" | "copy" | "existing";
        public_revision_mode: "render" | "existing" | null;
        private_source_revision_id: string | null;
        public_source_revision_id: string | null;
        private_revision_id: string;
        private_revision_number: number;
        public_revision_id: string | null;
        public_revision_number: number | null;
        private_projection_fingerprint: string;
        public_projection_fingerprint: string | null;
        expected_public_body: string | null;
      }>(
        `SELECT inventory.source_fingerprint,inventory.snapshot,plan.disposition,
           plan.temporary_path,
           plan.private_revision_mode,plan.public_revision_mode,
           plan.private_source_revision_id,plan.public_source_revision_id,
           plan.private_revision_id,plan.private_revision_number,
           plan.public_revision_id,plan.public_revision_number,
           plan.private_projection_fingerprint,plan.public_projection_fingerprint,
           CASE WHEN plan.public_revision_id IS NULL THEN NULL
             ELSE render_corpus_public_directory_hub(plan.run_id,plan.directory_id)
           END AS expected_public_body
         FROM corpus_directory_migration_plans plan
         JOIN corpus_migration_inventory inventory
           ON inventory.run_id=plan.run_id AND inventory.item_kind='directory'
          AND inventory.item_id=plan.directory_id
         JOIN corpus_migration_runs run ON run.id=plan.run_id
         WHERE plan.run_id=$1 AND plan.directory_id=$2
           AND plan.disposition IN ('hub','public_compatibility')
           AND run.phase='applying'
         FOR UPDATE OF run`,
        [input.run_id, input.directory_id],
      );
      const plan = result.rows[0];
      if (!plan) {
        return throwForMissingActiveRunItem(
          client,
          input.run_id,
          "Active directory hub migration plan not found",
        );
      }
      await client.query("SELECT lock_corpus_migration_hub_apply_tables()");
      if (input.private_revision.id !== plan.private_revision_id
          || input.private_revision.body_object_key !== `documents/private/${plan.private_revision_id}.md`
          || (input.public_revision?.id ?? null) !== plan.public_revision_id
          || (input.public_revision?.body_object_key ?? null) !== (
            plan.public_revision_id ? `documents/private/${plan.public_revision_id}.md` : null
          )) {
        throw new Error("Directory hub write does not match its stable migration plan");
      }
      const publicMetadata = publicDirectoryMetadata(plan.snapshot);
      const submittedPrivateTargets = uniqueSorted(input.private_revision.target_document_ids);
      const submittedPublicTargets = uniqueSorted(input.public_revision?.target_document_ids ?? []);
      if (JSON.stringify(submittedPrivateTargets) !== JSON.stringify(uniqueSorted(
        extractDocumentLinks(input.private_revision.body_markdown_for_index),
      )) || (input.public_revision && JSON.stringify(submittedPublicTargets)
        !== JSON.stringify(uniqueSorted(extractDocumentLinks(
          input.public_revision.body_markdown_for_index,
        ))))) {
        throw new Error("Directory hub link receipt does not match its Markdown");
      }
      const completed = await client.query<{
        output_revision_id: string | null;
        details: {
          private_target_document_ids?: string[];
          public_target_document_ids?: string[];
        };
      }>(
        `SELECT output_revision_id,details FROM corpus_migration_completions
         WHERE run_id=$1 AND item_kind='directory' AND item_id=$2`,
        [input.run_id, input.directory_id],
      );
      if (completed.rowCount) {
        const details = completed.rows[0]!.details;
        if (completed.rows[0]!.output_revision_id !== input.private_revision.id
            || JSON.stringify(uniqueSorted(details.private_target_document_ids ?? []))
              !== JSON.stringify(submittedPrivateTargets)
            || JSON.stringify(uniqueSorted(details.public_target_document_ids ?? []))
              !== JSON.stringify(submittedPublicTargets)) {
          await client.query(
            `UPDATE corpus_migration_runs
             SET phase='superseded',updated_at=now(),superseded_at=now()
             WHERE id=$1 AND phase='applying'`,
            [input.run_id],
          );
          return "Directory hub completion receipt changed across migration code versions";
        }
        await hydrateCorpusKnowledge(client, {
          run_id: input.run_id,
          document_id: input.directory_id,
          revision_id: input.private_revision.id,
          body_markdown_for_index: input.private_revision.body_markdown_for_index,
          target_document_ids: submittedPrivateTargets,
        });
        return null;
      }
      const locked = await client.query<{ locked: boolean }>(
        "SELECT lock_corpus_migration_item('directory',$1) AS locked",
        [input.directory_id],
      );
      if (locked.rows[0]?.locked !== true) {
        await client.query(
          `UPDATE corpus_migration_runs
           SET phase='superseded',updated_at=now(),superseded_at=now()
           WHERE id=$1 AND phase='applying'`,
          [input.run_id],
        );
        return "Legacy directory was removed after corpus inventory";
      }
      const live = await liveInspection(client, input.run_id);
      const liveDirectory = live.directories
        .find(({ directory_id }) => directory_id === input.directory_id);
      if (!liveDirectory || hash({ ...liveDirectory, has_existing_hub: false })
          !== plan.source_fingerprint) {
        await client.query(
          `UPDATE corpus_migration_runs
           SET phase='superseded',updated_at=now(),superseded_at=now()
           WHERE id=$1 AND phase='applying'`,
          [input.run_id],
        );
        return "Legacy directory changed after corpus inventory";
      }
      const liveDispositions = new Map((await client.query<{
        directory_id: string;
        disposition: CorpusDirectoryDisposition;
      }>(
        `SELECT directory_id,disposition
         FROM corpus_directory_migration_plans WHERE run_id=$1`,
        [input.run_id],
      )).rows.map(({ directory_id, disposition }) => [
        directory_id.toLowerCase(), disposition,
      ] as const));
      const liveFingerprints = directoryProjectionFingerprints(live, liveDispositions)
        .get(input.directory_id.toLowerCase());
      if (!liveFingerprints
          || liveFingerprints.privateFingerprint !== plan.private_projection_fingerprint
          || liveFingerprints.publicFingerprint !== plan.public_projection_fingerprint) {
        await client.query(
          `UPDATE corpus_migration_runs
           SET phase='superseded',updated_at=now(),superseded_at=now()
           WHERE id=$1 AND phase='applying'`,
          [input.run_id],
        );
        return "Directory hub projection changed after corpus inventory";
      }
      const existingHub = (await client.query<{
        document_id: string;
        current_path: string;
        archived_at: Date | string | null;
        current_version_id: string;
      }>(
        `SELECT mapping.document_id,page.current_path,page.archived_at,page.current_version_id
         FROM directory_hub_migrations mapping
         JOIN knowledge_pages page ON page.id=mapping.document_id
         WHERE mapping.directory_id=$1`,
        [input.directory_id],
      )).rows[0];
      if (existingHub && (
        existingHub.document_id !== input.directory_id
        || existingHub.current_path !== plan.temporary_path
        || existingHub.current_version_id !== plan.private_source_revision_id
        || existingHub.archived_at !== null
      )) {
        await client.query(
          `UPDATE corpus_migration_runs
           SET phase='superseded',updated_at=now(),superseded_at=now()
           WHERE id=$1 AND phase='applying'`,
          [input.run_id],
        );
        return "Existing directory hub changed after corpus inventory";
      }
      if (!existingHub && (await client.query(
        "SELECT 1 FROM hypermedia_documents WHERE id=$1",
        [input.directory_id],
      )).rowCount) {
        await client.query(
          `UPDATE corpus_migration_runs
           SET phase='superseded',updated_at=now(),superseded_at=now()
           WHERE id=$1 AND phase='applying'`,
          [input.run_id],
        );
        return "Directory hub identity collided after corpus inventory";
      }

      const privateSource = plan.private_source_revision_id
        ? (await client.query<Record<string, unknown>>(
            `SELECT revision.id AS source_revision_id,
               revision.body_object_key AS source_body_object_key,
               revision.body_size_bytes AS source_body_size_bytes,
               revision.body_content_hash AS source_body_content_hash,
               version.path AS source_path,version.title AS source_title,
               version.summary AS source_summary
             FROM hypermedia_document_revisions revision
             JOIN knowledge_page_versions version
               ON version.id=revision.id AND version.page_id=revision.document_id
             WHERE revision.id=$1 AND revision.document_id=$2`,
            [plan.private_source_revision_id, input.directory_id],
          )).rows[0]
        : null;
      const publicSource = plan.public_source_revision_id
        ? (await client.query<Record<string, unknown>>(
            `SELECT revision.id AS source_revision_id,
               revision.body_object_key AS source_body_object_key,
               revision.body_size_bytes AS source_body_size_bytes,
               revision.body_content_hash AS source_body_content_hash
             FROM hypermedia_document_revisions revision
             WHERE revision.id=$1 AND revision.document_id=$2`,
            [plan.public_source_revision_id, input.directory_id],
          )).rows[0]
        : null;
      if (plan.private_revision_mode !== "render" && !privateSource) {
        throw new Error("Directory hub private source revision changed after planning");
      }
      if (plan.public_revision_mode === "existing" && !publicSource) {
        throw new Error("Directory hub public-safe source revision changed after planning");
      }
      if (plan.private_revision_mode === "copy" && (
        input.private_revision.body_size_bytes !== Number(privateSource!.source_body_size_bytes)
        || input.private_revision.body_content_hash !== String(privateSource!.source_body_content_hash)
      )) {
        throw new Error("Copied directory hub body does not match the owner-authored current revision");
      }
      if (plan.private_revision_mode === "existing" && (
        input.private_revision.id !== plan.private_source_revision_id
        || input.private_revision.body_object_key !== String(privateSource!.source_body_object_key)
        || input.private_revision.body_size_bytes !== Number(privateSource!.source_body_size_bytes)
        || input.private_revision.body_content_hash !== String(privateSource!.source_body_content_hash)
      )) {
        throw new Error("Existing directory hub body does not match its frozen current revision");
      }
      if (plan.public_revision_mode === "existing" && (
        input.public_revision?.id !== plan.public_source_revision_id
        || input.public_revision.body_object_key !== String(publicSource!.source_body_object_key)
        || input.public_revision.body_size_bytes !== Number(publicSource!.source_body_size_bytes)
        || input.public_revision.body_content_hash !== String(publicSource!.source_body_content_hash)
      )) {
        throw new Error("Existing public-safe hub body does not match its frozen revision");
      }

      const privateTargets = await exactDocumentTargets(
        client,
        input.run_id,
        input.private_revision.body_markdown_for_index,
        input.private_revision.target_document_ids,
        "Private directory hub",
        plan.private_revision_mode === "render",
      );
      const publicTargets = input.public_revision
        ? await exactDocumentTargets(
            client,
            input.run_id,
            input.public_revision.body_markdown_for_index,
            input.public_revision.target_document_ids,
            "Public-safe directory hub",
            true,
          )
        : { receipt: [], indexed: [] };
      if (input.public_revision
          && input.public_revision.body_markdown_for_index !== plan.expected_public_body) {
        throw new Error("Public-safe directory hub body does not match its deterministic proof");
      }
      const expectedTargets = directoryProjectionTargets(
        live,
        liveDispositions,
        liveDirectory,
      );
      if (plan.private_revision_mode === "render"
          && JSON.stringify(privateTargets.receipt)
            !== JSON.stringify(expectedTargets.privateTargets)) {
        throw new Error("Private directory hub targets do not match its audited projection");
      }
      if (plan.public_revision_mode === "render"
          && JSON.stringify(publicTargets.receipt)
            !== JSON.stringify(expectedTargets.publicTargets)) {
        throw new Error("Public-safe directory hub targets do not match its audited projection");
      }
      if (publicTargets.receipt.length) {
        const allowed = await client.query<{ document_id: string }>(
          `SELECT inventory.item_id AS document_id
           FROM corpus_migration_inventory inventory
           WHERE inventory.run_id=$1 AND (
             inventory.item_kind='page'
             AND inventory.snapshot->'published_revision'<>'null'::jsonb
           )
           UNION
           SELECT directory_id
           FROM corpus_directory_migration_plans
           WHERE run_id=$1 AND public_revision_id IS NOT NULL`,
          [input.run_id],
        );
        const allowedIds = new Set(allowed.rows.map(({ document_id }) => document_id));
        if (publicTargets.receipt.some((id) => !allowedIds.has(id))) {
          throw new Error("Public-safe directory hub links to a private document");
        }
      }

      if (plan.disposition === "public_compatibility"
          && plan.private_revision_mode === "render") {
        if (!input.public_revision || plan.public_revision_mode !== "render"
            || input.private_revision.body_size_bytes !== input.public_revision.body_size_bytes
            || input.private_revision.body_content_hash !== input.public_revision.body_content_hash
            || input.private_revision.body_markdown_for_index
              !== input.public_revision.body_markdown_for_index
            || JSON.stringify(privateTargets.receipt) !== JSON.stringify(publicTargets.receipt)) {
          throw new Error(
            "Public compatibility carrier must exactly match its public-safe projection",
          );
        }
      }

      const privateTitle = plan.private_revision_mode === "copy"
        ? String(privateSource!.source_title)
        : plan.disposition === "public_compatibility"
        ? publicMetadata.title
        : plan.snapshot.title;
      const privateSummary = plan.private_revision_mode === "copy"
        ? String(privateSource!.source_summary)
        : plan.disposition === "public_compatibility"
        ? publicMetadata.summary
        : privateDirectoryHubSummary(plan.snapshot.summary);
      const privatePath = plan.private_revision_mode === "copy"
        ? String(privateSource!.source_path)
        : plan.temporary_path;

      if (!existingHub) {
        await client.query(
          `INSERT INTO hypermedia_documents(id,authority,representation)
           VALUES ($1,'knowledge','markdown')`,
          [input.directory_id],
        );
      }
      if (input.public_revision && plan.public_revision_mode === "render") {
        await client.query(
          `INSERT INTO hypermedia_document_revisions(
             id,document_id,revision_number,body_object_key,body_size_bytes,body_content_hash
           ) VALUES ($1,$2,$3,$4,$5,$6)`,
          [input.public_revision.id, input.directory_id, plan.public_revision_number,
            input.public_revision.body_object_key, input.public_revision.body_size_bytes,
            input.public_revision.body_content_hash],
        );
      }
      if (plan.private_revision_mode !== "existing") {
        await client.query(
          `INSERT INTO hypermedia_document_revisions(
             id,document_id,revision_number,body_object_key,body_size_bytes,body_content_hash
           ) VALUES ($1,$2,$3,$4,$5,$6)`,
          [input.private_revision.id, input.directory_id, plan.private_revision_number,
            input.private_revision.body_object_key, input.private_revision.body_size_bytes,
            input.private_revision.body_content_hash],
        );
      }
      if (!existingHub) {
        // The page's current-version FK is deferrable, while a version's page FK is not.
        // Insert this side of the cycle first and let the transaction validate both at commit.
        await client.query(
          `INSERT INTO knowledge_pages(id,current_path,current_version_id,search_vector)
           VALUES ($1,$2,$3,page_search_vector($2,$4,$5,$6))`,
          [input.directory_id, plan.temporary_path, input.private_revision.id,
            privateTitle, privateSummary, input.private_revision.body_markdown_for_index],
        );
      }
      if (input.public_revision && plan.public_revision_mode === "render") {
        await client.query(
          `INSERT INTO knowledge_page_versions(
             id,page_id,version_number,path,title,summary,commit_message,actor_kind,actor_subject
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,'dashboard',$8)`,
          [input.public_revision.id, input.directory_id, plan.public_revision_number,
            plan.temporary_path, publicMetadata.title, publicMetadata.summary,
            plan.disposition === "public_compatibility"
              ? "Create public-safe legacy route compatibility projection"
              : "Create public-safe legacy directory hub",
            input.actor_subject],
        );
      }
      if (plan.private_revision_mode !== "existing") {
        await client.query(
          `INSERT INTO knowledge_page_versions(
             id,page_id,version_number,path,title,summary,commit_message,actor_kind,actor_subject
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,'dashboard',$8)`,
          [input.private_revision.id, input.directory_id, plan.private_revision_number,
            privatePath, privateTitle, privateSummary,
            plan.disposition === "public_compatibility"
              ? "Maintain public-safe legacy route compatibility"
              : plan.private_revision_mode === "copy"
              ? "Preserve the curated hub while refreshing its public-safe projection"
              : "Convert legacy directory to an ordinary hypermedia hub",
            input.actor_subject],
        );
      }
      if (existingHub && plan.private_revision_mode !== "existing") {
        await client.query(
          `UPDATE knowledge_pages
           SET current_version_id=$2,
             search_vector=page_search_vector(current_path,$3,$4,$5),updated_at=now()
           WHERE id=$1`,
          [input.directory_id, input.private_revision.id, privateTitle,
            privateSummary, input.private_revision.body_markdown_for_index],
        );
        await client.query(
          "UPDATE hypermedia_documents SET updated_at=now() WHERE id=$1",
          [input.directory_id],
        );
      }
      if (input.public_revision) {
        await replaceKnowledgeProjections(
          client,
          input.public_revision.id,
          publicTargets.indexed,
        );
      }
      await replaceKnowledgeProjections(
        client,
        input.private_revision.id,
        privateTargets.indexed,
      );
      await client.query(
        "SELECT register_directory_hub_migration($1,$2)",
        [input.run_id, input.directory_id],
      );
      await client.query(
        `INSERT INTO corpus_migration_completions(
           run_id,item_kind,item_id,source_fingerprint,result_kind,
           output_document_id,output_revision_id,verified_revision_ids,actor_subject,details
         ) VALUES ($1,'directory',$2,$3,'hub',$2,$4,'{}'::uuid[],$5,
           jsonb_build_object(
             'private_target_document_ids',$6::uuid[],
             'public_target_document_ids',$7::uuid[]
           ))`,
        [input.run_id, input.directory_id, plan.source_fingerprint,
          input.private_revision.id, input.actor_subject,
          privateTargets.receipt, publicTargets.receipt],
      );
      await hydrateCorpusKnowledge(client, {
        run_id: input.run_id,
        document_id: input.directory_id,
        revision_id: input.private_revision.id,
        body_markdown_for_index: input.private_revision.body_markdown_for_index,
        target_document_ids: privateTargets.receipt,
      });
      return null;
    });
    if (driftError) {
      throw new CorpusMigrationInventoryDriftError(driftError, input.run_id);
    }
  }

  async readyObjects(runId: string): Promise<CorpusReadyObject[]> {
    const result = await transaction(this.pool, async (client) => {
      await client.query("SELECT 1 FROM corpus_migration_runs WHERE id=$1 FOR UPDATE", [runId]);
      await client.query("SELECT lock_corpus_migration_audit_tables()");
      const status = await this.statusWith(client, runId);
      if (status.phase !== "ready" || status.blockers.length) {
        if (status.phase === "ready") {
          await client.query(
            `UPDATE corpus_migration_runs
             SET phase='superseded',updated_at=now(),superseded_at=now()
             WHERE id=$1 AND phase='ready'`,
            [runId],
          );
        }
        return new Error("Corpus migration ready objects failed the live cutover audit");
      }
      const objects = await client.query<Record<string, unknown> & {
        document_id: string;
        kind: "knowledge" | "published";
        target_document_ids: string[];
        indexed_document_ids: string[];
        target_asset_ids: string[];
      }>(
        `WITH targets AS (
           SELECT page.id AS document_id,'knowledge'::text AS kind,
             page.current_version_id AS revision_id,
             completion.details->'target_document_ids' AS receipt
           FROM corpus_migration_inventory inventory
           JOIN knowledge_pages page ON page.id=inventory.item_id AND page.archived_at IS NULL
           JOIN corpus_migration_completions completion
             ON completion.run_id=inventory.run_id AND completion.item_kind='page'
            AND completion.item_id=inventory.item_id
           WHERE inventory.run_id=$1 AND inventory.item_kind='page'
           UNION ALL
           SELECT plan.directory_id,'knowledge',page.current_version_id,
             completion.details->'private_target_document_ids'
           FROM corpus_directory_migration_plans plan
           JOIN directory_hub_migrations mapping ON mapping.directory_id=plan.directory_id
           JOIN knowledge_pages page
             ON page.id=mapping.document_id AND page.archived_at IS NULL
            AND page.current_path=plan.temporary_path
           JOIN corpus_migration_completions completion
             ON completion.run_id=plan.run_id AND completion.item_kind='directory'
            AND completion.item_id=plan.directory_id AND completion.result_kind='hub'
            AND completion.output_revision_id=page.current_version_id
           WHERE plan.run_id=$1
             AND plan.disposition IN ('hub','public_compatibility')
           UNION ALL
           SELECT plan.directory_id,'published',plan.public_revision_id,
             completion.details->'public_target_document_ids'
           FROM corpus_directory_migration_plans plan
           JOIN corpus_migration_completions completion
             ON completion.run_id=plan.run_id AND completion.item_kind='directory'
            AND completion.item_id=plan.directory_id AND completion.result_kind='hub'
           WHERE plan.run_id=$1
             AND plan.disposition IN ('hub','public_compatibility')
             AND plan.public_revision_id IS NOT NULL
         )
         SELECT targets.document_id,targets.kind,
           revision.id AS ready_revision_id,
           revision.revision_number AS ready_revision_number,
           revision.body_object_key AS ready_body_object_key,
           revision.body_size_bytes AS ready_body_size_bytes,
           revision.body_content_hash AS ready_body_content_hash,
           revision.links_indexed_at AS ready_links_indexed_at,
           CASE WHEN targets.receipt IS NULL THEN ARRAY(
               SELECT link.target_document_id FROM document_links link
               WHERE link.source_revision_id=revision.id ORDER BY link.target_document_id
             ) ELSE ARRAY(
               SELECT value::uuid FROM jsonb_array_elements_text(targets.receipt) value
               ORDER BY value::uuid
             ) END AS target_document_ids,
           ARRAY(
             SELECT link.target_document_id FROM document_links link
             WHERE link.source_revision_id=revision.id ORDER BY link.target_document_id
           ) AS indexed_document_ids,
           ARRAY(
             SELECT link.target_asset_id FROM knowledge_asset_links link
             WHERE link.source_version_id=revision.id ORDER BY link.target_asset_id
           ) AS target_asset_ids
         FROM targets
         JOIN hypermedia_document_revisions revision
           ON revision.id=targets.revision_id AND revision.document_id=targets.document_id
         ORDER BY targets.document_id,targets.kind,revision.id`,
        [runId],
      );
      return objects.rows.map((row) => ({
        document_id: row.document_id,
        kind: row.kind,
        revision: objectRef(row, "ready")!,
        target_document_ids: row.target_document_ids,
        indexed_document_ids: row.indexed_document_ids,
        target_asset_ids: row.target_asset_ids,
      }));
    });
    if (result instanceof Error) throw result;
    return result;
  }

  async hydrateReadyKnowledge(input: HydrateCorpusKnowledgeInput): Promise<void> {
    const targets = uniqueSorted(input.target_document_ids);
    if (JSON.stringify(targets)
        !== JSON.stringify(uniqueSorted(extractDocumentLinks(input.body_markdown_for_index)))) {
      throw new Error("Ready knowledge hydration link receipt does not match its Markdown");
    }
    await hydrateCorpusKnowledge(this.pool, { ...input, target_document_ids: targets });
  }

  async status(runId: string): Promise<CorpusMigrationStatus> {
    return transaction(this.pool, async (client) => {
      await client.query("SELECT 1 FROM corpus_migration_runs WHERE id=$1 FOR UPDATE", [runId]);
      await client.query("SELECT lock_corpus_migration_audit_tables()");
      const status = await this.statusWith(client, runId);
      if (status.phase !== "ready" || !status.blockers.length) return status;
      await client.query(
        `UPDATE corpus_migration_runs
         SET phase='superseded',updated_at=now(),superseded_at=now()
         WHERE id=$1 AND phase='ready'`,
        [runId],
      );
      return { ...status, phase: "superseded" };
    });
  }

  private async statusWith(
    client: PoolClient,
    runId: string,
  ): Promise<CorpusMigrationStatus> {
    const runResult = await client.query<RunRow>(
      `SELECT id,inventory_token,plan_token,settings_snapshot,readable_document_ids,phase
       FROM corpus_migration_runs WHERE id=$1`,
      [runId],
    );
    const run = runResult.rows[0];
    if (!run) throw new Error("Corpus migration run not found");
    const countResult = await client.query<{ total: string; completed: string }>(
      `SELECT count(*)::text AS total,
         count(completion.item_id)::text AS completed
       FROM corpus_migration_inventory inventory
       LEFT JOIN corpus_migration_completions completion
         ON completion.run_id=inventory.run_id
        AND completion.item_kind=inventory.item_kind
        AND completion.item_id=inventory.item_id
       WHERE inventory.run_id=$1`,
      [runId],
    );
    const counts = {
      total: Number(countResult.rows[0]?.total ?? 0),
      completed: Number(countResult.rows[0]?.completed ?? 0),
    };
    const blockers: CorpusMigrationBlocker[] = [];
    if (run.phase === "superseded") {
      blockers.push({ code: "run_superseded", detail: "The audited corpus run was superseded" });
    }
    const incomplete = await client.query<{
      item_kind: CorpusMigrationItemKind;
      item_id: string;
    }>(
      `SELECT inventory.item_kind,inventory.item_id
       FROM corpus_migration_inventory inventory
       LEFT JOIN corpus_migration_completions completion
         ON completion.run_id=inventory.run_id
        AND completion.item_kind=inventory.item_kind
        AND completion.item_id=inventory.item_id
       WHERE inventory.run_id=$1 AND completion.item_id IS NULL
       ORDER BY inventory.item_kind,inventory.item_id`,
      [runId],
    );
    blockers.push(...incomplete.rows.map((item) => ({
      code: "item_incomplete",
      item_kind: item.item_kind,
      item_id: item.item_id,
      detail: "Inventory item has no verified completion",
    })));

    // Reconstruct the live filesystem projection instead of trusting a stored
    // ready bit. Derived link timestamps are excluded from fingerprints; every
    // authority-bearing identity, revision, path, publication and object
    // reference is compared against either the source snapshot or its audited
    // rewrite completion.
    const live = await liveInspection(client, null);
    if (counts.completed === counts.total
        && JSON.stringify(uniqueSorted(live.readable_document_ids))
          !== JSON.stringify(uniqueSorted(run.readable_document_ids))) {
      blockers.push({
        code: "readable_identity_drift",
        detail: "The path-independent readable document identity set changed after inventory",
      });
    }
    const liveItems = new Map(inventoryItems(live)
      .map((item) => [`${item.item_kind}:${item.item_id}`, item] as const));
    const auditedItems = await client.query<InventoryItem & {
      result_kind: string | null;
      output_revision_id: string | null;
      verified_revision_ids: string[] | null;
      verified_public_artifact_ids: string[] | null;
    }>(
      `SELECT inventory.item_kind,inventory.item_id,inventory.legacy_path,
         inventory.source_fingerprint,inventory.snapshot,
         completion.result_kind,completion.output_revision_id,
         completion.verified_revision_ids,completion.verified_public_artifact_ids
       FROM corpus_migration_inventory inventory
       LEFT JOIN corpus_migration_completions completion
         ON completion.run_id=inventory.run_id
        AND completion.item_kind=inventory.item_kind
        AND completion.item_id=inventory.item_id
       WHERE inventory.run_id=$1
       ORDER BY inventory.item_kind,inventory.item_id`,
      [runId],
    );
    for (const item of auditedItems.rows) {
      const current = liveItems.get(`${item.item_kind}:${item.item_id}`);
      if (!current) {
        blockers.push({
          code: "inventoried_item_missing",
          item_kind: item.item_kind,
          item_id: item.item_id,
          detail: "An inventoried live item was removed after the audit began",
        });
        continue;
      }
      if (item.item_kind === "page" && item.result_kind === "rewritten") {
        const source = item.snapshot as LegacyCorpusPage;
        const page = current.snapshot as LegacyCorpusPage;
        const publicationMatches = hash({
          path: page.path,
          title: page.title,
          summary: page.summary,
          archived_at: page.archived_at,
          published_revision: page.published_revision,
          published_artifact: page.published_artifact,
          published_title: page.published_title,
          published_summary: page.published_summary,
          public_path: page.public_path,
          public_id: page.public_id,
          public_aliases: page.public_aliases,
          is_global_guide: page.is_global_guide,
        }) === hash({
          path: source.path,
          title: source.title,
          summary: source.summary,
          archived_at: source.archived_at,
          published_revision: source.published_revision,
          published_artifact: source.published_artifact,
          published_title: source.published_title,
          published_summary: source.published_summary,
          public_path: source.public_path,
          public_id: source.public_id,
          public_aliases: source.public_aliases,
          is_global_guide: source.is_global_guide,
        });
        if (!publicationMatches || page.current_revision.revision_id !== item.output_revision_id) {
          blockers.push({
            code: "rewritten_page_drift",
            item_kind: "page",
            item_id: item.item_id,
            detail: "A migrated page no longer matches its audited current/public state",
          });
        }
        const expectedReceipt = expectedVerifiedRevisionIds("page", source);
        if (JSON.stringify(uniqueSorted(item.verified_revision_ids ?? []))
            !== JSON.stringify(expectedReceipt)) {
          blockers.push({
            code: "published_object_unverified",
            item_kind: "page",
            item_id: item.item_id,
            detail: "Current and distinct published source objects were not all verified",
          });
        }
        const expectedArtifacts = expectedVerifiedArtifactIds("page", source);
        if (JSON.stringify(uniqueSorted(item.verified_public_artifact_ids ?? []))
            !== JSON.stringify(expectedArtifacts)) {
          blockers.push({
            code: "published_artifact_unverified",
            item_kind: "page",
            item_id: item.item_id,
            detail: "The exact active public projection artifact was not verified",
          });
        }
      } else if (current.source_fingerprint !== item.source_fingerprint) {
        blockers.push({
          code: "inventoried_item_drift",
          item_kind: item.item_kind,
          item_id: item.item_id,
          detail: "An inventoried item changed after the audit began",
        });
      }
      if (item.result_kind === "preserved" && item.item_kind !== "directory") {
        const expectedReceipt = expectedVerifiedRevisionIds(
          item.item_kind,
          item.snapshot as LegacyCorpusPage | LegacyCorpusAsset | LegacyCorpusRecord,
        );
        if (JSON.stringify(uniqueSorted(item.verified_revision_ids ?? []))
            !== JSON.stringify(expectedReceipt)) {
          blockers.push({
            code: "object_verification_receipt_invalid",
            item_kind: item.item_kind,
            item_id: item.item_id,
            detail: "Preserved object verification does not cover the audited live revisions",
          });
        }
        const expectedArtifacts = expectedVerifiedArtifactIds(
          item.item_kind,
          item.snapshot as LegacyCorpusPage | LegacyCorpusAsset | LegacyCorpusRecord,
        );
        if (JSON.stringify(uniqueSorted(item.verified_public_artifact_ids ?? []))
            !== JSON.stringify(expectedArtifacts)) {
          blockers.push({
            code: "public_artifact_receipt_invalid",
            item_kind: item.item_kind,
            item_id: item.item_id,
            detail: "Preserved public artifact verification does not match the audit",
          });
        }
      }
    }

    const unindexed = await client.query<{ document_id: string }>(
      `SELECT page.id AS document_id
       FROM knowledge_pages page
       LEFT JOIN hypermedia_document_revisions revision
         ON revision.id=page.current_version_id AND revision.document_id=page.id
       WHERE page.archived_at IS NULL
         AND (revision.id IS NULL OR revision.links_indexed_at IS NULL)
       ORDER BY page.id`,
    );
    blockers.push(...unindexed.rows.map(({ document_id }) => ({
      code: "current_knowledge_links_unindexed",
      item_kind: "page" as const,
      item_id: document_id,
      detail: "A live current knowledge revision has not been link-indexed",
    })));
    const projectionReceipts = await client.query<{
      document_id: string;
      revision_id: string;
      projection_kind: string;
      expected_document_ids: string[];
      actual_document_ids: string[];
      expected_asset_ids: string[];
      actual_asset_ids: string[];
    }>(
      `WITH expected AS (
         SELECT completion.item_id AS document_id,
           CASE WHEN completion.result_kind='rewritten'
             THEN completion.output_revision_id
             ELSE (inventory.snapshot#>>'{current_revision,revision_id}')::uuid
           END AS revision_id,
           'current'::text AS projection_kind,
           coalesce(completion.details->'target_document_ids','[]'::jsonb) AS targets
         FROM corpus_migration_completions completion
         JOIN corpus_migration_inventory inventory
           ON inventory.run_id=completion.run_id
          AND inventory.item_kind=completion.item_kind
          AND inventory.item_id=completion.item_id
         WHERE completion.run_id=$1 AND completion.item_kind='page'
         UNION ALL
         SELECT completion.item_id,plan.private_revision_id,'hub_private',
           coalesce(completion.details->'private_target_document_ids','[]'::jsonb)
         FROM corpus_migration_completions completion
         JOIN corpus_directory_migration_plans plan
           ON plan.run_id=completion.run_id AND plan.directory_id=completion.item_id
         WHERE completion.run_id=$1 AND completion.item_kind='directory'
           AND completion.result_kind='hub'
         UNION ALL
         SELECT completion.item_id,plan.public_revision_id,'hub_public',
           coalesce(completion.details->'public_target_document_ids','[]'::jsonb)
         FROM corpus_migration_completions completion
         JOIN corpus_directory_migration_plans plan
           ON plan.run_id=completion.run_id AND plan.directory_id=completion.item_id
         WHERE completion.run_id=$1 AND completion.item_kind='directory'
           AND completion.result_kind='hub' AND plan.public_revision_id IS NOT NULL
       )
         SELECT expected.document_id,expected.revision_id,expected.projection_kind,
           ARRAY(
             SELECT document.id
             FROM jsonb_array_elements_text(expected.targets) value
             JOIN hypermedia_documents document ON document.id=value::uuid
             WHERE EXISTS (
               SELECT 1 FROM corpus_migration_runs run
               WHERE run.id=$1 AND document.id=ANY(run.readable_document_ids)
             )
             ORDER BY document.id
           ) AS expected_document_ids,
         ARRAY(
           SELECT link.target_document_id FROM document_links link
           WHERE link.source_revision_id=expected.revision_id
           ORDER BY link.target_document_id
         ) AS actual_document_ids,
         ARRAY(
           SELECT asset.id FROM jsonb_array_elements_text(expected.targets) value
           JOIN assets asset ON asset.id=value::uuid AND asset.deleted_at IS NULL
           ORDER BY asset.id
         ) AS expected_asset_ids,
         ARRAY(
           SELECT link.target_asset_id FROM knowledge_asset_links link
           WHERE link.source_version_id=expected.revision_id
           ORDER BY link.target_asset_id
         ) AS actual_asset_ids
       FROM expected
       ORDER BY expected.document_id,expected.projection_kind`,
      [runId],
    );
    for (const projection of projectionReceipts.rows) {
      if (JSON.stringify(projection.expected_document_ids)
            !== JSON.stringify(projection.actual_document_ids)
          || JSON.stringify(projection.expected_asset_ids)
            !== JSON.stringify(projection.actual_asset_ids)) {
        blockers.push({
          code: "knowledge_projection_mismatch",
          item_kind: projection.projection_kind.startsWith("hub") ? "directory" : "page",
          item_id: projection.document_id,
          detail: `Derived document/asset links do not match the audited ${projection.projection_kind} Markdown`,
        });
      }
    }
    const sourceEdges = await client.query<{ document_id: string }>(
      `SELECT DISTINCT revision.document_id
       FROM hypermedia_document_revisions revision
       JOIN hypermedia_documents document ON document.id=revision.document_id
       JOIN source_records record
         ON record.document_id=revision.document_id
        AND record.current_revision_id=revision.id
       LEFT JOIN document_links link ON link.source_revision_id=revision.id
       WHERE document.authority='source'
         AND (link.source_revision_id IS NOT NULL OR revision.links_indexed_at IS NULL)
       ORDER BY revision.document_id`,
    );
    blockers.push(...sourceEdges.rows.map(({ document_id }) => ({
      code: "source_graph_projection_invalid",
      item_kind: "record" as const,
      item_id: document_id,
      detail: "Source evidence must have an authoritative empty outbound link set",
    })));

    const invalidAutomations = await client.query<{ key: string }>(
      `SELECT plan.key
       FROM corpus_migration_automation_plans plan
       LEFT JOIN automation_registry registry
         ON registry.id=plan.id
        AND registry.key=plan.key
        AND registry.instructions_document_id=plan.instructions_document_id
        AND registry.state_document_id IS NOT DISTINCT FROM plan.state_document_id
       WHERE plan.run_id=$1 AND registry.id IS NULL
       ORDER BY plan.key`,
      [runId],
    );
    blockers.push(...invalidAutomations.rows.map(({ key }) => ({
      code: "automation_registry_incomplete",
      detail: `Automation registry does not match planned identity: ${key}`,
    })));

    const invalidHubs = await client.query<{ directory_id: string; completed: boolean }>(
      `SELECT plan.directory_id,(completion.item_id IS NOT NULL) AS completed
       FROM corpus_directory_migration_plans plan
       JOIN corpus_migration_inventory inventory
         ON inventory.run_id=plan.run_id AND inventory.item_kind='directory'
        AND inventory.item_id=plan.directory_id
       JOIN corpus_migration_runs run ON run.id=plan.run_id
       LEFT JOIN corpus_migration_completions completion
         ON completion.run_id=plan.run_id AND completion.item_kind='directory'
        AND completion.item_id=plan.directory_id AND completion.result_kind='hub'
       LEFT JOIN directory_hub_migrations mapping
         ON mapping.directory_id=plan.directory_id
        AND mapping.document_id=plan.directory_id
       LEFT JOIN knowledge_pages page
         ON page.id=plan.directory_id
        AND page.current_path=plan.temporary_path
        AND page.current_version_id=plan.private_revision_id
        AND page.archived_at IS NULL
       LEFT JOIN hypermedia_document_revisions private_revision
         ON private_revision.id=page.current_version_id
        AND private_revision.document_id=plan.directory_id
        AND private_revision.links_indexed_at IS NOT NULL
       LEFT JOIN hypermedia_document_revisions public_revision
         ON public_revision.id=plan.public_revision_id
        AND public_revision.document_id=plan.directory_id
        AND public_revision.links_indexed_at IS NOT NULL
       WHERE plan.run_id=$1
         AND plan.disposition IN ('hub','public_compatibility')
         AND (
           mapping.directory_id IS NULL OR page.id IS NULL OR private_revision.id IS NULL
           OR (
             completion.item_id IS NOT NULL AND (
               mapping.migration_run_id<>plan.run_id
               OR mapping.private_revision_id<>plan.private_revision_id
               OR mapping.public_revision_id IS DISTINCT FROM plan.public_revision_id
               OR mapping.private_projection_fingerprint<>plan.private_projection_fingerprint
               OR mapping.public_projection_fingerprint
                  IS DISTINCT FROM plan.public_projection_fingerprint
             )
           )
           OR (plan.public_revision_id IS NOT NULL AND public_revision.id IS NULL)
           OR (
             plan.public_revision_id IS NOT NULL AND NOT EXISTS (
               SELECT 1 FROM public_route_aliases alias
               WHERE alias.alias_path='/p/'||(inventory.snapshot->>'path')||'/'
                 AND alias.route_kind='directory' AND alias.public_id=plan.public_id
             )
           )
         )
       ORDER BY plan.directory_id`,
      [runId],
    );
    blockers.push(...invalidHubs.rows.map(({ directory_id, completed }) => ({
      code: completed ? "completed_directory_hub_drift" : "directory_hub_invalid",
      item_kind: "directory" as const,
      item_id: directory_id,
      detail: "Directory hub no longer matches its stable audited mapping",
    })));

    const settings = run.settings_snapshot;
    const settingsDrift = await client.query<{ drifted: boolean }>(
      `SELECT (
         knowledge.global_guide_document_id IS DISTINCT FROM $1::uuid
         OR entrypoint.id IS DISTINCT FROM $2::uuid
       ) AS drifted
       FROM knowledge_settings knowledge
       CROSS JOIN public_knowledge_settings publication
       LEFT JOIN knowledge_pages entrypoint
         ON entrypoint.id=publication.entrypoint_page_id
        AND entrypoint.archived_at IS NULL
        AND entrypoint.published_version_id IS NOT NULL
        AND entrypoint.public_path IS NOT NULL
       WHERE knowledge.singleton AND publication.singleton`,
      [settings.global_guide_document_id, settings.public_entrypoint_document_id],
    );
    if (settingsDrift.rows[0]?.drifted !== false) {
      blockers.push({ code: "settings_drift", detail: "Knowledge guide or public entrypoint changed after inventory" });
    }

    const liveKinds: Array<[CorpusMigrationItemKind, string]> = [
      ["directory", `SELECT id FROM knowledge_directories
        UNION SELECT directory_id AS id FROM legacy_public_directory_prefixes`],
      ["page", `SELECT id FROM knowledge_pages page
        WHERE page.archived_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM directory_hub_migrations hub WHERE hub.document_id=page.id)`],
      ["asset", "SELECT id FROM assets WHERE deleted_at IS NULL"],
      ["record", "SELECT document_id AS id FROM source_records"],
    ];
    for (const [kind, source] of liveKinds) {
      const drift = await client.query<{ id: string }>(
        `SELECT live.id FROM (${source}) live
         LEFT JOIN corpus_migration_inventory inventory
           ON inventory.run_id=$1 AND inventory.item_kind=$2 AND inventory.item_id=live.id
         WHERE inventory.item_id IS NULL ORDER BY live.id`,
        [runId, kind],
      );
      blockers.push(...drift.rows.map(({ id }) => ({
        code: "uninventoried_live_item",
        item_kind: kind,
        item_id: id,
        detail: "A live corpus item was created after inventory",
      })));
    }

    return {
      run_id: run.id,
      phase: run.phase,
      inventory_token: run.inventory_token,
      counts,
      blockers: blockers.sort((left, right) => (
        `${left.code}:${left.item_kind ?? ""}:${left.item_id ?? ""}`
          .localeCompare(`${right.code}:${right.item_kind ?? ""}:${right.item_id ?? ""}`, "en")
      )),
    };
  }

  async seal(runId: string): Promise<CorpusMigrationStatus> {
    return transaction(this.pool, async (client) => {
      await client.query("SELECT 1 FROM corpus_migration_runs WHERE id=$1 FOR UPDATE", [runId]);
      await client.query("SELECT lock_corpus_migration_audit_tables()");
      let status = await this.statusWith(client, runId);
      if (status.phase === "ready" && status.blockers.length) {
        await client.query(
          `UPDATE corpus_migration_runs
           SET phase='superseded',updated_at=now(),superseded_at=now()
           WHERE id=$1 AND phase='ready'`,
          [runId],
        );
        return { ...status, phase: "superseded" };
      }
      const irrecoverable = new Set([
        "settings_drift",
        "uninventoried_live_item",
        "inventoried_item_missing",
        "inventoried_item_drift",
        "rewritten_page_drift",
        "readable_identity_drift",
        "completed_directory_hub_drift",
      ]);
      if (status.phase === "applying"
          && status.blockers.some(({ code }) => irrecoverable.has(code))) {
        await client.query(
          `UPDATE corpus_migration_runs
           SET phase='superseded',updated_at=now(),superseded_at=now()
           WHERE id=$1 AND phase='applying'`,
          [runId],
        );
        return { ...status, phase: "superseded" };
      }
      if (status.phase !== "applying" || status.blockers.length) return status;
      await client.query(
        `UPDATE corpus_migration_runs
         SET phase='ready',updated_at=now(),ready_at=now()
         WHERE id=$1 AND phase='applying'`,
        [runId],
      );
      status = await this.statusWith(client, runId);
      return status;
    });
  }
}
