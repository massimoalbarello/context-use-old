import { mapConcurrently } from "@context-use/database";
import type { PublicRepository } from "@context-use/database/publication";
import type { PublicPageContent } from "#public/models/page-content.ts";
import { renderRobotsTxt, renderSitemapXml } from "#public/views/discovery-view.ts";
import { renderLlmsFullTxt, renderLlmsTxt } from "#public/views/llms-view.ts";
import type { PublicStorageBroker } from "#storage/client/contracts.ts";

export class PublicDiscoveryService {
  constructor(
    private readonly dependencies: {
      pages: Pick<PublicRepository, "entrypoint" | "pages">;
      storage: Pick<PublicStorageBroker, "readPublishedRepresentationText">;
      siteOrigin: string;
      assetOrigin: string;
      securityHeaders: Record<string, string>;
    },
  ) {}

  robots(): Response {
    return new Response(renderRobotsTxt(this.dependencies.siteOrigin), {
      headers: this.textHeaders,
    });
  }

  async sitemap(): Promise<Response> {
    return new Response(
      renderSitemapXml(await this.canonicalPages(false), this.dependencies.siteOrigin),
      {
        headers: {
          ...this.dependencies.securityHeaders,
          "content-type": "application/xml; charset=utf-8",
        },
      },
    );
  }

  async llms(full: boolean): Promise<Response> {
    const entrypoint = await this.dependencies.pages.entrypoint();
    const pages = await this.canonicalPages(full);
    const options = {
      siteOrigin: this.dependencies.siteOrigin,
      assetOrigin: this.dependencies.assetOrigin,
      entrypointPublicPath:
        entrypoint.state === "active" && entrypoint.route_kind !== "asset"
          ? entrypoint.public_id
          : null,
    };
    return new Response(full ? renderLlmsFullTxt(pages, options) : renderLlmsTxt(pages, options), {
      headers: full ? { ...this.textHeaders, "x-robots-tag": "noindex, follow" } : this.textHeaders,
    });
  }

  private async canonicalPages(full: boolean): Promise<PublicPageContent[]> {
    const pages = await this.dependencies.pages.pages();
    if (!full) {
      return pages.map((page) => publicPage({ page }));
    }
    return mapConcurrently(pages, 8, async (page) =>
      publicPage({
        page,
        bodyMarkdown: await this.dependencies.storage.readPublishedRepresentationText(
          page.representation_token,
        ),
      }),
    );
  }

  private get textHeaders(): Record<string, string> {
    return {
      ...this.dependencies.securityHeaders,
      "content-type": "text/plain; charset=utf-8",
    };
  }
}

function publicPage({
  page,
  bodyMarkdown = "",
}: {
  page: Awaited<ReturnType<PublicRepository["pages"]>>[number];
  bodyMarkdown?: string;
}): PublicPageContent {
  return {
    public_id: page.public_id,
    title: page.public_title,
    summary: page.public_summary,
    body_markdown: bodyMarkdown,
    last_edited_at: page.public_last_edited_at,
  };
}
