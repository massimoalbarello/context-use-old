import type {
  KnowledgeDocument,
  KnowledgeDocumentRevision,
} from "@context-use/database";
import { markdownChanges } from "./page-delta.ts";

export type DashboardKnowledgeDocument = {
  id: string;
  current_version_id: string;
  published_version_id: string | null;
  public_id: string | null;
  archived_at: Date | string | null;
  version_number: number;
  title: string;
  summary: string;
  body_markdown: string;
  rendered_html: string;
  legacy_published: boolean;
  legacy_publication_eligible: boolean;
  created_at: Date | string;
  updated_at: Date | string;
};

export type DashboardKnowledgeRevision = {
  id: string;
  page_id: string;
  version_number: number;
  title: string;
  summary: string;
  body_markdown: string;
  commit_message: string;
  actor_kind: "dashboard" | "mcp";
  actor_subject: string;
  created_at: Date | string;
};

export function dashboardKnowledgeDocument(
  document: KnowledgeDocument,
  renderedHtml: string,
  options: { legacy_publication_eligible: boolean },
): DashboardKnowledgeDocument {
  return {
    id: document.document_id,
    current_version_id: document.current_revision_id,
    published_version_id: document.published_revision_id,
    public_id: document.public_id,
    archived_at: document.archived_at,
    version_number: document.revision_number,
    title: document.title,
    summary: document.summary,
    body_markdown: document.body_markdown,
    rendered_html: renderedHtml,
    legacy_published: document.legacy_published,
    legacy_publication_eligible: options.legacy_publication_eligible,
    created_at: document.created_at,
    updated_at: document.updated_at,
  };
}

export function dashboardKnowledgeRevision(
  revision: KnowledgeDocumentRevision,
): DashboardKnowledgeRevision {
  return {
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
  };
}

export async function dashboardKnowledgeRevisionDelta(
  previous: KnowledgeDocumentRevision | null,
  current: KnowledgeDocumentRevision,
) {
  const metadataChanges: Array<{
    field: "title" | "summary";
    before: string | null;
    after: string;
  }> = [];
  for (const field of ["title", "summary"] as const) {
    const before = previous?.[field] ?? null;
    if (before !== current[field]) metadataChanges.push({ field, before, after: current[field] });
  }
  return {
    metadata_changes: metadataChanges,
    markdown_changes: await markdownChanges(
      previous?.body_markdown ?? "",
      current.body_markdown,
    ),
  };
}
