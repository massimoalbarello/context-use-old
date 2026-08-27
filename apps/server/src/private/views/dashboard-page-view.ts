import type { KnowledgePage, PageRevision } from "@context-use/database";
import type { PageEntityType } from "@context-use/shared";
import { markdownChanges } from "#private/services/dashboard/page-delta.ts";

export type DashboardPage = {
  id: string;
  current_version_id: string;
  published_version_id: string | null;
  published_version_number: number | null;
  public_id: string | null;
  archived_at: Date | string | null;
  version_number: number;
  entity_type: PageEntityType | null;
  title: string;
  summary: string;
  body_markdown: string;
  rendered_html: string;
  public_url: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

export type DashboardPageRevision = {
  id: string;
  page_id: string;
  version_number: number;
  entity_type: PageEntityType | null;
  title: string;
  summary: string;
  body_markdown: string;
  commit_message: string;
  actor_kind: "dashboard" | "mcp";
  actor_subject: string;
  created_at: Date | string;
};

export type DashboardRepublicationReview = {
  published_version_number: number;
  metadata_changes: Array<{
    field: "title" | "summary" | "entity_type";
    before: string | null;
    after: string | null;
  }>;
  markdown_changes: Array<{ before: string; after: string }>;
  queued_versions: Array<{
    version_number: number;
    commit_message: string;
    actor_kind: "dashboard" | "mcp";
    actor_subject: string;
    created_at: Date | string;
  }>;
  queued_versions_complete: boolean;
};

export function dashboardPage(
  page: KnowledgePage,
  renderedHtml: string,
  options: {
    published_revision_id: string | null;
    published_revision_number: number | null;
    public_url: string | null;
  },
): DashboardPage {
  return {
    id: page.object_id,
    current_version_id: page.current_revision_id,
    published_version_id: options.published_revision_id,
    published_version_number: options.published_revision_number,
    public_id: page.public_id,
    archived_at: page.archived_at,
    version_number: page.revision_number,
    entity_type: page.entity_type,
    title: page.title,
    summary: page.summary,
    body_markdown: page.body_markdown,
    rendered_html: renderedHtml,
    public_url: options.public_url,
    created_at: page.created_at,
    updated_at: page.updated_at,
  };
}

export function dashboardPageRevision(revision: PageRevision): DashboardPageRevision {
  return {
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
  };
}

export async function dashboardPageRevisionDelta(
  previous: PageRevision | null,
  current: PageRevision,
) {
  const metadataChanges: Array<{
    field: "title" | "summary" | "entity_type";
    before: string | null;
    after: string | null;
  }> = [];
  for (const field of ["title", "summary", "entity_type"] as const) {
    const before = previous?.[field] ?? null;
    if (before !== current[field]) {
      metadataChanges.push({ field, before, after: current[field] });
    }
  }
  return {
    metadata_changes: metadataChanges,
    markdown_changes: await markdownChanges(previous?.body_markdown ?? "", current.body_markdown),
  };
}

export async function dashboardRepublicationReview(
  published: PageRevision,
  candidate: PageRevision,
  retainedHistory: PageRevision[],
): Promise<DashboardRepublicationReview> {
  const queued = retainedHistory
    .filter(
      (revision) =>
        revision.revision_number > published.revision_number &&
        revision.revision_number <= candidate.revision_number,
    )
    .sort((left, right) => left.revision_number - right.revision_number);
  return {
    published_version_number: published.revision_number,
    ...(await dashboardPageRevisionDelta(published, candidate)),
    queued_versions: queued.map((revision) => ({
      version_number: revision.revision_number,
      commit_message: revision.commit_message,
      actor_kind: revision.actor_kind,
      actor_subject: revision.actor_subject,
      created_at: revision.created_at,
    })),
    queued_versions_complete:
      queued.length === Math.max(candidate.revision_number - published.revision_number, 0),
  };
}
