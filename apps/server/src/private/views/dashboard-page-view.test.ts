import { describe, expect, test } from "bun:test";
import type { KnowledgePage, PageRevision } from "@context-use/database";
import {
  dashboardPage,
  dashboardPageRevision,
  dashboardPageRevisionDelta,
  dashboardRepublicationReview,
} from "#private/views/dashboard-page-view.ts";

const revision: PageRevision = {
  object_id: "11111111-1111-4111-8111-111111111111",
  revision_id: "22222222-2222-4222-8222-222222222222",
  revision_number: 2,
  entity_type: "thing",
  title: "Hypermedia navigation",
  summary: "Navigation follows stable documents and their links.",
  body_markdown: "[Related](context-use://object/33333333-3333-4333-8333-333333333333)",
  commit_message: "Link related knowledge",
  actor_kind: "dashboard",
  actor_subject: "owner",
  created_at: "2026-08-23T12:00:00.000Z",
  link_contract: "generic_document_v1",
  contract_provenance: "authored",
  target_object_ids: ["33333333-3333-4333-8333-333333333333"],
};

describe("canonical dashboard knowledge responses", () => {
  test("projects page content without private object locators", () => {
    const document: KnowledgePage = {
      object_id: revision.object_id,
      current_revision_id: revision.revision_id,
      public_id: null,
      revision_number: revision.revision_number,
      entity_type: revision.entity_type,
      title: revision.title,
      summary: revision.summary,
      archived_at: null,
      current_link_contract: "generic_document_v1",
      search_ready: true,
      created_at: revision.created_at,
      updated_at: revision.created_at,
      body_markdown: revision.body_markdown,
    };
    const projected = dashboardPage(document, "<p>Related</p>", {
      published_revision_id: revision.revision_id,
      published_revision_number: revision.revision_number,
      public_url: `https://example.test/p/${revision.object_id}`,
    });
    expect(projected).toMatchObject({
      id: document.object_id,
      current_version_id: document.current_revision_id,
      version_number: 2,
      rendered_html: "<p>Related</p>",
      published_version_number: 2,
      public_url: `https://example.test/p/${revision.object_id}`,
    });
    expect(projected).not.toHaveProperty("body_object_key");
    expect(projected).not.toHaveProperty("canonical_published");
  });

  test("projects revisions and computes page-detail and Markdown changes", async () => {
    expect(dashboardPageRevision(revision)).toEqual({
      id: revision.revision_id,
      page_id: revision.object_id,
      version_number: revision.revision_number,
      entity_type: revision.entity_type,
      title: revision.title,
      summary: revision.summary,
      body_markdown: revision.body_markdown,
      commit_message: revision.commit_message,
      actor_kind: revision.actor_kind,
      actor_subject: revision.actor_subject,
      created_at: revision.created_at,
    });
    const delta = await dashboardPageRevisionDelta(
      {
        ...revision,
        revision_number: 1,
        revision_id: "44444444-4444-4444-8444-444444444444",
        entity_type: null,
        title: "Previous navigation",
        summary: "Navigation used an older structure.",
        body_markdown: "Old body",
      },
      revision,
    );
    expect(delta.metadata_changes.map(({ field }) => field)).toEqual([
      "title",
      "summary",
      "entity_type",
    ]);
    expect(delta.markdown_changes).toEqual([{ before: "Old body", after: revision.body_markdown }]);
  });

  test("reviews every retained edit queued behind an exact public revision", async () => {
    const published = {
      ...revision,
      revision_id: "44444444-4444-4444-8444-444444444444",
      revision_number: 1,
      title: "Previous navigation",
      summary: "Navigation used an older structure.",
      body_markdown: "Old body",
    };
    const review = await dashboardRepublicationReview(published, revision, [revision]);
    expect(review).toMatchObject({
      published_version_number: 1,
      queued_versions_complete: true,
      queued_versions: [{ version_number: 2, commit_message: revision.commit_message }],
    });
    expect(review.metadata_changes.map(({ field }) => field)).toEqual(["title", "summary"]);
  });
});
