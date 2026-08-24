import { z } from "zod";

export const PAGE_MARKDOWN_BODY_DESCRIPTION = [
  "Markdown page body.",
  "Link to any document with [Label](context-use://document/<uuid>); append #heading-slug to link to a section.",
  "Heading slugs are lowercase words joined by hyphens (## Next Steps becomes #next-steps); repeated headings add -2, -3, and so on.",
  "Embed an image or video document with ![Alt](context-use://document/<uuid>).",
  "Optional safe image or video attributes immediately follow it: {size=small|medium|large|full align=left|center|right shape=auto|square|portrait|landscape layout=block|half|third}.",
  "Use layout=half or layout=third on consecutive images or videos for responsive columns.",
  "Example: ![Portrait](context-use://document/<uuid>){size=medium align=center shape=square}.",
  "Images and videos with enforced shapes crop with object-fit: cover; assets must be published independently before public pages can render them.",
].join(" ");

export const IMAGE_LAYOUT_STYLES = `.cu-image{box-sizing:border-box;display:block;margin:1rem 0;vertical-align:top}.cu-image>img,.cu-image>video{display:block;width:100%;max-width:none;height:auto}.cu-image--size-small{width:min(100%,240px)}.cu-image--size-medium{width:min(100%,420px)}.cu-image--size-large{width:min(100%,640px)}.cu-image--size-full{width:100%}.cu-image--align-left{margin-right:auto}.cu-image--align-center{margin-right:auto;margin-left:auto}.cu-image--align-right{margin-left:auto}.cu-image--shape-square,.cu-image--shape-portrait,.cu-image--shape-landscape{overflow:hidden}.cu-image--shape-square{aspect-ratio:1/1}.cu-image--shape-portrait{aspect-ratio:4/5}.cu-image--shape-landscape{aspect-ratio:16/9}.cu-image--shape-square>img,.cu-image--shape-square>video,.cu-image--shape-portrait>img,.cu-image--shape-portrait>video,.cu-image--shape-landscape>img,.cu-image--shape-landscape>video{height:100%;object-fit:cover}.cu-image--layout-half,.cu-image--layout-third{display:inline-block;margin:.5rem .5rem .5rem 0}.cu-image--layout-half{width:calc(50% - 1rem)}.cu-image--layout-third{width:calc(33.333% - 1rem)}@media(max-width:640px){.cu-image--layout-half,.cu-image--layout-third{display:block;width:100%;margin:1rem 0}}`;

export const UUID = z.string().uuid();
export const PublicRouteSuffix = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[a-z0-9][a-z0-9/_-]*$/, "Use lowercase path segments only")
  .refine((value) => !value.includes("//") && !value.endsWith("/"), "Invalid path");
export const CommitMessage = z.string().trim().min(3).max(240);
export const KnowledgeSummary = z
  .string()
  .trim()
  .min(1)
  .max(320)
  .refine((value) => !/[\r\n]/.test(value), "Use a single-line summary")
  .describe("Required one-sentence summary used in generated directory indexes and search results.");
const PageBodyMarkdown = z.string().max(2_000_000).describe(PAGE_MARKDOWN_BODY_DESCRIPTION);

export const createKnowledgeDocumentSchema = z
  .object({
    title: z.string().trim().min(1).max(240),
    summary: KnowledgeSummary.describe(
      "Required one-sentence summary used in document search and private link previews.",
    ),
    body_markdown: PageBodyMarkdown,
    commit_message: CommitMessage,
  })
  .strict();

export const updateKnowledgeDocumentSchema = z
  .object({
    title: z.string().trim().min(1).max(240),
    summary: KnowledgeSummary.describe(
      "Required one-sentence summary used in document search and private link previews.",
    ),
    body_markdown: PageBodyMarkdown,
    commit_message: CommitMessage,
    expected_revision_number: z.number().int().positive(),
  })
  .strict();

export const archiveKnowledgeDocumentSchema = z
  .object({
    commit_message: CommitMessage,
    expected_revision_number: z.number().int().positive(),
  })
  .strict();

const pagePublishIntentSchema = z.object({
  action: z.literal("publish"),
  target_kind: z.literal("page"),
  target_document_id: UUID,
  expected_revision_id: UUID,
}).strict();

const pageUnpublishIntentSchema = z.object({
  action: z.literal("unpublish"),
  target_kind: z.literal("page"),
  target_document_id: UUID,
}).strict();

const assetPublishIntentSchema = z.object({
  action: z.literal("publish"),
  target_kind: z.literal("asset"),
  target_document_id: UUID,
}).strict();

const assetUnpublishIntentSchema = z.object({
  action: z.literal("unpublish"),
  target_kind: z.literal("asset"),
  target_document_id: UUID,
}).strict();

/** Four exact variants keep page revision approval distinct from asset publication. */
export const publicationIntentSchema = z.union([
  pagePublishIntentSchema,
  pageUnpublishIntentSchema,
  assetPublishIntentSchema,
  assetUnpublishIntentSchema,
]);

export const publicationEntrypointSchema = z.object({
  public_id: UUID.nullable(),
}).strict();

function isPublicRoute(value: string): boolean {
  if (value === "/p/") return true;
  if (value.startsWith("/a/")) return PublicRouteSuffix.safeParse(value.slice(3)).success;
  if (!value.startsWith("/p/")) return false;

  const suffix = value.slice(3);
  if (suffix.endsWith("/")) return PublicRouteSuffix.safeParse(suffix.slice(0, -1)).success;
  if (suffix.endsWith(".md")) return PublicRouteSuffix.safeParse(suffix.slice(0, -3)).success;
  return PublicRouteSuffix.safeParse(suffix).success;
}

/** Exact canonical and grandfathered-alias routes accepted by the public resolver. */
export const publicRouteSchema = z.string().refine(
  isPublicRoute,
  "Use an exact /p/, /p/<path>, /p/<path>.md, or /a/<path> public route",
);

const AssetFilename = z.string().trim().min(1).max(1024);
const DocumentAssetFilename = AssetFilename.refine(
  (value) => value !== "." && value !== ".." && !/[\\/\u0000-\u001f\u007f]/.test(value),
  "Use a filename, not a path or control characters",
);
const DocumentAssetContentType = z.string().trim().min(1).max(255).refine(
  (value) => !/[\r\n\u0000]/.test(value),
  "Content type cannot contain control characters",
);

const Hex64 = z.string().regex(/^[a-f0-9]{64}$/);
const CanonicalNonnegativeDecimal = z.string().max(1024).regex(
  /^(?:0|[1-9]\d*)(?:\.\d+)?$/,
  "Use a canonical nonnegative decimal string",
);
const CanonicalLowercaseUUID = UUID.refine(
  (value) => value === value.toLowerCase(),
  "Use canonical lowercase UUIDs",
);
const CanonicalPublicUUIDArray = z.array(CanonicalLowercaseUUID).max(100_000).superRefine(
  (values, context) => {
    for (let index = 1; index < values.length; index += 1) {
      if (values[index - 1]! >= values[index]!) {
        context.addIssue({
          code: "custom",
          path: [index],
          message: "Public UUIDs must be unique and sorted in canonical lowercase order",
        });
      }
    }
  },
);

const pagePublicationArtifactReceiptSchema = z.object({
  intent_id: UUID,
  target_kind: z.literal("page"),
  body_size_bytes: z.number().int().min(0).max(4_000_000),
  body_content_hash: Hex64,
  public_title: z.string().trim().min(1).max(240),
  public_summary: KnowledgeSummary,
  public_last_edited_at: z.iso.datetime({ offset: true }),
  projected_target_public_ids: CanonicalPublicUUIDArray,
  observed_public_uuid_tokens: CanonicalPublicUUIDArray,
  projection_receipt_hash: Hex64,
}).strict().superRefine((value, context) => {
  if (
    value.projected_target_public_ids.length !== value.observed_public_uuid_tokens.length
    || value.projected_target_public_ids.some((publicId, index) => (
      publicId !== value.observed_public_uuid_tokens[index]
    ))
  ) {
    context.addIssue({
      code: "custom",
      path: ["observed_public_uuid_tokens"],
      message: "Observed public UUID tokens must exactly match the projected public UUID set",
    });
  }
});

const assetPublicationArtifactReceiptSchema = z.object({
  intent_id: UUID,
  target_kind: z.literal("asset"),
  body_size_bytes: z.number().int().min(0).max(5_000_000_000),
  body_content_hash: Hex64,
  public_filename: DocumentAssetFilename,
  public_content_type: DocumentAssetContentType,
  public_width: z.number().int().positive().nullish(),
  public_height: z.number().int().positive().nullish(),
  // PostgreSQL `numeric` may be more precise than a JavaScript number. The
  // storage receipt carries its exact database text so staging can compare it
  // without rounding.
  public_duration_seconds: CanonicalNonnegativeDecimal.nullish(),
}).strict();

export const publicationArtifactReceiptSchema = z.discriminatedUnion("target_kind", [
  pagePublicationArtifactReceiptSchema,
  assetPublicationArtifactReceiptSchema,
]);

export const createDocumentAssetSchema = z.object({
  filename: DocumentAssetFilename.describe("Filename presented for this document asset."),
  content_type: DocumentAssetContentType,
  size_bytes: z.number().int().min(0).max(5_000_000_000),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  duration_seconds: z.number().nonnegative().optional(),
}).strict();

export const archiveDocumentAssetSchema = z.object({
  asset_id: UUID,
}).strict();

export type PublicationIntentInput = z.infer<typeof publicationIntentSchema>;
export type PublicationArtifactReceipt = z.infer<
  typeof publicationArtifactReceiptSchema
>;
export type PublicationEntrypointInput = z.infer<
  typeof publicationEntrypointSchema
>;
export type PublicRouteInput = z.infer<typeof publicRouteSchema>;
export type CreateKnowledgeDocumentInput = z.infer<typeof createKnowledgeDocumentSchema>;
export type UpdateKnowledgeDocumentInput = z.infer<typeof updateKnowledgeDocumentSchema>;
export type ArchiveKnowledgeDocumentInput = z.infer<typeof archiveKnowledgeDocumentSchema>;
export type CreateDocumentAssetInput = z.infer<typeof createDocumentAssetSchema>;
export type ArchiveDocumentAssetInput = z.infer<typeof archiveDocumentAssetSchema>;

export const dashboardDocumentKindSchema = z.enum(["knowledge", "record", "asset"]);
export const dashboardDocumentLifecycleSchema = z.enum(["active", "archived", "deleted"]);
export const dashboardDocumentOperationalRoleSchema = z.enum([
  "global_guide",
  "automation_instructions",
  "automation_state",
]);

/** Canonical, locator-free document metadata safe for the authenticated dashboard. */
export const dashboardDocumentSummarySchema = z.object({
  document_id: UUID,
  document_kind: dashboardDocumentKindSchema,
  authority: z.enum(["knowledge", "source"]),
  representation: z.enum(["markdown", "asset"]),
  lifecycle: dashboardDocumentLifecycleSchema,
  current_revision_id: UUID.nullable(),
  title: z.string().nullable(),
  summary: z.string().nullable(),
  filename: z.string().nullable(),
  content_type: z.string().nullable(),
  integration: z.string().nullable(),
  source_model: z.string().nullable(),
  operational_roles: z.array(dashboardDocumentOperationalRoleSchema),
  updated_at: z.string().datetime({ offset: true }),
}).strict();

export const dashboardDocumentCatalogPageSchema = z.object({
  documents: z.array(dashboardDocumentSummarySchema),
  next_cursor: z.string().nullable(),
  has_more: z.boolean(),
}).strict();

export const dashboardDocumentNeighborSchema = z.object({
  target_document_id: UUID,
  resolved: z.boolean(),
  document: dashboardDocumentSummarySchema.nullable(),
}).strict();

export const dashboardDocumentNeighborhoodSchema = z.object({
  document: dashboardDocumentSummarySchema,
  outbound: z.object({
    revision_id: UUID.nullable(),
    neighbors: z.array(dashboardDocumentNeighborSchema),
    next_cursor: UUID.nullable(),
    has_more: z.boolean(),
    index_complete: z.boolean(),
  }).strict(),
  backlinks: z.object({
    documents: z.array(dashboardDocumentSummarySchema),
    next_cursor: UUID.nullable(),
    has_more: z.boolean(),
    completeness_checked: z.boolean(),
    complete: z.boolean().nullable(),
  }).strict(),
}).strict();

export type DashboardDocumentKind = z.infer<typeof dashboardDocumentKindSchema>;
export type DashboardDocumentLifecycle = z.infer<typeof dashboardDocumentLifecycleSchema>;
export type DashboardDocumentOperationalRole = z.infer<
  typeof dashboardDocumentOperationalRoleSchema
>;
export type DashboardDocumentSummary = z.infer<typeof dashboardDocumentSummarySchema>;
export type DashboardDocumentCatalogPage = z.infer<typeof dashboardDocumentCatalogPageSchema>;
export type DashboardDocumentNeighbor = z.infer<typeof dashboardDocumentNeighborSchema>;
export type DashboardDocumentNeighborhood = z.infer<typeof dashboardDocumentNeighborhoodSchema>;
export type Actor = {
  kind: "dashboard" | "mcp";
  subject: string;
};

export const MCP_SCOPE = "mcp:access" as const;
export const MCP_SCOPES = [MCP_SCOPE] as const;
