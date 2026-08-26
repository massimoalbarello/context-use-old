import { z } from "zod";

export const PAGE_MARKDOWN_BODY_DESCRIPTION = [
  "Markdown page body.",
  "Link to any object with [Label](context-use://object/<uuid>); append #heading-slug to link to a section.",
  "Heading slugs are lowercase words joined by hyphens (## Next Steps becomes #next-steps); repeated headings add -2, -3, and so on.",
  "Embed an image or video asset with ![Alt](context-use://object/<uuid>).",
  "Optional safe image or video attributes immediately follow it: {size=small|medium|large|full align=left|center|right shape=auto|square|portrait|landscape layout=block|half|third}.",
  "Use layout=half or layout=third on consecutive images or videos for responsive columns.",
  "Example: ![Portrait](context-use://object/<uuid>){size=medium align=center shape=square}.",
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
export const pageEntityTypeSchema = z.enum([
  "person",
  "organization",
  "place",
  "event",
  "thing",
]);
export type PageEntityType = z.infer<typeof pageEntityTypeSchema>;
export const KnowledgeSummary = z
  .string()
  .trim()
  .min(1)
  .max(320)
  .refine((value) => !/[\r\n]/.test(value), "Use a single-line summary")
  .describe("Required one-sentence summary used in object discovery and search results.");
const PageBodyMarkdown = z.string().max(2_000_000).describe(PAGE_MARKDOWN_BODY_DESCRIPTION);

export const createPageSchema = z
  .object({
    title: z.string().trim().min(1).max(240),
    summary: KnowledgeSummary.describe(
      "Required one-sentence summary used in object search and private link previews.",
    ),
    body_markdown: PageBodyMarkdown,
    entity_type: pageEntityTypeSchema.nullable().optional().describe(
      "Optional bounded entity designation for the one canonical introductory page of a person, organization, place, event, or thing. Do not apply it to pages that merely mention an entity.",
    ),
    commit_message: CommitMessage,
  })
  .strict();

export const updatePageSchema = z
  .object({
    title: z.string().trim().min(1).max(240),
    summary: KnowledgeSummary.describe(
      "Required one-sentence summary used in object search and private link previews.",
    ),
    body_markdown: PageBodyMarkdown,
    entity_type: pageEntityTypeSchema.nullable().optional().describe(
      "Set the canonical entity designation, clear it with null, or omit it to preserve the current designation.",
    ),
    commit_message: CommitMessage,
    expected_revision_number: z.number().int().positive(),
  })
  .strict();

export const archivePageSchema = z
  .object({
    commit_message: CommitMessage,
    expected_revision_number: z.number().int().positive(),
  })
  .strict();

const pagePublishIntentSchema = z.object({
  action: z.literal("publish"),
  target_kind: z.literal("page"),
  target_object_id: UUID,
  expected_revision_id: UUID,
}).strict();

const pageUnpublishIntentSchema = z.object({
  action: z.literal("unpublish"),
  target_kind: z.literal("page"),
  target_object_id: UUID,
}).strict();

const assetPublishIntentSchema = z.object({
  action: z.literal("publish"),
  target_kind: z.literal("asset"),
  target_object_id: UUID,
}).strict();

const assetUnpublishIntentSchema = z.object({
  action: z.literal("unpublish"),
  target_kind: z.literal("asset"),
  target_object_id: UUID,
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
const AssetObjectFilename = AssetFilename.refine(
  (value) => value !== "." && value !== ".." && !/[\\/\u0000-\u001f\u007f]/.test(value),
  "Use a filename, not a path or control characters",
);
const AssetObjectContentType = z.string().trim().min(1).max(255).refine(
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
  public_filename: AssetObjectFilename,
  public_content_type: AssetObjectContentType,
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

export const createAssetSchema = z.object({
  filename: AssetObjectFilename.describe("Filename presented for this asset."),
  content_type: AssetObjectContentType,
  size_bytes: z.number().int().min(0).max(5_000_000_000),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  duration_seconds: z.number().nonnegative().optional(),
}).strict();

export const archiveAssetSchema = z.object({
  object_id: UUID,
}).strict();

export const archiveSourceRecordSchema = z.object({
  object_id: UUID,
  expected_revision_id: UUID.nullable(),
}).strict();

export const deleteSourceRecordSchema = archiveSourceRecordSchema.extend({
  confirm: z.literal(true).describe(
    "Explicit confirmation that this archived source record and every retained revision should be permanently deleted.",
  ),
}).strict();

export type PublicationIntentInput = z.infer<typeof publicationIntentSchema>;
export type PublicationArtifactReceipt = z.infer<
  typeof publicationArtifactReceiptSchema
>;
export type PublicationEntrypointInput = z.infer<
  typeof publicationEntrypointSchema
>;
export type PublicRouteInput = z.infer<typeof publicRouteSchema>;
export type CreatePageInput = z.infer<typeof createPageSchema>;
export type UpdatePageInput = z.infer<typeof updatePageSchema>;
export type ArchivePageInput = z.infer<typeof archivePageSchema>;
export type CreateAssetInput = z.infer<typeof createAssetSchema>;
export type ArchiveAssetInput = z.infer<typeof archiveAssetSchema>;
export type ArchiveSourceRecordInput = z.infer<typeof archiveSourceRecordSchema>;
export type DeleteSourceRecordInput = z.infer<typeof deleteSourceRecordSchema>;

export const dashboardObjectKindSchema = z.enum(["page", "record", "asset"]);
export const dashboardObjectLifecycleSchema = z.enum(["active", "archived", "deleted"]);
export const dashboardObjectOperationalRoleSchema = z.enum([
  "global_guide",
  "automation_instructions",
  "automation_state",
]);

/** Canonical, locator-free object metadata safe for the authenticated dashboard. */
export const dashboardObjectSummarySchema = z.object({
  object_id: UUID,
  object_kind: dashboardObjectKindSchema,
  authority: z.enum(["knowledge", "source"]),
  representation: z.enum(["markdown", "asset"]),
  lifecycle: dashboardObjectLifecycleSchema,
  current_revision_id: UUID.nullable(),
  entity_type: pageEntityTypeSchema.nullable(),
  title: z.string().nullable(),
  summary: z.string().nullable(),
  filename: z.string().nullable(),
  content_type: z.string().nullable(),
  integration: z.string().nullable(),
  source_model: z.string().nullable(),
  operational_roles: z.array(dashboardObjectOperationalRoleSchema),
  updated_at: z.string().datetime({ offset: true }),
}).strict();

export const dashboardObjectCatalogPageSchema = z.object({
  objects: z.array(dashboardObjectSummarySchema),
  next_cursor: z.string().nullable(),
  has_more: z.boolean(),
}).strict();

export const dashboardObjectNeighborSchema = z.object({
  target_object_id: UUID,
  resolved: z.boolean(),
  object: dashboardObjectSummarySchema.nullable(),
}).strict();

export const dashboardObjectNeighborhoodSchema = z.object({
  object: dashboardObjectSummarySchema,
  outbound: z.object({
    revision_id: UUID.nullable(),
    neighbors: z.array(dashboardObjectNeighborSchema),
    next_cursor: UUID.nullable(),
    has_more: z.boolean(),
    index_complete: z.boolean(),
  }).strict(),
  backlinks: z.object({
    objects: z.array(dashboardObjectSummarySchema),
    next_cursor: UUID.nullable(),
    has_more: z.boolean(),
    completeness_checked: z.boolean(),
    complete: z.boolean().nullable(),
  }).strict(),
}).strict();

export type DashboardObjectKind = z.infer<typeof dashboardObjectKindSchema>;
export type DashboardObjectLifecycle = z.infer<typeof dashboardObjectLifecycleSchema>;
export type DashboardObjectOperationalRole = z.infer<
  typeof dashboardObjectOperationalRoleSchema
>;
export type DashboardObjectSummary = z.infer<typeof dashboardObjectSummarySchema>;
export type DashboardObjectCatalogPage = z.infer<typeof dashboardObjectCatalogPageSchema>;
export type DashboardObjectNeighbor = z.infer<typeof dashboardObjectNeighborSchema>;
export type DashboardObjectNeighborhood = z.infer<typeof dashboardObjectNeighborhoodSchema>;
export type Actor = {
  kind: "dashboard" | "mcp";
  subject: string;
};

export const MCP_SCOPE = "mcp:access" as const;
export const MCP_SCOPES = [MCP_SCOPE] as const;
