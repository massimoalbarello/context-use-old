import { Elysia } from "elysia";

type AssetHandler = (input: { request: Request; assetId: string }) => Promise<Response> | Response;

export function createMcpAssetContentController({
  download,
  upload,
}: {
  download: AssetHandler;
  upload: AssetHandler;
}) {
  return new Elysia()
    .put(
      "/api/mcp/assets/:assetId/content",
      ({ request, params }) => upload({ request, assetId: params.assetId }),
      { parse: "none" },
    )
    .get("/api/mcp/assets/:assetId/content", ({ request, params }) =>
      download({ request, assetId: params.assetId }),
    );
}
