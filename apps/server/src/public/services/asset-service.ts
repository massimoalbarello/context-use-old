import type { PublicActiveAssetRoute, PublicRepository } from "@context-use/database/publication";
import { publicRouteSchema } from "@context-use/shared";
import { assetContentResponse } from "#http/asset-content.ts";
import { requestMatchesOrigin } from "#http/request-origin.ts";
import type { PublicStorageBroker } from "#storage/client/contracts.ts";

type AssetRouteRepository = Pick<PublicRepository, "resolve">;
type PublicAssetStorage = Pick<
  PublicStorageBroker,
  "inspectPublishedRepresentation" | "readPublishedRepresentation"
>;

export class PublicAssetService {
  constructor(
    private readonly dependencies: {
      routes: AssetRouteRepository;
      storage: PublicAssetStorage;
      assetOrigin: string;
      securityHeaders: Record<string, string>;
    },
  ) {}

  async get({ request, rawPath }: { request: Request; rawPath: string }): Promise<Response> {
    if (
      !requestMatchesOrigin({ request, expectedOrigin: this.dependencies.assetOrigin }) ||
      request.headers.has("cookie") ||
      request.headers.has("authorization")
    ) {
      return this.notFound();
    }
    const parsed = publicRouteSchema.safeParse(`/a/${rawPath}`);
    if (!parsed.success) {
      return this.notFound();
    }
    const route = await this.dependencies.routes.resolve(parsed.data);
    return route.state === "active" && route.route_kind === "asset"
      ? this.response({ request, route })
      : this.notFound();
  }

  private async response({
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
      return this.notFound();
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
        // biome-ignore lint/complexity/useMaxParams: BlobStorage owns this callback signature.
        read: (_reference, range) =>
          this.dependencies.storage.readPublishedRepresentation(route.representation_token, range),
      },
      true,
      route.public_id,
      this.dependencies.securityHeaders,
    );
    response.headers.set("cross-origin-resource-policy", "cross-origin");
    return response;
  }

  private notFound(): Response {
    return new Response("Not found", {
      status: 404,
      headers: this.dependencies.securityHeaders,
    });
  }
}
