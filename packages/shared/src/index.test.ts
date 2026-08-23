import { describe, expect, test } from "bun:test";
import {
  archiveDocumentAssetSchema,
  archiveKnowledgeDocumentSchema,
  createDocumentAssetSchema,
  createDirectorySchema,
  createKnowledgeDocumentSchema,
  dashboardDocumentCatalogPageSchema,
  dashboardDocumentNeighborhoodSchema,
  dashboardDocumentSummarySchema,
  deleteDirectorySchema,
  createPageSchema,
  PAGE_MARKDOWN_BODY_DESCRIPTION,
  summarizeTemplateResult,
  updateKnowledgeDocumentSchema,
  updatePageSchema,
} from "./index.ts";

const pageId = "11111111-1111-4111-8111-111111111111";
const versionId = "22222222-2222-4222-8222-222222222222";

describe("strict mutation schemas", () => {
  test("describes the safe image and video formatting contract at the page authoring boundary", () => {
    expect(createPageSchema.shape.body_markdown.description).toBe(PAGE_MARKDOWN_BODY_DESCRIPTION);
    expect(updatePageSchema.shape.body_markdown.description).toContain("layout=half");
    expect(updatePageSchema.shape.body_markdown.description).toContain("consecutive images or videos");
    expect(createPageSchema.shape.body_markdown.description).toContain("[Label](context-use://document/<uuid>)");
    expect(createPageSchema.shape.body_markdown.description).toContain("![Alt](context-use://document/<uuid>)");
    expect(createPageSchema.shape.body_markdown.description).not.toContain("context-use://page/");
    expect(createPageSchema.shape.body_markdown.description).not.toContain("context-use://asset/");
    expect(createPageSchema.shape.body_markdown.description).toContain("shape=auto|square|portrait|landscape");
    expect(createPageSchema.shape.body_markdown.description).toContain("Example: ![Portrait]");
  });

  test("document asset uploads bind metadata to an exact checksum and size", () => {
    expect(createDocumentAssetSchema.safeParse({
      filename: "site-photo.jpg",
      content_type: "image/jpeg",
      size_bytes: 123,
      sha256: "a".repeat(64),
      width: 800,
      height: 600,
    }).success).toBe(true);
    expect(createDocumentAssetSchema.safeParse({
      filename: "site-photo.jpg",
      content_type: "image/jpeg",
      size_bytes: 123,
      sha256: "A".repeat(64),
      public_path: "projects/acme/site-photo",
    }).success).toBe(false);
  });

  test("asset archival accepts only a stable asset identifier", () => {
    expect(archiveDocumentAssetSchema.safeParse({ asset_id: pageId }).success).toBe(true);
    expect(archiveDocumentAssetSchema.safeParse({
      asset_id: pageId,
      path: "projects/acme/site-photo",
    }).success).toBe(false);
  });

  test("ordinary page writes reject publication fields", () => {
    expect(createPageSchema.safeParse({
      path: "private/page", title: "Private", summary: "A private page.", body_markdown: "Body", commit_message: "Create page", public_path: "leak",
    }).success).toBe(false);
    expect(updatePageSchema.safeParse({
      path: "private/page", title: "Private", summary: "A private page.", body_markdown: "Body", commit_message: "Update page",
      expected_version_number: 1, published_version_id: versionId,
    }).success).toBe(false);
  });

  test("pathless knowledge document writes reuse page constraints without accepting paths", () => {
    expect(Object.keys(createKnowledgeDocumentSchema.shape).sort()).toEqual([
      "body_markdown", "commit_message", "summary", "title",
    ]);
    expect(Object.keys(updateKnowledgeDocumentSchema.shape).sort()).toEqual([
      "body_markdown", "commit_message", "expected_revision_number", "summary", "title",
    ]);
    expect(Object.keys(archiveKnowledgeDocumentSchema.shape).sort()).toEqual([
      "commit_message", "expected_revision_number",
    ]);
    const create = {
      title: "Private note",
      summary: "A private knowledge document.",
      body_markdown: "Linked to [evidence](context-use://document/11111111-1111-4111-8111-111111111111).",
      commit_message: "Create private note",
    };
    expect(createKnowledgeDocumentSchema.parse(create)).toEqual(create);
    expect(createKnowledgeDocumentSchema.shape.summary.description).toContain("document search");
    expect(createKnowledgeDocumentSchema.shape.summary.description).not.toContain("directory");
    expect(updateKnowledgeDocumentSchema.shape.summary.description).not.toContain("directory");
    expect(createKnowledgeDocumentSchema.safeParse({ ...create, path: "private/note" }).success)
      .toBe(false);
    expect(createKnowledgeDocumentSchema.safeParse({ ...create, summary: "first\nsecond" }).success)
      .toBe(false);

    const update = { ...create, commit_message: "Update private note", expected_revision_number: 2 };
    expect(updateKnowledgeDocumentSchema.parse(update)).toEqual(update);
    expect(updateKnowledgeDocumentSchema.safeParse({ ...update, path: "private/note" }).success)
      .toBe(false);
    expect(updateKnowledgeDocumentSchema.safeParse({ ...update, expected_revision_number: 0 }).success)
      .toBe(false);
    expect(updateKnowledgeDocumentSchema.safeParse({
      ...update,
      expected_revision_number: undefined,
      expected_version_number: 2,
    }).success).toBe(false);

    const archive = { commit_message: "Archive private note", expected_revision_number: 2 };
    expect(archiveKnowledgeDocumentSchema.parse(archive)).toEqual(archive);
    expect(archiveKnowledgeDocumentSchema.safeParse({ ...archive, path: "private/note" }).success)
      .toBe(false);
  });

  test("pathless document asset writes reuse bounded metadata without accepting paths", () => {
    expect(Object.keys(createDocumentAssetSchema.shape).sort()).toEqual([
      "content_type", "duration_seconds", "filename", "height", "sha256", "size_bytes", "width",
    ]);
    expect(Object.keys(archiveDocumentAssetSchema.shape)).toEqual(["asset_id"]);
    const create = {
      filename: "site-photo.jpg",
      content_type: "image/jpeg",
      size_bytes: 123,
      sha256: "a".repeat(64),
      width: 800,
      height: 600,
      duration_seconds: 0,
    };
    expect(createDocumentAssetSchema.parse(create)).toEqual(create);
    expect(createDocumentAssetSchema.safeParse({ ...create, path: "projects/acme/site-photo" }).success)
      .toBe(false);
    expect(createDocumentAssetSchema.safeParse({ ...create, size_bytes: 5_000_000_001 }).success)
      .toBe(false);
    expect(createDocumentAssetSchema.safeParse({ ...create, sha256: "A".repeat(64) }).success)
      .toBe(false);
    expect(createDocumentAssetSchema.safeParse({ ...create, filename: "../site-photo.jpg" }).success)
      .toBe(false);
    expect(createDocumentAssetSchema.safeParse({ ...create, filename: "folder/site-photo.jpg" }).success)
      .toBe(false);
    expect(createDocumentAssetSchema.safeParse({ ...create, content_type: "image/jpeg\r\nX-Leak: 1" }).success)
      .toBe(false);

    expect(archiveDocumentAssetSchema.safeParse({ asset_id: pageId }).success).toBe(true);
    expect(archiveDocumentAssetSchema.safeParse({
      asset_id: pageId,
      path: "projects/acme/site-photo",
    }).success).toBe(false);
  });

  test("dashboard document discovery is strict and locator-free", () => {
    const summary = {
      document_id: pageId,
      document_kind: "knowledge" as const,
      authority: "knowledge" as const,
      representation: "markdown" as const,
      lifecycle: "active" as const,
      current_revision_id: versionId,
      title: "Private note",
      summary: "A private knowledge document.",
      filename: null,
      content_type: null,
      operational_roles: ["directory_hub" as const],
      updated_at: "2026-08-23T12:34:56.789Z",
    };
    expect(dashboardDocumentSummarySchema.parse(summary)).toEqual(summary);
    for (const forbidden of [
      "current_path",
      "body_object_key",
      "body_content_hash",
      "source_record_id",
      "connection_id",
      "public_id",
    ]) {
      expect(dashboardDocumentSummarySchema.safeParse({ ...summary, [forbidden]: "private" }).success)
        .toBe(false);
    }

    expect(dashboardDocumentCatalogPageSchema.parse({
      documents: [summary],
      next_cursor: "opaque-cursor",
      has_more: true,
    }).documents[0]).toEqual(summary);
    expect(dashboardDocumentNeighborhoodSchema.parse({
      document: summary,
      outbound: {
        revision_id: versionId,
        neighbors: [{ target_document_id: pageId, resolved: true, document: summary }],
        next_cursor: null,
        has_more: false,
        index_complete: true,
      },
      backlinks: {
        documents: [summary],
        next_cursor: null,
        has_more: false,
        completeness_checked: false,
        complete: null,
      },
    }).outbound.neighbors[0]?.document).toEqual(summary);
  });

  test("pages require summaries while directory public-listing summaries are optional", () => {
    expect(createPageSchema.safeParse({
      path: "notes/example", title: "Example", body_markdown: "Body", commit_message: "Create example",
    }).success).toBe(false);
    expect(createPageSchema.safeParse({
      path: "notes/example", title: "Example", summary: "First line.\nSecond line.", body_markdown: "Body", commit_message: "Create example",
    }).success).toBe(false);
    expect(createDirectorySchema.safeParse({
      path: "notes", title: "Notes", summary: "Focused notes and observations.",
    }).success).toBe(true);
    expect(createDirectorySchema.parse({
      path: "empty-notes", title: "Empty notes",
    }).summary).toBe("");
    expect(createDirectorySchema.safeParse({
      path: "notes", title: "Notes", intro_markdown: "Not directory metadata.",
    }).success).toBe(false);
    expect(createDirectorySchema.safeParse({
      path: "notes", title: "Notes", summary: "First line.\nSecond line.",
    }).success).toBe(false);
  });

  test("ordinary page writes reserve about as a folder", () => {
    expect(createPageSchema.safeParse({
      path: "about",
      title: "About",
      summary: "An invalid page at a directory path.",
      body_markdown: "",
      commit_message: "Create about page",
    }).success).toBe(false);
    expect(createPageSchema.safeParse({
      path: "about/intro",
      title: "Intro",
      summary: "A concise introduction to the owner.",
      body_markdown: "",
      commit_message: "Create intro page",
    }).success).toBe(true);
  });

  test("directory deletion is bound to the version the caller inspected", () => {
    expect(deleteDirectorySchema.safeParse({ expected_version_number: 3 }).success).toBe(true);
    expect(deleteDirectorySchema.safeParse({}).success).toBe(false);
    expect(deleteDirectorySchema.safeParse({ expected_version_number: 3, cascade: true }).success).toBe(false);
  });

});

describe("knowledge template results", () => {
  test("summarizes shared CLI and dashboard actions from structural replacement metadata", () => {
    expect(summarizeTemplateResult({
      template: "default",
      applied: false,
      actions: [
        { action: "create-directory", path: "topics", detail: "Create Topics" },
        { action: "replace-guide", path: "agents", detail: "Replace the guide", replaces_local: true },
        { action: "conflict", path: "people/agents", detail: "Preserve archived guide" },
        { action: "unchanged", path: "about/agents", detail: "Already current" },
      ],
    })).toEqual({ changes: 2, conflicts: 1, unchanged: 1, replacements: 1 });
  });
});
