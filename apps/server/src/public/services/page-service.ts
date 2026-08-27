import type { PublicActivePageRoute, PublicRepository } from "@context-use/database/publication";
import { publicRouteSchema } from "@context-use/shared";
import type { MarkdownRenderer } from "#markdown/renderer.ts";
import { renderPublicPageMarkdown } from "#public/views/llms-view.ts";
import { renderPublicPageDocument } from "#public/views/page-view.ts";
import type { PublicStorageBroker } from "#storage/client/contracts.ts";

export class PublicPageService {
  constructor(
    private readonly dependencies: {
      routes: Pick<PublicRepository, "entrypoint" | "resolve">;
      storage: Pick<PublicStorageBroker, "readPublishedRepresentationText">;
      markdown: Pick<MarkdownRenderer, "render">;
      siteOrigin: string;
      assetOrigin: string;
      securityHeaders: Record<string, string>;
    },
  ) {}

  root(): Response {
    return new Response(null, {
      status: 308,
      headers: { ...this.dependencies.securityHeaders, location: "/p/" },
    });
  }

  async get(rawPath: string): Promise<Response> {
    if (rawPath === "") {
      const entrypoint = await this.dependencies.routes.entrypoint();
      return entrypoint.state === "active" && entrypoint.route_kind !== "asset"
        ? new Response(null, {
            status: 302,
            headers: {
              ...this.dependencies.securityHeaders,
              location: entrypoint.canonical_path,
            },
          })
        : this.notFound();
    }
    const wantsMarkdown = rawPath.endsWith(".md");
    const parsed = publicRouteSchema.safeParse(`/p/${rawPath}`);
    if (!parsed.success) {
      return this.notFound();
    }
    const route = await this.dependencies.routes.resolve(parsed.data);
    return route.state === "active" && route.route_kind !== "asset"
      ? this.response({ route, wantsMarkdown })
      : this.notFound();
  }

  private async response({
    route,
    wantsMarkdown,
  }: {
    route: PublicActivePageRoute;
    wantsMarkdown: boolean;
  }): Promise<Response> {
    let bodyMarkdown: string;
    try {
      bodyMarkdown = await this.dependencies.storage.readPublishedRepresentationText(
        route.representation_token,
      );
    } catch {
      return this.notFound();
    }
    const page = {
      public_id: route.public_id,
      title: route.public_title,
      summary: route.public_summary,
      body_markdown: bodyMarkdown,
      last_edited_at: route.public_last_edited_at,
    };
    if (wantsMarkdown) {
      return new Response(
        renderPublicPageMarkdown(page, {
          siteOrigin: this.dependencies.siteOrigin,
          assetOrigin: this.dependencies.assetOrigin,
          entrypointPublicPath: null,
        }),
        {
          headers: {
            ...this.dependencies.securityHeaders,
            "content-type": "text/markdown; charset=utf-8",
            "x-robots-tag": "noindex, follow",
            link: `<${this.dependencies.siteOrigin}/p/${route.public_id}>; rel="canonical"`,
          },
        },
      );
    }
    const content = await this.dependencies.markdown.render(
      bodyMarkdown,
      this.unavailableResolvers(),
    );
    return new Response(
      renderPublicPageDocument(
        route.public_title,
        content,
        route.public_id,
        route.public_last_edited_at,
        {
          siteOrigin: this.dependencies.siteOrigin,
          summary: route.public_summary,
          canonicalPath: route.canonical_path,
          entrypointPublicPath: null,
        },
      ),
      {
        headers: {
          ...this.dependencies.securityHeaders,
          "content-type": "text/html; charset=utf-8",
        },
      },
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
        const route = await this.dependencies.routes.resolve(parsed.data);
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

  private notFound(): Response {
    return new Response("Not found", {
      status: 404,
      headers: this.dependencies.securityHeaders,
    });
  }
}
