import {
  extractObjectLinks,
  type KnowledgePageRepository,
  normalizeLegacyObjectLinks,
  type PrivateObjectCatalogRepository,
} from "@context-use/database";
import type { PublicationRepository } from "@context-use/database/publication";
import type { MarkdownRenderer } from "#markdown/renderer.ts";
import { dashboardRepublicationReview } from "#private/views/dashboard-page-view.ts";

type PreviewTarget = {
  kind: "page" | "asset" | "record" | "object";
  id: string;
  label: string;
  public: boolean;
  href: string | null;
  contentType: string | null;
};

export class PagePublicationPreviewService {
  constructor(
    private readonly dependencies: {
      pages: KnowledgePageRepository;
      publications: PublicationRepository;
      objects: PrivateObjectCatalogRepository;
      markdown: MarkdownRenderer;
      appOrigin: string;
      assetOrigin: string;
    },
  ) {}

  async preview(pageId: string) {
    const [page, status] = await Promise.all([
      this.dependencies.pages.get(pageId),
      this.dependencies.publications.status({
        targetKind: "page",
        targetObjectId: pageId,
      }),
    ]);
    if (!page || page.archived_at) {
      return { state: "not_found" as const };
    }

    const targets = this.previewTargets({ id: pageId, title: page.title });
    const renderedHtml = await this.dependencies.markdown.render(
      page.body_markdown,
      targets.markdownResolvers,
    );
    const references = await Promise.all(
      extractObjectLinks(normalizeLegacyObjectLinks(page.body_markdown)).map(targets.resolveTarget),
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
        warnings: this.dependencies.markdown.publicationWarnings(page.body_markdown, [
          page.title,
          page.summary,
        ]),
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

  private previewTargets(publishingPage: { id: string; title: string }) {
    const cache = new Map<string, Promise<PreviewTarget>>();
    const resolveTarget = (objectId: string): Promise<PreviewTarget> => {
      const cached = cache.get(objectId);
      if (cached) {
        return cached;
      }
      const pending = this.resolveTarget({ objectId, publishingPage });
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

  private async resolveTarget({
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
