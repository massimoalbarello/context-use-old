import type { PublicRepository } from "@context-use/database/publication";
import type { PublicPageContent } from "#public/models/page-content.ts";
import { externalProfileLinks } from "#public/views/discovery-view.ts";
import { renderPublicLandingDocument } from "#public/views/page-view.ts";
import type { PublicStorageBroker } from "#storage/client/contracts.ts";

export class PublicLandingService {
  constructor(
    private readonly dependencies: {
      entrypoint: Pick<PublicRepository, "entrypoint">;
      storage: Pick<PublicStorageBroker, "readPublishedRepresentationText">;
      siteOrigin: string;
      securityHeaders: Record<string, string>;
    },
  ) {}

  async get(): Promise<Response> {
    const entrypoint = await this.entrypoint();
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
      {
        headers: {
          ...this.dependencies.securityHeaders,
          "content-type": "text/html; charset=utf-8",
        },
      },
    );
  }

  private async entrypoint(): Promise<{
    state: "unassigned" | "inactive" | "active";
    publicPath: string | null;
    introduction: PublicPageContent | null;
  }> {
    const route = await this.dependencies.entrypoint.entrypoint();
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
}
