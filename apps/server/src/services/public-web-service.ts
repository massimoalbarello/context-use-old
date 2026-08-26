import { mapConcurrently } from "@context-use/database";
import type {
  PublicActiveAssetRoute,
  PublicActivePageRoute,
  PublicRepository,
} from "@context-use/database/publication";
import { publicRouteSchema } from "@context-use/shared";
import { assetContentResponse } from "../asset-content.ts";
import { renderMarkdown } from "../markdown.ts";
import type { PublicPageContent } from "../public-content.ts";
import { externalProfileLinks, renderRobotsTxt, renderSitemapXml } from "../public-discovery.ts";
import { renderLlmsFullTxt, renderLlmsTxt, renderPublicPageMarkdown } from "../public-llms.ts";
import {
  IMAGE_LAYOUT_STYLES,
  publicPageStyles,
  renderPublicLandingDocument,
  renderPublicPageDocument,
} from "../public-page.ts";
import { requestMatchesOrigin, securityHeaders } from "../security.ts";
import type { BrokeredStorage } from "../storage-client.ts";

const htmlHeaders = { ...securityHeaders, "content-type": "text/html; charset=utf-8" };
const textHeaders = { ...securityHeaders, "content-type": "text/plain; charset=utf-8" };
const agentTextHeaders = { ...textHeaders, "x-robots-tag": "noindex, follow" };
const markdownHeaders = {
  ...securityHeaders,
  "content-type": "text/markdown; charset=utf-8",
  "x-robots-tag": "noindex, follow",
};
const xmlHeaders = { ...securityHeaders, "content-type": "application/xml; charset=utf-8" };

type PublicData = Pick<PublicRepository, "entrypoint" | "pages" | "resolve">;
type PublicStorage = Pick<
  BrokeredStorage,
  | "inspectPublishedRepresentation"
  | "readPublishedRepresentation"
  | "readPublishedRepresentationText"
>;

export class PublicWebService {
  constructor(
    private readonly dependencies: {
      publicData: PublicData;
      storage: PublicStorage;
      siteOrigin: string;
      assetOrigin: string;
    },
  ) {}

  health() {
    return { status: "ok", service: "public-web" };
  }

  async asset({ request, rawPath }: { request: Request; rawPath: string }): Promise<Response> {
    if (!this.assetRequestAllowed(request)) {
      return notFound();
    }
    const parsed = publicRouteSchema.safeParse(`/a/${rawPath}`);
    if (!parsed.success) {
      return notFound();
    }
    const route = await this.dependencies.publicData.resolve(parsed.data);
    if (route.state !== "active" || route.route_kind !== "asset") {
      return notFound();
    }
    return this.assetResponse({ request, route });
  }

  robots(): Response {
    return new Response(renderRobotsTxt(this.dependencies.siteOrigin), { headers: textHeaders });
  }

  async sitemap(): Promise<Response> {
    const pages = await this.canonicalPublishedPages(false);
    return new Response(renderSitemapXml(pages, this.dependencies.siteOrigin), {
      headers: xmlHeaders,
    });
  }

  async llms(full: boolean): Promise<Response> {
    const entrypoint = await this.dependencies.publicData.entrypoint();
    const pages = await this.canonicalPublishedPages(full);
    const options = {
      siteOrigin: this.dependencies.siteOrigin,
      assetOrigin: this.dependencies.assetOrigin,
      entrypointPublicPath:
        entrypoint.state === "active" && entrypoint.route_kind !== "asset"
          ? entrypoint.public_id
          : null,
    };
    return new Response(full ? renderLlmsFullTxt(pages, options) : renderLlmsTxt(pages, options), {
      headers: full ? agentTextHeaders : textHeaders,
    });
  }

  async page(rawPath: string): Promise<Response> {
    if (rawPath === "") {
      const entrypoint = await this.dependencies.publicData.entrypoint();
      return entrypoint.state === "active" && entrypoint.route_kind !== "asset"
        ? new Response(null, {
            status: 302,
            headers: { ...securityHeaders, location: entrypoint.canonical_path },
          })
        : notFound();
    }
    const markdown = rawPath.endsWith(".md");
    const parsed = publicRouteSchema.safeParse(`/p/${rawPath}`);
    if (!parsed.success) {
      return notFound();
    }
    const route = await this.dependencies.publicData.resolve(parsed.data);
    return route.state === "active" && route.route_kind !== "asset"
      ? this.pageResponse({ publicId: route.public_id, markdown, route })
      : notFound();
  }

  async landing(): Promise<Response> {
    const entrypoint = await this.publicEntrypoint();
    const profileLinks = entrypoint.introduction
      ? externalProfileLinks(entrypoint.introduction.body_markdown, this.dependencies.siteOrigin)
      : [];
    return new Response(
      renderPublicLandingDocument({
        siteOrigin: this.dependencies.siteOrigin,
        introduction: entrypoint.introduction,
        entrypointPublicPath: entrypoint.publicPath,
        profileLinks,
      }),
      { headers: htmlHeaders },
    );
  }

  styles(kind: "public" | "content"): Response {
    return new Response(kind === "public" ? publicPageStyles : IMAGE_LAYOUT_STYLES, {
      headers: { ...securityHeaders, "content-type": "text/css; charset=utf-8" },
    });
  }

  private async canonicalPublishedPages(full: boolean): Promise<PublicPageContent[]> {
    const pages = await this.dependencies.publicData.pages();
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

  private async publicEntrypoint(): Promise<{
    state: "unassigned" | "inactive" | "active";
    publicPath: string | null;
    introduction: PublicPageContent | null;
  }> {
    const route = await this.dependencies.publicData.entrypoint();
    if (route.state !== "active" || route.route_kind === "asset") {
      return { state: route.state, publicPath: null, introduction: null };
    }
    try {
      return {
        state: "active",
        publicPath: route.public_id,
        introduction: {
          public_id: route.public_id,
          title: route.public_title,
          summary: route.public_summary,
          body_markdown: await this.dependencies.storage.readPublishedRepresentationText(
            route.representation_token,
          ),
          last_edited_at: route.public_last_edited_at,
        },
      };
    } catch {
      return { state: "inactive", publicPath: null, introduction: null };
    }
  }

  private async pageResponse({
    publicId,
    markdown,
    route,
  }: {
    publicId: string;
    markdown: boolean;
    route: PublicActivePageRoute;
  }): Promise<Response> {
    let bodyMarkdown: string;
    try {
      bodyMarkdown = await this.dependencies.storage.readPublishedRepresentationText(
        route.representation_token,
      );
    } catch {
      return notFound();
    }
    const page = {
      public_id: publicId,
      title: route.public_title,
      summary: route.public_summary,
      body_markdown: bodyMarkdown,
      last_edited_at: route.public_last_edited_at,
    };
    if (markdown) {
      return new Response(
        renderPublicPageMarkdown(page, {
          siteOrigin: this.dependencies.siteOrigin,
          assetOrigin: this.dependencies.assetOrigin,
          entrypointPublicPath: null,
        }),
        {
          headers: {
            ...markdownHeaders,
            link: `<${this.dependencies.siteOrigin}/p/${publicId}>; rel="canonical"`,
          },
        },
      );
    }
    const content = await renderMarkdown(bodyMarkdown, this.unavailableResolvers());
    return new Response(
      renderPublicPageDocument(route.public_title, content, publicId, route.public_last_edited_at, {
        siteOrigin: this.dependencies.siteOrigin,
        summary: route.public_summary,
        canonicalPath: route.canonical_path,
        entrypointPublicPath: null,
      }),
      { headers: htmlHeaders },
    );
  }

  private async assetResponse({
    request,
    route,
  }: {
    request: Request;
    route: PublicActiveAssetRoute;
  }): Promise<Response> {
    let metadata: { sizeBytes: number; contentHash: string };
    try {
      metadata = await this.dependencies.storage.inspectPublishedRepresentation(
        route.representation_token,
      );
    } catch {
      return notFound();
    }
    const response = await assetContentResponse(
      request,
      {
        filename: route.public_filename,
        content_type: route.public_content_type,
        size_bytes: metadata.sizeBytes,
        content_hash: metadata.contentHash,
      },
      {
        // biome-ignore lint/complexity/useMaxParams: Blob reader contract is shared with asset responses.
        read: (_reference, range) =>
          this.dependencies.storage.readPublishedRepresentation(route.representation_token, range),
      },
      true,
      route.public_id,
    );
    response.headers.set("cross-origin-resource-policy", "cross-origin");
    return response;
  }

  private assetRequestAllowed(request: Request): boolean {
    return (
      requestMatchesOrigin(request, this.dependencies.assetOrigin) &&
      !request.headers.has("cookie") &&
      !request.headers.has("authorization")
    );
  }

  private unavailableResolvers() {
    return {
      object: async () => ({ available: false as const }),
      publicAssetPath: async (path: string) => {
        const parsed = publicRouteSchema.safeParse(`/a/${path}`);
        if (!parsed.success) {
          return { available: false as const };
        }
        const route = await this.dependencies.publicData.resolve(parsed.data);
        return route.state === "active" && route.route_kind === "asset"
          ? {
              available: true as const,
              href: `${this.dependencies.assetOrigin}${route.canonical_path}`,
              contentType: route.public_content_type,
            }
          : { available: false as const };
      },
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

function notFound(): Response {
  return new Response("Not found", { status: 404, headers: securityHeaders });
}
