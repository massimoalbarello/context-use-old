import type { KnowledgePageRepository } from "@context-use/database";
import type { PublicationRepository } from "@context-use/database/publication";
import type { ArchivePageInput, CreatePageInput, UpdatePageInput } from "@context-use/shared";
import type { DashboardPrincipal } from "#private/auth/auth-engine.ts";
import type { DashboardPage } from "#private/views/dashboard-page-view.ts";
import { dashboardPage } from "#private/views/dashboard-page-view.ts";
import type { DashboardRenderingService } from "./rendering-service.ts";

type PageMutationResult =
  | { state: "found"; page: DashboardPage }
  | { state: "not_found" }
  | { state: "write_conflict" };

export class PageMutationsService {
  constructor(
    private readonly dependencies: {
      pages: KnowledgePageRepository;
      publications: PublicationRepository;
      rendering: DashboardRenderingService;
      appOrigin: string;
    },
  ) {}

  async get(pageId: string): Promise<DashboardPage | null> {
    const [page, publication] = await Promise.all([
      this.dependencies.pages.get(pageId),
      this.dependencies.publications.status({
        targetKind: "page",
        targetObjectId: pageId,
      }),
    ]);
    if (!page) {
      return null;
    }
    return dashboardPage(page, await this.dependencies.rendering.render(page.body_markdown), {
      published_revision_id: publication.active ? publication.published_revision_id : null,
      published_revision_number: publication.active ? publication.published_revision_number : null,
      public_url:
        publication.active && publication.public_id
          ? `${this.dependencies.appOrigin}/p/${publication.public_id}`
          : null,
    });
  }

  async create({
    input,
    principal,
  }: {
    input: CreatePageInput;
    principal: DashboardPrincipal;
  }): Promise<PageMutationResult> {
    const created = await this.dependencies.pages.create(input, {
      kind: "dashboard",
      subject: principal.userId,
    });
    const page = await this.get(created.object_id);
    return page ? { state: "found", page } : { state: "write_conflict" };
  }

  async update({
    pageId,
    input,
    principal,
  }: {
    pageId: string;
    input: UpdatePageInput;
    principal: DashboardPrincipal;
  }): Promise<PageMutationResult> {
    const updated = await this.dependencies.pages.update(pageId, input, {
      kind: "dashboard",
      subject: principal.userId,
    });
    if (!updated) {
      return { state: "not_found" };
    }
    const page = await this.get(pageId);
    return page ? { state: "found", page } : { state: "write_conflict" };
  }

  async archive({
    pageId,
    input,
    principal,
  }: {
    pageId: string;
    input: ArchivePageInput;
    principal: DashboardPrincipal;
  }): Promise<PageMutationResult> {
    const archived = await this.dependencies.pages.archive(pageId, input, {
      kind: "dashboard",
      subject: principal.userId,
    });
    if (!archived) {
      return { state: "not_found" };
    }
    const page = await this.get(pageId);
    return page ? { state: "found", page } : { state: "write_conflict" };
  }
}
