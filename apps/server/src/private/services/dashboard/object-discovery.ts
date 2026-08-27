import type {
  PrivateObjectCatalogFilters,
  PrivateObjectCatalogItem,
  PrivateObjectCatalogPage,
  PrivateObjectNeighborhood,
} from "@context-use/database";
import {
  type DashboardObjectCatalogPage,
  type DashboardObjectNeighborhood,
  type DashboardObjectSummary,
  dashboardObjectCatalogPageSchema,
  dashboardObjectNeighborhoodSchema,
  dashboardObjectSummarySchema,
  pageEntityTypeSchema,
} from "@context-use/shared";
import { z } from "zod";

const OptionalQuery = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().trim().max(2048).optional(),
);
const OptionalCursor = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().max(8192).optional(),
);
const OptionalUuid = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().uuid().optional(),
);
const OptionalLimit = z.preprocess(
  (value) => (value === "" || value === undefined ? undefined : value),
  z.coerce.number().int().min(1).max(100).optional(),
);
const OptionalBoolean = z.preprocess(
  (value) => (value === "" || value === undefined ? undefined : value),
  z
    .enum(["true", "false"])
    .transform((entry) => entry === "true")
    .optional(),
);
const OptionalCatalogTypes = z.preprocess(
  (value) =>
    typeof value === "string" && value.trim()
      ? value.split(",").map((entry) => entry.trim())
      : undefined,
  z
    .array(z.enum(["page", "record", "asset", "public", "archived"]))
    .min(1)
    .max(5)
    .refine((entries) => new Set(entries).size === entries.length, "Types must be unique")
    .optional(),
);
const OptionalEntityTypes = z.preprocess(
  (value) =>
    typeof value === "string" && value.trim()
      ? value.split(",").map((entry) => entry.trim())
      : undefined,
  z
    .array(pageEntityTypeSchema)
    .min(1)
    .max(5)
    .refine((entries) => new Set(entries).size === entries.length, "Entity types must be unique")
    .optional(),
);

const catalogQuerySchema = z
  .object({
    q: OptionalQuery,
    cursor: OptionalCursor,
    limit: OptionalLimit,
    include_retired: OptionalBoolean,
    authority: z.enum(["knowledge", "source"]).optional(),
    kind: z.enum(["page", "record", "asset"]).optional(),
    lifecycle: z.enum(["active", "archived", "deleted"]).optional(),
    types: OptionalCatalogTypes,
    entities: OptionalEntityTypes,
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.entities) {
      return;
    }
    if (value.kind && value.kind !== "page") {
      context.addIssue({
        code: "custom",
        path: ["entities"],
        message: "Entity filters apply only to pages",
      });
    }
    if (value.types?.some((type) => type === "record" || type === "asset")) {
      context.addIssue({
        code: "custom",
        path: ["entities"],
        message: "Entity filters cannot be combined with record or asset filters",
      });
    }
  });

const neighborhoodQuerySchema = z
  .object({
    revision_id: OptionalUuid,
    outbound_cursor: OptionalUuid,
    backlink_cursor: OptionalUuid,
    limit: OptionalLimit,
  })
  .strict();

export type DashboardObjectCatalogRequest = {
  query: string | null;
  options: PrivateObjectCatalogFilters & {
    cursor?: string;
    limit?: number;
    include_retired?: boolean;
  };
};

export type DashboardObjectNeighborhoodRequest = {
  requested_revision_id?: string;
  outbound_after_object_id?: string;
  outbound_limit?: number;
  backlink_after_object_id?: string;
  backlink_limit?: number;
};

export function parseDashboardObjectCatalogQuery(
  input: Record<string, string | undefined>,
): DashboardObjectCatalogRequest {
  const parsed = catalogQuerySchema.parse(input);
  return {
    query: parsed.q ?? null,
    options: {
      ...(parsed.cursor ? { cursor: parsed.cursor } : {}),
      ...(parsed.limit ? { limit: parsed.limit } : {}),
      ...(parsed.include_retired === undefined ? {} : { include_retired: parsed.include_retired }),
      ...(parsed.authority ? { authority: parsed.authority } : {}),
      ...(parsed.kind ? { object_kind: parsed.kind } : {}),
      ...(parsed.lifecycle ? { lifecycle: parsed.lifecycle } : {}),
      ...(parsed.types ? { catalog_types: parsed.types } : {}),
      ...(parsed.entities ? { entity_types: parsed.entities } : {}),
    },
  };
}

export function parseDashboardObjectNeighborhoodQuery(
  input: Record<string, string | undefined>,
): DashboardObjectNeighborhoodRequest {
  const parsed = neighborhoodQuerySchema.parse(input);
  return {
    ...(parsed.revision_id ? { requested_revision_id: parsed.revision_id } : {}),
    ...(parsed.outbound_cursor ? { outbound_after_object_id: parsed.outbound_cursor } : {}),
    ...(parsed.backlink_cursor ? { backlink_after_object_id: parsed.backlink_cursor } : {}),
    ...(parsed.limit ? { outbound_limit: parsed.limit, backlink_limit: parsed.limit } : {}),
  };
}

export function dashboardObjectSummary(object: PrivateObjectCatalogItem): DashboardObjectSummary {
  return dashboardObjectSummarySchema.parse({
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
    integration: object.integration,
    source_model: object.source_model,
    operational_roles: object.operational_roles,
    updated_at: object.updated_at,
  });
}

export function dashboardObjectCatalogPage(
  page: PrivateObjectCatalogPage,
): DashboardObjectCatalogPage {
  return dashboardObjectCatalogPageSchema.parse({
    objects: page.objects.map(dashboardObjectSummary),
    next_cursor: page.next_cursor,
    has_more: page.has_more,
  });
}

export function dashboardObjectNeighborhood(
  neighborhood: PrivateObjectNeighborhood,
): DashboardObjectNeighborhood {
  return dashboardObjectNeighborhoodSchema.parse({
    object: dashboardObjectSummary(neighborhood.object),
    outbound: {
      revision_id: neighborhood.outbound.revision_id,
      neighbors: neighborhood.outbound.neighbors.map((neighbor) => ({
        target_object_id: neighbor.target_object_id,
        resolved: neighbor.resolved,
        object: neighbor.object ? dashboardObjectSummary(neighbor.object) : null,
      })),
      next_cursor: neighborhood.outbound.next_cursor,
      has_more: neighborhood.outbound.has_more,
      index_complete: neighborhood.outbound.index_complete,
    },
    backlinks: {
      objects: neighborhood.backlinks.objects.map(dashboardObjectSummary),
      next_cursor: neighborhood.backlinks.next_cursor,
      has_more: neighborhood.backlinks.has_more,
      completeness_checked: neighborhood.backlinks.completeness_checked,
      complete: neighborhood.backlinks.complete,
    },
  });
}
