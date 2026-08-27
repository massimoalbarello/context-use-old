import type { KnowledgePageRepository } from "@context-use/database";
import {
  dashboardPageRevision,
  dashboardPageRevisionDelta,
} from "#private/views/dashboard-page-view.ts";

export class PageHistoryService {
  constructor(private readonly pages: KnowledgePageRepository) {}

  async history({
    pageId,
    beforeRevisionNumber,
    limit,
  }: {
    pageId: string;
    beforeRevisionNumber?: number;
    limit: number;
  }) {
    const history = await this.pages.history(pageId, {
      ...(beforeRevisionNumber === undefined
        ? {}
        : { before_revision_number: beforeRevisionNumber }),
      limit,
    });
    return {
      revisions: history.revisions.map(dashboardPageRevision),
      has_more: history.has_more,
    };
  }

  async diff({
    pageId,
    revisionNumber,
    previousRevisionNumber,
  }: {
    pageId: string;
    revisionNumber: number;
    previousRevisionNumber: number | null;
  }) {
    if (previousRevisionNumber !== null && previousRevisionNumber >= revisionNumber) {
      return { state: "invalid_comparison" as const };
    }
    const [previous, current] = await Promise.all([
      previousRevisionNumber === null
        ? Promise.resolve(null)
        : this.pages.revision(pageId, previousRevisionNumber),
      this.pages.revision(pageId, revisionNumber),
    ]);
    if (!current) {
      return { state: "not_found" as const };
    }
    if (previousRevisionNumber !== null && !previous) {
      return { state: "comparison_not_found" as const };
    }
    return {
      state: "found" as const,
      diff: {
        page_id: pageId,
        comparison: {
          from_version: previousRevisionNumber,
          to_version: revisionNumber,
        },
        ...(await dashboardPageRevisionDelta(previous, current)),
      },
    };
  }

  recentChanges({ before, limit }: { before?: string; limit: number }) {
    return this.pages.recentChanges({ ...(before ? { before } : {}), limit });
  }
}
