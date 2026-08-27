import type { KnowledgePageRepository, PageDeletionRepository } from "@context-use/database";
import type { PublicationRepository } from "@context-use/database/publication";
import type { DashboardPrincipal } from "#private/auth/auth-engine.ts";

export class PageDeletionService {
  constructor(
    private readonly dependencies: {
      pages: KnowledgePageRepository;
      pageDeletions: PageDeletionRepository;
      publications: PublicationRepository;
      issueConfirmation: (input: {
        kind: "publication" | "page_deletion";
        intentId: string;
      }) => Promise<unknown>;
    },
  ) {}

  async createIntent({ pageId, principal }: { pageId: string; principal: DashboardPrincipal }) {
    const [page, publication] = await Promise.all([
      this.dependencies.pages.get(pageId),
      this.dependencies.publications.status({
        targetKind: "page",
        targetObjectId: pageId,
      }),
    ]);
    if (!page) {
      return { state: "not_found" as const };
    }
    if (!page.archived_at || publication.active) {
      return { state: "not_deletable" as const };
    }
    const intent = await this.dependencies.pageDeletions.createIntent(pageId, {
      ownerUserId: principal.userId,
      sessionId: principal.sessionId,
    });
    if (!intent) {
      return { state: "not_deletable" as const };
    }
    return {
      state: "created" as const,
      intent,
      authentication_options: await this.dependencies.issueConfirmation({
        kind: "page_deletion",
        intentId: intent.id,
      }),
    };
  }
}
