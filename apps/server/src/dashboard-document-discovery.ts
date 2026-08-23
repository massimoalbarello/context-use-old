import type {
  PrivateDocumentCatalogFilters,
  PrivateDocumentCatalogItem,
  PrivateDocumentCatalogPage,
  PrivateDocumentNeighborhood,
} from "@context-use/database";
import {
  dashboardDocumentCatalogPageSchema,
  dashboardDocumentNeighborhoodSchema,
  dashboardDocumentSummarySchema,
  type DashboardDocumentCatalogPage,
  type DashboardDocumentNeighborhood,
  type DashboardDocumentSummary,
} from "@context-use/shared";
import { z } from "zod";

const OptionalQuery = z.preprocess(
  (value) => typeof value === "string" && value.trim() === "" ? undefined : value,
  z.string().trim().max(2048).optional(),
);
const OptionalCursor = z.preprocess(
  (value) => value === "" ? undefined : value,
  z.string().max(8192).optional(),
);
const OptionalUuid = z.preprocess(
  (value) => value === "" ? undefined : value,
  z.string().uuid().optional(),
);
const OptionalLimit = z.preprocess(
  (value) => value === "" || value === undefined ? undefined : value,
  z.coerce.number().int().min(1).max(100).optional(),
);
const OptionalBoolean = z.preprocess(
  (value) => value === "" || value === undefined ? undefined : value,
  z.enum(["true", "false"]).transform((entry) => entry === "true").optional(),
);

const catalogQuerySchema = z.object({
  q: OptionalQuery,
  cursor: OptionalCursor,
  limit: OptionalLimit,
  include_retired: OptionalBoolean,
  kind: z.enum(["knowledge", "record", "asset"]).optional(),
  lifecycle: z.enum(["active", "archived", "deleted"]).optional(),
}).strict();

const neighborhoodQuerySchema = z.object({
  revision_id: OptionalUuid,
  outbound_cursor: OptionalUuid,
  backlink_cursor: OptionalUuid,
  limit: OptionalLimit,
}).strict();

export type DashboardDocumentCatalogRequest = {
  query: string | null;
  options: PrivateDocumentCatalogFilters & {
    cursor?: string;
    limit?: number;
    include_retired?: boolean;
  };
};

export type DashboardDocumentNeighborhoodRequest = {
  requested_revision_id?: string;
  outbound_after_document_id?: string;
  outbound_limit?: number;
  backlink_after_document_id?: string;
  backlink_limit?: number;
};

export function parseDashboardDocumentCatalogQuery(
  input: Record<string, string | undefined>,
): DashboardDocumentCatalogRequest {
  const parsed = catalogQuerySchema.parse(input);
  return {
    query: parsed.q ?? null,
    options: {
      ...(parsed.cursor ? { cursor: parsed.cursor } : {}),
      ...(parsed.limit ? { limit: parsed.limit } : {}),
      ...(parsed.include_retired === undefined
        ? {}
        : { include_retired: parsed.include_retired }),
      ...(parsed.kind ? { document_kind: parsed.kind } : {}),
      ...(parsed.lifecycle ? { lifecycle: parsed.lifecycle } : {}),
    },
  };
}

export function parseDashboardDocumentNeighborhoodQuery(
  input: Record<string, string | undefined>,
): DashboardDocumentNeighborhoodRequest {
  const parsed = neighborhoodQuerySchema.parse(input);
  return {
    ...(parsed.revision_id ? { requested_revision_id: parsed.revision_id } : {}),
    ...(parsed.outbound_cursor
      ? { outbound_after_document_id: parsed.outbound_cursor }
      : {}),
    ...(parsed.backlink_cursor
      ? { backlink_after_document_id: parsed.backlink_cursor }
      : {}),
    ...(parsed.limit
      ? { outbound_limit: parsed.limit, backlink_limit: parsed.limit }
      : {}),
  };
}

export function dashboardDocumentSummary(
  document: PrivateDocumentCatalogItem,
): DashboardDocumentSummary {
  return dashboardDocumentSummarySchema.parse({
    document_id: document.document_id,
    document_kind: document.document_kind,
    authority: document.authority,
    representation: document.representation,
    lifecycle: document.lifecycle,
    current_revision_id: document.current_revision_id,
    title: document.title,
    summary: document.summary,
    filename: document.filename,
    content_type: document.content_type,
    operational_roles: document.operational_roles,
    updated_at: document.updated_at,
  });
}

export function dashboardDocumentCatalogPage(
  page: PrivateDocumentCatalogPage,
): DashboardDocumentCatalogPage {
  return dashboardDocumentCatalogPageSchema.parse({
    documents: page.documents.map(dashboardDocumentSummary),
    next_cursor: page.next_cursor,
    has_more: page.has_more,
  });
}

export function dashboardDocumentNeighborhood(
  neighborhood: PrivateDocumentNeighborhood,
): DashboardDocumentNeighborhood {
  return dashboardDocumentNeighborhoodSchema.parse({
    document: dashboardDocumentSummary(neighborhood.document),
    outbound: {
      revision_id: neighborhood.outbound.revision_id,
      neighbors: neighborhood.outbound.neighbors.map((neighbor) => ({
        target_document_id: neighbor.target_document_id,
        resolved: neighbor.resolved,
        document: neighbor.document ? dashboardDocumentSummary(neighbor.document) : null,
      })),
      next_cursor: neighborhood.outbound.next_cursor,
      has_more: neighborhood.outbound.has_more,
      index_complete: neighborhood.outbound.index_complete,
    },
    backlinks: {
      documents: neighborhood.backlinks.documents.map(dashboardDocumentSummary),
      next_cursor: neighborhood.backlinks.next_cursor,
      has_more: neighborhood.backlinks.has_more,
      completeness_checked: neighborhood.backlinks.completeness_checked,
      complete: neighborhood.backlinks.complete,
    },
  });
}
