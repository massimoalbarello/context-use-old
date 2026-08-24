import { describe, expect, test } from "bun:test";
import type { KnowledgeDocument, KnowledgeDocumentRevision } from "@context-use/database";
import {
  dashboardKnowledgeDocument,
  dashboardKnowledgeRevision,
  dashboardKnowledgeRevisionDelta,
  dashboardPathlessRepublicationReview,
} from "./dashboard-knowledge-documents.ts";

const revision: KnowledgeDocumentRevision = {
  document_id: "11111111-1111-4111-8111-111111111111",
  revision_id: "22222222-2222-4222-8222-222222222222",
  revision_number: 2,
  title: "Hypermedia navigation",
  summary: "Navigation follows stable documents and their links.",
  body_markdown: "[Related](context-use://document/33333333-3333-4333-8333-333333333333)",
  commit_message: "Link related knowledge",
  actor_kind: "dashboard",
  actor_subject: "owner",
  created_at: "2026-08-23T12:00:00.000Z",
  link_contract: "generic_document_v1",
  contract_provenance: "authored",
  target_document_ids: ["33333333-3333-4333-8333-333333333333"],
};

describe("pathless dashboard knowledge responses", () => {
  test("projects document content without compatibility paths or object locators", () => {
    const document: KnowledgeDocument = {
      document_id: revision.document_id,
      current_revision_id: revision.revision_id,
      published_revision_id: null,
      public_id: null,
      revision_number: revision.revision_number,
      title: revision.title,
      summary: revision.summary,
      archived_at: null,
      legacy_published: false,
      current_link_contract: "generic_document_v1",
      pathless_search_ready: true,
      created_at: revision.created_at,
      updated_at: revision.created_at,
      body_markdown: revision.body_markdown,
    };
    const projected = dashboardKnowledgeDocument(document, "<p>Related</p>", {
      published_revision_id: revision.revision_id,
      published_revision_number: revision.revision_number,
      public_url: `https://example.test/p/${revision.document_id}`,
    });
    expect(projected).toMatchObject({
      id: document.document_id,
      current_version_id: document.current_revision_id,
      version_number: 2,
      rendered_html: "<p>Related</p>",
      published_version_number: 2,
      public_url: `https://example.test/p/${revision.document_id}`,
    });
    expect(projected).not.toHaveProperty("path");
    expect(projected).not.toHaveProperty("current_path");
    expect(projected).not.toHaveProperty("body_object_key");
    expect(projected).not.toHaveProperty("legacy_published");
    expect(projected).not.toHaveProperty("pathless_published");
  });

  test("projects revisions and computes title, summary and Markdown changes only", async () => {
    expect(dashboardKnowledgeRevision(revision)).toEqual({
      id: revision.revision_id,
      page_id: revision.document_id,
      version_number: revision.revision_number,
      title: revision.title,
      summary: revision.summary,
      body_markdown: revision.body_markdown,
      commit_message: revision.commit_message,
      actor_kind: revision.actor_kind,
      actor_subject: revision.actor_subject,
      created_at: revision.created_at,
    });
    const delta = await dashboardKnowledgeRevisionDelta({
      ...revision,
      revision_number: 1,
      revision_id: "44444444-4444-4444-8444-444444444444",
      title: "Filesystem navigation",
      summary: "Navigation follows folders.",
      body_markdown: "Old body",
    }, revision);
    expect(delta.metadata_changes.map(({ field }) => field)).toEqual(["title", "summary"]);
    expect(delta.markdown_changes).toEqual([{ before: "Old body", after: revision.body_markdown }]);
  });

  test("reviews every retained edit queued behind an exact public revision", async () => {
    const published = {
      ...revision,
      revision_id: "44444444-4444-4444-8444-444444444444",
      revision_number: 1,
      title: "Filesystem navigation",
      summary: "Navigation follows folders.",
      body_markdown: "Old body",
    };
    const review = await dashboardPathlessRepublicationReview(
      published,
      revision,
      [revision],
    );
    expect(review).toMatchObject({
      published_version_number: 1,
      queued_versions_complete: true,
      queued_versions: [{ version_number: 2, commit_message: revision.commit_message }],
    });
    expect(review.metadata_changes.map(({ field }) => field)).toEqual(["title", "summary"]);
  });
});
