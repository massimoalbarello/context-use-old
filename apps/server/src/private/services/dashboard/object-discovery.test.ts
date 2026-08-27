import { describe, expect, test } from "bun:test";
import type { PrivateObjectCatalogItem, PrivateObjectNeighborhood } from "@context-use/database";
import {
  dashboardObjectCatalogPage,
  dashboardObjectNeighborhood,
  dashboardObjectSummary,
  parseDashboardObjectCatalogQuery,
  parseDashboardObjectNeighborhoodQuery,
} from "#private/services/dashboard/object-discovery.ts";

const documentId = "11111111-1111-4111-8111-111111111111";
const revisionId = "22222222-2222-4222-8222-222222222222";
const linkedId = "33333333-3333-4333-8333-333333333333";

const catalogItem: PrivateObjectCatalogItem = {
  object_id: documentId,
  object_kind: "page",
  authority: "knowledge",
  representation: "markdown",
  lifecycle: "active",
  current_revision_id: revisionId,
  current_revision_number: 7,
  entity_type: "organization",
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
  operational_roles: ["automation_instructions"],
  public_id: "44444444-4444-4444-8444-444444444444",
  current_link_contract: "generic_document_v1",
  links_indexed_at: "2026-08-23T10:00:00.000Z",
  search_ready: true,
  created_at: "2026-08-22T10:00:00.000Z",
  updated_at: "2026-08-23T10:00:00.000Z",
};

describe("dashboard object discovery", () => {
  test("parses bounded search, list and neighborhood queries", () => {
    expect(
      parseDashboardObjectCatalogQuery({
        q: "  investment notes  ",
        cursor: "opaque",
        limit: "25",
        include_retired: "true",
        authority: "knowledge",
        kind: "page",
        lifecycle: "archived",
        types: "page,public,archived",
        entities: "person,organization",
      }),
    ).toEqual({
      query: "investment notes",
      options: {
        cursor: "opaque",
        limit: 25,
        include_retired: true,
        authority: "knowledge",
        object_kind: "page",
        lifecycle: "archived",
        catalog_types: ["page", "public", "archived"],
        entity_types: ["person", "organization"],
      },
    });
    expect(parseDashboardObjectCatalogQuery({ q: "" })).toEqual({
      query: null,
      options: {},
    });
    expect(() => parseDashboardObjectCatalogQuery({ limit: "101" })).toThrow();
    expect(() => parseDashboardObjectCatalogQuery({ types: "public,public" })).toThrow();
    expect(() => parseDashboardObjectCatalogQuery({ types: "public,private" })).toThrow();
    expect(() => parseDashboardObjectCatalogQuery({ entities: "person,person" })).toThrow();
    expect(() => parseDashboardObjectCatalogQuery({ entities: "project" })).toThrow();
    expect(() =>
      parseDashboardObjectCatalogQuery({ kind: "record", entities: "person" }),
    ).toThrow();
    expect(() =>
      parseDashboardObjectCatalogQuery({ types: "page,asset", entities: "person" }),
    ).toThrow();
    expect(() => parseDashboardObjectCatalogQuery({ extra: "private" })).toThrow();

    expect(
      parseDashboardObjectNeighborhoodQuery({
        revision_id: revisionId,
        outbound_cursor: linkedId,
        backlink_cursor: documentId,
        limit: "40",
      }),
    ).toEqual({
      requested_revision_id: revisionId,
      outbound_after_object_id: linkedId,
      backlink_after_object_id: documentId,
      outbound_limit: 40,
      backlink_limit: 40,
    });
    expect(() =>
      parseDashboardObjectNeighborhoodQuery({
        outbound_cursor: "not-a-uuid",
      }),
    ).toThrow();
  });

  test("projects titles and summaries without private locators", () => {
    const summary = dashboardObjectSummary(catalogItem);
    expect(summary).toEqual({
      object_id: documentId,
      object_kind: "page",
      authority: "knowledge",
      representation: "markdown",
      lifecycle: "active",
      current_revision_id: revisionId,
      entity_type: "organization",
      title: "Investment notes",
      summary: "A concise summary of the current investment thesis.",
      filename: null,
      content_type: null,
      integration: null,
      source_model: null,
      operational_roles: ["automation_instructions"],
      updated_at: "2026-08-23T10:00:00.000Z",
    });
    const encoded = JSON.stringify(summary);
    for (const forbidden of [
      "content_hash",
      "source_record_id",
      "connection_id",
      "public_id",
      "links_indexed_at",
    ]) {
      expect(encoded).not.toContain(forbidden);
    }

    expect(
      dashboardObjectCatalogPage({
        objects: [catalogItem],
        next_cursor: "next",
        has_more: true,
      }),
    ).toEqual({ objects: [summary], next_cursor: "next", has_more: true });
  });

  test("preserves graph completeness and unresolved target state without leaking evidence", () => {
    const neighborhood: PrivateObjectNeighborhood = {
      object: catalogItem,
      outbound: {
        revision_id: revisionId,
        neighbors: [{ target_object_id: linkedId, resolved: false, object: null }],
        next_cursor: null,
        has_more: false,
        index_complete: true,
      },
      backlinks: {
        objects: [catalogItem],
        next_cursor: null,
        has_more: false,
        completeness_checked: false,
        complete: null,
      },
    };
    const projected = dashboardObjectNeighborhood(neighborhood);
    expect(projected.outbound.neighbors).toEqual([
      {
        target_object_id: linkedId,
        resolved: false,
        object: null,
      },
    ]);
    expect(projected.backlinks.complete).toBeNull();
    expect(JSON.stringify(projected)).not.toContain("body_content_hash");
  });
});
