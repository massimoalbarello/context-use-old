import type { PrivateObjectCatalogItem, SourceRecordRepository } from "@context-use/database";
import { pageEntityTypeSchema } from "@context-use/shared";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createAssetCapability } from "../asset-capability.ts";
import type { HypermediaReader, McpContext, McpObjectRepositories } from "../contracts.ts";
import { jsonContent, jsonObjectContent } from "../tool-content.ts";

function objectCatalogSummary(object: PrivateObjectCatalogItem) {
  return {
    object_id: object.object_id,
    object_kind: object.object_kind,
    authority: object.authority,
    representation: object.representation,
    lifecycle: object.lifecycle,
    current_revision_id: object.current_revision_id,
    entity_type: object.entity_type,
    title: object.title,
    summary: object.summary,
    filename: object.filename,
    content_type: object.content_type,
    operational_roles: object.operational_roles,
    updated_at: object.updated_at,
    reference: `context-use://object/${object.object_id}`,
  };
}

export function registerObjectTools(input: {
  server: McpServer;
  context: McpContext;
  objects: McpObjectRepositories;
  records?: SourceRecordRepository;
  hypermedia: HypermediaReader;
  appOrigin: string;
  capabilitySecret: string;
}): void {
  const { server } = input;
  server.registerTool(
    "search_objects",
    {
      description:
        "Search the unified private object catalog by title, summary, filename and indexed text. Returns stable object references and preview metadata without blob locators or source-system identifiers. Use read_object to load one selected object.",
      inputSchema: z
        .object({
          query: z.string().trim().min(1).max(500),
          object_kind: z.enum(["page", "record", "asset"]).optional(),
          entity_types: z
            .array(pageEntityTypeSchema)
            .min(1)
            .max(5)
            .refine(
              (entries) => new Set(entries).size === entries.length,
              "Entity types must be unique",
            )
            .optional()
            .describe(
              "Filter canonical entity pages by one or more entity types. Cannot be combined with record or asset object_kind.",
            ),
          include_retired: z.boolean().default(false),
          cursor: z.string().min(1).max(4096).optional(),
          limit: z.number().int().min(1).max(100).default(30),
        })
        .strict()
        // biome-ignore lint/complexity/useMaxParams: Zod owns this callback signature.
        .superRefine((value, refinement) => {
          if (value.entity_types && value.object_kind && value.object_kind !== "page") {
            refinement.addIssue({
              code: "custom",
              path: ["entity_types"],
              message: "Entity type filters apply only to pages",
            });
          }
        }),
      annotations: { readOnlyHint: true },
    },
    async ({ query, object_kind, entity_types, include_retired, cursor, limit }) => {
      const result = await input.objects.objectCatalog.search(query, {
        ...(object_kind ? { object_kind } : {}),
        ...(entity_types ? { entity_types } : {}),
        include_retired,
        ...(cursor ? { cursor } : {}),
        limit,
      });
      return jsonObjectContent({
        objects: result.objects.map(objectCatalogSummary),
        next_cursor: result.next_cursor,
        has_more: result.has_more,
      });
    },
  );

  server.registerTool(
    "read_object",
    {
      description:
        "Read one private object by stable UUID. Pages and records return current Markdown and hypermedia links; assets return metadata and a short-lived checksum-bound download request. Blob keys are never exposed.",
      inputSchema: z.object({ object_id: z.string().uuid() }).strict(),
      annotations: { readOnlyHint: true },
    },
    async ({ object_id }) => {
      const catalog = await input.objects.objectCatalog.get(object_id);
      if (!catalog) {
        return jsonContent(null);
      }
      if (catalog.object_kind === "page") {
        const page = await input.objects.pages.get(object_id);
        if (!page) {
          return jsonContent(null);
        }
        return jsonContent({
          ...objectCatalogSummary(catalog),
          revision_number: page.revision_number,
          body_markdown: page.body_markdown,
          hypermedia: await input.hypermedia({
            objectId: page.object_id,
            revisionId: page.current_revision_id,
          }),
        });
      }
      if (catalog.object_kind === "record") {
        const record = await input.records?.get(object_id);
        if (!record) {
          return jsonContent(null);
        }
        return jsonContent({
          ...objectCatalogSummary(catalog),
          revision_number: record.revision_number,
          body_markdown: record.body_markdown,
          hypermedia: await input.hypermedia({
            objectId: record.object_id,
            revisionId: record.current_revision_id,
          }),
        });
      }
      const asset = await input.objects.assets.get(object_id, { include_deleted: true });
      if (!asset) {
        return jsonContent(null);
      }
      const capability = createAssetCapability(
        "download",
        object_id,
        input.context,
        Date.now(),
        input.capabilitySecret,
      );
      return jsonContent({
        ...objectCatalogSummary(catalog),
        size_bytes: asset.size_bytes,
        content_hash: asset.content_hash,
        width: asset.width,
        height: asset.height,
        duration_seconds: asset.duration_seconds,
        download: {
          method: "GET",
          url: `${input.appOrigin}/api/mcp/assets/${encodeURIComponent(object_id)}/content`,
          headers: { "x-context-use-download-token": capability.token },
          expires_at: capability.expiresAt,
        },
      });
    },
  );
}
