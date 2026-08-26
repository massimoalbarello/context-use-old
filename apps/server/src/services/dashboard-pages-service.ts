import {
  extractObjectLinks,
  type KnowledgePageRepository,
  normalizeLegacyObjectLinks,
  type PageDeletionRepository,
  type PrivateObjectCatalogRepository,
} from "@context-use/database";
import type { PublicationRepository } from "@context-use/database/publication";
import type { ArchivePageInput, CreatePageInput, UpdatePageInput } from "@context-use/shared";
import type { DashboardPrincipal } from "../auth-client.ts";
import type { issueConfirmationOptions } from "../confirmation-client.ts";
import {
  dashboardPage,
  dashboardPageRevision,
  dashboardPageRevisionDelta,
  dashboardRepublicationReview,
} from "../dashboard-pages.ts";
import { publicationWarnings, renderMarkdown } from "../markdown.ts";
import type { DashboardRenderingService } from "./dashboard-rendering-service.ts";

type PreviewTarget = {
  kind: "page" | "asset" | "record" | "object";
  id: string;
  label: string;
  public: boolean;
  href: string | null;
  contentType: string | null;
};

type PageMutationResult =
  | { state: "found"; page: NonNullable<Awaited<ReturnType<DashboardPagesService["get"]>>> }
  | { state: "not_found" }
  | { state: "write_conflict" };

export class DashboardPagesService {
  constructor(
    private readonly dependencies: {
      pages: KnowledgePageRepository;
      pageDeletions: PageDeletionRepository;
      publications: PublicationRepository;
      objects: PrivateObjectCatalogRepository;
      rendering: DashboardRenderingService;
      issueConfirmation: typeof issueConfirmationOptions;
      appOrigin: string;
      assetOrigin: string;
    },
  ) {}

  async get(pageId: string) {
    const [page, publication] = await Promise.all([
      this.dependencies.pages.get(pageId),
      this.dependencies.publications.status({ targetKind: "page", targetObjectId: pageId }),
    ]);
    if (!page) {
      return null;
    }
    const renderedHtml = await this.dependencies.rendering.render(page.body_markdown);
    return dashboardPage(page, renderedHtml, {
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

  async publicationPreview(pageId: string) {
    const [page, status] = await Promise.all([
      this.dependencies.pages.get(pageId),
      this.dependencies.publications.status({ targetKind: "page", targetObjectId: pageId }),
    ]);
    if (!page || page.archived_at) {
      return { state: "not_found" as const };
    }
    const preview = this.publicationPreviewTargets({ id: pageId, title: page.title });
    const renderedHtml = await renderMarkdown(page.body_markdown, preview.markdownResolvers);
    const references = await Promise.all(
      extractObjectLinks(normalizeLegacyObjectLinks(page.body_markdown)).map(preview.resolveTarget),
    );
    let republication = null;
    if (status.active && status.published_revision_number !== null) {
      const [published, candidate, history] = await Promise.all([
        this.dependencies.pages.revision(pageId, status.published_revision_number),
        this.dependencies.pages.revision(pageId, page.revision_number),
        this.dependencies.pages.history(pageId, { limit: 100 }),
      ]);
      if (!published || !candidate) {
        return { state: "publication_state_invalid" as const };
      }
      republication = await dashboardRepublicationReview(published, candidate, history.revisions);
    }
    return {
      state: "found" as const,
      preview: {
        page_id: page.object_id,
        version_id: page.current_revision_id,
        version_number: page.revision_number,
        title: page.title,
        summary: page.summary,
        rendered_html: renderedHtml,
        current_public_url:
          status.active && status.public_id
            ? `${this.dependencies.appOrigin}/p/${status.public_id}`
            : null,
        warnings: publicationWarnings(page.body_markdown, [page.title, page.summary]),
        references: references.map(
          ({ contentType: _contentType, href: publicUrl, ...reference }) => ({
            ...reference,
            public_url: publicUrl === "#" ? null : publicUrl,
          }),
        ),
        republication,
      },
    };
  }

  async createDeletionIntent({
    pageId,
    principal,
  }: {
    pageId: string;
    principal: DashboardPrincipal;
  }) {
    const [page, publication] = await Promise.all([
      this.dependencies.pages.get(pageId),
      this.dependencies.publications.status({ targetKind: "page", targetObjectId: pageId }),
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
    const authenticationOptions = await this.dependencies.issueConfirmation(
      "page_deletion",
      intent.id,
    );
    return {
      state: "created" as const,
      intent,
      authentication_options: authenticationOptions,
    };
  }

  async history({
    pageId,
    beforeRevisionNumber,
    limit,
  }: {
    pageId: string;
    beforeRevisionNumber?: number;
    limit: number;
  }) {
    const history = await this.dependencies.pages.history(pageId, {
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
        : this.dependencies.pages.revision(pageId, previousRevisionNumber),
      this.dependencies.pages.revision(pageId, revisionNumber),
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
        comparison: { from_version: previousRevisionNumber, to_version: revisionNumber },
        ...(await dashboardPageRevisionDelta(previous, current)),
      },
    };
  }

  recentChanges({ before, limit }: { before?: string; limit: number }) {
    return this.dependencies.pages.recentChanges({ ...(before ? { before } : {}), limit });
  }

  private publicationPreviewTargets(publishingPage: { id: string; title: string }) {
    const cache = new Map<string, Promise<PreviewTarget>>();
    const resolveTarget = (objectId: string): Promise<PreviewTarget> => {
      const cached = cache.get(objectId);
      if (cached) {
        return cached;
      }
      const pending = this.resolvePublicationPreviewTarget({ objectId, publishingPage });
      cache.set(objectId, pending);
      return pending;
    };
    return {
      resolveTarget,
      markdownResolvers: {
        object: async (objectId: string) => {
          const target = await resolveTarget(objectId);
          if (!target.public || !target.href) {
            return { available: false as const };
          }
          return target.kind === "asset"
            ? {
                available: true as const,
                representation: "asset" as const,
                href: target.href,
                contentType: target.contentType ?? "application/octet-stream",
              }
            : {
                available: true as const,
                representation: "page" as const,
                href: target.href,
              };
        },
      },
    };
  }

  private async resolvePublicationPreviewTarget({
    objectId,
    publishingPage,
  }: {
    objectId: string;
    publishingPage: { id: string; title: string };
  }): Promise<PreviewTarget> {
    if (objectId === publishingPage.id) {
      return {
        kind: "page",
        id: objectId,
        label: publishingPage.title,
        public: true,
        href: "#",
        contentType: null,
      };
    }
    const object = await this.dependencies.objects.get(objectId);
    if (object?.lifecycle !== "active") {
      return {
        kind: "object",
        id: objectId,
        label: "Missing object",
        public: false,
        href: null,
        contentType: null,
      };
    }
    if (object.object_kind === "asset") {
      const status = await this.dependencies.publications.status({
        targetKind: "asset",
        targetObjectId: objectId,
      });
      return {
        kind: "asset",
        id: objectId,
        label: object.filename ?? "Asset",
        public: status.active,
        href:
          status.active && status.public_id
            ? `${this.dependencies.assetOrigin}/a/${status.public_id}`
            : null,
        contentType: object.content_type,
      };
    }
    if (object.object_kind === "page") {
      const status = await this.dependencies.publications.status({
        targetKind: "page",
        targetObjectId: objectId,
      });
      return {
        kind: "page",
        id: objectId,
        label: object.title ?? "Page",
        public: status.active,
        href: status.active && status.public_id ? `/p/${status.public_id}` : null,
        contentType: null,
      };
    }
    return {
      kind: "record",
      id: objectId,
      label: object.title ?? "Source record",
      public: false,
      href: null,
      contentType: null,
    };
  }
}
