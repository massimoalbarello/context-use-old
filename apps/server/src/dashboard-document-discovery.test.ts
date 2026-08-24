import { describe, expect, test } from "bun:test";
import type {
  PrivateDocumentCatalogItem,
  PrivateDocumentNeighborhood,
} from "@context-use/database";
import {
  dashboardDocumentCatalogPage,
  dashboardDocumentNeighborhood,
  dashboardDocumentSummary,
  parseDashboardDocumentCatalogQuery,
  parseDashboardDocumentNeighborhoodQuery,
} from "./dashboard-document-discovery.ts";

const documentId = "11111111-1111-4111-8111-111111111111";
const revisionId = "22222222-2222-4222-8222-222222222222";
const linkedId = "33333333-3333-4333-8333-333333333333";

const catalogItem: PrivateDocumentCatalogItem = {
  document_id: documentId,
  document_kind: "knowledge",
  authority: "knowledge",
  representation: "markdown",
  lifecycle: "active",
  current_revision_id: revisionId,
  current_revision_number: 7,
  title: "Investment notes",
  summary: "A concise summary of the current investment thesis.",
  filename: null,
  content_type: null,
  size_bytes: "1234",
  content_hash: "a".repeat(64),
  width: null,
  height: null,
  duration_seconds: null,
  integration: null,
  connection_instance_id: null,
  connection_id: null,
  source_model: null,
  source_record_id: null,
  operational_roles: ["directory_hub"],
  public_id: "44444444-4444-4444-8444-444444444444",
  current_link_contract: "generic_document_v1",
  links_indexed_at: "2026-08-23T10:00:00.000Z",
  pathless_search_ready: true,
  created_at: "2026-08-22T10:00:00.000Z",
  updated_at: "2026-08-23T10:00:00.000Z",
};

describe("dashboard document discovery", () => {
  test("parses bounded search, list and neighborhood queries", () => {
    expect(parseDashboardDocumentCatalogQuery({
      q: "  investment notes  ",
      cursor: "opaque",
      limit: "25",
      include_retired: "true",
      authority: "knowledge",
      kind: "knowledge",
      lifecycle: "archived",
    })).toEqual({
      query: "investment notes",
      options: {
        cursor: "opaque",
        limit: 25,
        include_retired: true,
        authority: "knowledge",
        document_kind: "knowledge",
        lifecycle: "archived",
      },
    });
    expect(parseDashboardDocumentCatalogQuery({ q: "" })).toEqual({
      query: null,
      options: {},
    });
    expect(() => parseDashboardDocumentCatalogQuery({ limit: "101" })).toThrow();
    expect(() => parseDashboardDocumentCatalogQuery({ extra: "private" })).toThrow();

    expect(parseDashboardDocumentNeighborhoodQuery({
      revision_id: revisionId,
      outbound_cursor: linkedId,
      backlink_cursor: documentId,
      limit: "40",
    })).toEqual({
      requested_revision_id: revisionId,
      outbound_after_document_id: linkedId,
      backlink_after_document_id: documentId,
      outbound_limit: 40,
      backlink_limit: 40,
    });
    expect(() => parseDashboardDocumentNeighborhoodQuery({
      outbound_cursor: "not-a-uuid",
    })).toThrow();
  });

  test("projects titles and summaries without compatibility paths or private locators", () => {
    const summary = dashboardDocumentSummary(catalogItem);
    expect(summary).toEqual({
      document_id: documentId,
      document_kind: "knowledge",
      authority: "knowledge",
      representation: "markdown",
      lifecycle: "active",
      current_revision_id: revisionId,
      title: "Investment notes",
      summary: "A concise summary of the current investment thesis.",
      filename: null,
      content_type: null,
      operational_roles: ["directory_hub"],
      updated_at: "2026-08-23T10:00:00.000Z",
    });
    const encoded = JSON.stringify(summary);
    for (const forbidden of [
      "current_path",
      "content_hash",
      "source_record_id",
      "connection_id",
      "public_id",
      "links_indexed_at",
    ]) expect(encoded).not.toContain(forbidden);

    expect(dashboardDocumentCatalogPage({
      documents: [catalogItem],
      next_cursor: "next",
      has_more: true,
    })).toEqual({ documents: [summary], next_cursor: "next", has_more: true });
  });

  test("preserves graph completeness and unresolved target state without leaking evidence", () => {
    const neighborhood: PrivateDocumentNeighborhood = {
      document: catalogItem,
      outbound: {
        revision_id: revisionId,
        neighbors: [{ target_document_id: linkedId, resolved: false, document: null }],
        next_cursor: null,
        has_more: false,
        index_complete: true,
      },
      backlinks: {
        documents: [catalogItem],
        next_cursor: null,
        has_more: false,
        completeness_checked: false,
        complete: null,
      },
    };
    const projected = dashboardDocumentNeighborhood(neighborhood);
    expect(projected.outbound.neighbors).toEqual([{
      target_document_id: linkedId,
      resolved: false,
      document: null,
    }]);
    expect(projected.backlinks.complete).toBeNull();
    expect(JSON.stringify(projected)).not.toContain("body_content_hash");
  });
});
