import type { PrivateObjectCatalogRepository } from "@context-use/database";
import type { MarkdownRenderer } from "#markdown/renderer.ts";

export class DashboardRenderingService {
  constructor(
    private readonly objects: PrivateObjectCatalogRepository,
    private readonly markdown: Pick<MarkdownRenderer, "render">,
  ) {}

  render(markdown: string): Promise<string> {
    return this.markdown.render(markdown, {
      object: async (objectId) => {
        const object = await this.objects.get(objectId);
        if (object?.lifecycle !== "active") {
          return { available: false as const };
        }
        if (object.object_kind === "asset") {
          return {
            available: true as const,
            representation: "asset" as const,
            href: `/api/dashboard/assets/${objectId}/content`,
            contentType: object.content_type ?? "application/octet-stream",
          };
        }
        return {
          available: true as const,
          representation: object.object_kind === "record" ? ("record" as const) : ("page" as const),
          href: `/app/objects/${objectId}`,
        };
      },
    });
  }
}
