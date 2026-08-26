import { describe, expect, test } from "bun:test";
import {
  archiveSourceRecordSchema,
  archiveAssetSchema,
  archivePageSchema,
  createAssetSchema,
  createPageSchema,
  dashboardObjectCatalogPageSchema,
  dashboardObjectNeighborhoodSchema,
  dashboardObjectSummarySchema,
  deleteSourceRecordSchema,
  PAGE_MARKDOWN_BODY_DESCRIPTION,
  updatePageSchema,
} from "./index.ts";

const pageId = "11111111-1111-4111-8111-111111111111";
const versionId = "22222222-2222-4222-8222-222222222222";

describe("strict mutation schemas", () => {
  test("describes the safe image and video formatting contract at the object boundary", () => {
    expect(createPageSchema.shape.body_markdown.description).toBe(PAGE_MARKDOWN_BODY_DESCRIPTION);
    expect(updatePageSchema.shape.body_markdown.description).toContain("layout=half");
    expect(updatePageSchema.shape.body_markdown.description).toContain("consecutive images or videos");
    expect(createPageSchema.shape.body_markdown.description).toContain("[Label](context-use://object/<uuid>)");
    expect(createPageSchema.shape.body_markdown.description).toContain("![Alt](context-use://object/<uuid>)");
    expect(createPageSchema.shape.body_markdown.description).not.toContain("context-use://page/");
    expect(createPageSchema.shape.body_markdown.description).not.toContain("context-use://asset/");
    expect(createPageSchema.shape.body_markdown.description).toContain("shape=auto|square|portrait|landscape");
    expect(createPageSchema.shape.body_markdown.description).toContain("Example: ![Portrait]");
  });

  test("asset uploads bind metadata to an exact checksum and size", () => {
    expect(createAssetSchema.safeParse({
      filename: "site-photo.jpg",
      content_type: "image/jpeg",
      size_bytes: 123,
      sha256: "a".repeat(64),
      width: 800,
      height: 600,
    }).success).toBe(true);
    expect(createAssetSchema.safeParse({
      filename: "site-photo.jpg",
      content_type: "image/jpeg",
      size_bytes: 123,
      sha256: "A".repeat(64),
    }).success).toBe(false);
  });

  test("asset archival accepts only a stable asset identifier", () => {
    expect(archiveAssetSchema.safeParse({ object_id: pageId }).success).toBe(true);
    expect(archiveAssetSchema.safeParse({
      object_id: pageId,
      unexpected_field: true,
    }).success).toBe(false);
  });

  test("source-record lifecycle binds destructive actions to an exact revision", () => {
    expect(archiveSourceRecordSchema.safeParse({
      object_id: pageId,
      expected_revision_id: versionId,
    }).success).toBe(true);
    expect(deleteSourceRecordSchema.safeParse({
      object_id: pageId,
      expected_revision_id: versionId,
      confirm: true,
    }).success).toBe(true);
    expect(deleteSourceRecordSchema.safeParse({
      object_id: pageId,
      expected_revision_id: versionId,
    }).success).toBe(false);
    expect(deleteSourceRecordSchema.safeParse({
      object_id: pageId,
      expected_revision_id: versionId,
      confirm: false,
    }).success).toBe(false);
  });

  test("knowledge page writes are canonical and reject publication fields", () => {
    expect(Object.keys(createPageSchema.shape).sort()).toEqual([
      "body_markdown", "commit_message", "entity_type", "summary", "title",
    ]);
    expect(Object.keys(updatePageSchema.shape).sort()).toEqual([
      "body_markdown", "commit_message", "entity_type", "expected_revision_number", "summary", "title",
    ]);
    expect(Object.keys(archivePageSchema.shape).sort()).toEqual([
      "commit_message", "expected_revision_number",
    ]);
    const create = {
      title: "Private note",
      summary: "A private knowledge document.",
      body_markdown: "Linked to [evidence](context-use://object/11111111-1111-4111-8111-111111111111).",
      commit_message: "Create private note",
    };
    expect(createPageSchema.parse(create)).toEqual(create);
    expect(createPageSchema.shape.summary.description).toContain("object search");
    expect(createPageSchema.shape.summary.description).not.toContain("directory");
    expect(updatePageSchema.shape.summary.description).not.toContain("directory");
    expect(createPageSchema.safeParse({ ...create, unexpected_field: true }).success)
      .toBe(false);
    expect(createPageSchema.safeParse({ ...create, summary: "first\nsecond" }).success)
      .toBe(false);
    expect(createPageSchema.parse({ ...create, entity_type: "person" }).entity_type)
      .toBe("person");
    expect(createPageSchema.safeParse({ ...create, entity_type: "project" }).success)
      .toBe(false);

    const update = { ...create, commit_message: "Update private note", expected_revision_number: 2 };
    expect(updatePageSchema.parse(update)).toEqual(update);
    expect(updatePageSchema.safeParse({ ...update, unexpected_field: true }).success)
      .toBe(false);
    expect(updatePageSchema.safeParse({ ...update, expected_revision_number: 0 }).success)
      .toBe(false);
    expect(updatePageSchema.parse({ ...update, entity_type: null }).entity_type).toBeNull();
    expect(updatePageSchema.safeParse({
      ...update,
      expected_revision_number: undefined,
      expected_version_number: 2,
    }).success).toBe(false);

    const archive = { commit_message: "Archive private note", expected_revision_number: 2 };
    expect(archivePageSchema.parse(archive)).toEqual(archive);
    expect(archivePageSchema.safeParse({ ...archive, unexpected_field: true }).success)
      .toBe(false);
  });

  test("asset writes accept only bounded canonical metadata", () => {
    expect(Object.keys(createAssetSchema.shape).sort()).toEqual([
      "content_type", "duration_seconds", "filename", "height", "sha256", "size_bytes", "width",
    ]);
    expect(Object.keys(archiveAssetSchema.shape)).toEqual(["object_id"]);
    const create = {
      filename: "site-photo.jpg",
      content_type: "image/jpeg",
      size_bytes: 123,
      sha256: "a".repeat(64),
      width: 800,
      height: 600,
      duration_seconds: 0,
    };
    expect(createAssetSchema.parse(create)).toEqual(create);
    expect(createAssetSchema.safeParse({ ...create, unexpected_field: true }).success)
      .toBe(false);
    expect(createAssetSchema.safeParse({ ...create, size_bytes: 5_000_000_001 }).success)
      .toBe(false);
    expect(createAssetSchema.safeParse({ ...create, sha256: "A".repeat(64) }).success)
      .toBe(false);
    expect(createAssetSchema.safeParse({ ...create, filename: "../site-photo.jpg" }).success)
      .toBe(false);
    expect(createAssetSchema.safeParse({ ...create, filename: "folder/site-photo.jpg" }).success)
      .toBe(false);
    expect(createAssetSchema.safeParse({ ...create, content_type: "image/jpeg\r\nX-Leak: 1" }).success)
      .toBe(false);

    expect(archiveAssetSchema.safeParse({ object_id: pageId }).success).toBe(true);
    expect(archiveAssetSchema.safeParse({
      object_id: pageId,
      unexpected_field: true,
    }).success).toBe(false);
  });

  test("dashboard object discovery is strict and locator-free", () => {
    const summary = {
      object_id: pageId,
      object_kind: "page" as const,
      authority: "knowledge" as const,
      representation: "markdown" as const,
      lifecycle: "active" as const,
      current_revision_id: versionId,
      entity_type: "person" as const,
      title: "Private note",
      summary: "A private knowledge document.",
      filename: null,
      content_type: null,
      integration: null,
      source_model: null,
      operational_roles: ["automation_instructions" as const],
      updated_at: "2026-08-23T12:34:56.789Z",
    };
    expect(dashboardObjectSummarySchema.parse(summary)).toEqual(summary);
    for (const forbidden of [
      "body_object_key",
      "body_content_hash",
      "source_record_id",
      "connection_id",
      "public_id",
    ]) {
      expect(dashboardObjectSummarySchema.safeParse({ ...summary, [forbidden]: "private" }).success)
        .toBe(false);
    }

    expect(dashboardObjectCatalogPageSchema.parse({
      objects: [summary],
      next_cursor: "opaque-cursor",
      has_more: true,
    }).objects[0]).toEqual(summary);
    expect(dashboardObjectNeighborhoodSchema.parse({
      object: summary,
      outbound: {
        revision_id: versionId,
        neighbors: [{ target_object_id: pageId, resolved: true, object: summary }],
        next_cursor: null,
        has_more: false,
        index_complete: true,
      },
      backlinks: {
        objects: [summary],
        next_cursor: null,
        has_more: false,
        completeness_checked: false,
        complete: null,
      },
    }).outbound.neighbors[0]?.object).toEqual(summary);
  });

});
