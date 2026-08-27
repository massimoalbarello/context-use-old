import { archiveAssetSchema, createAssetSchema } from "@context-use/shared";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createAssetCapability } from "../asset-capability.ts";
import type { GuidancePolicy, McpContext, McpObjectRepositories } from "../contracts.ts";
import { mutationReceiptSchemas } from "../guidance-policy.ts";
import { jsonContent } from "../tool-content.ts";

export function registerAssetTools(input: {
  server: McpServer;
  context: McpContext;
  objects: McpObjectRepositories;
  guidance: GuidancePolicy;
  appOrigin: string;
  capabilitySecret: string;
}): void {
  const { server } = input;
  server.registerTool(
    "create_asset_upload",
    {
      description:
        "Create a checksum-bound private asset with a stable object UUID. PUT the exact raw bytes to the returned URL with every returned header before expires_at.",
      inputSchema: createAssetSchema.extend(mutationReceiptSchemas).strict(),
      annotations: { destructiveHint: false },
    },
    async ({ knowledge_session_receipt, ...assetInput }) => {
      if (!(await input.guidance.hasCurrentGuidance(knowledge_session_receipt))) {
        return input.guidance.required("create_asset_upload");
      }
      const created = await input.objects.assets.create(assetInput);
      const objectId = created.object.object_id;
      const { object_id: _objectId, ...asset } = created.object;
      const capability = createAssetCapability(
        "upload",
        objectId,
        input.context,
        Date.now(),
        input.capabilitySecret,
      );
      const reference = `context-use://object/${objectId}`;
      const markdownAlt =
        created.object.filename
          .replace(/[[\]\r\n]+/g, " ")
          .replace(/\s+/g, " ")
          .trim() || "Image";
      const imageMarkdown = `![${markdownAlt}](${reference})`;
      return jsonContent({
        object: { object_id: objectId, ...asset },
        reference,
        ...(/^image\/(?:png|jpeg|gif|webp|avif)(?:;|$)/i.test(created.object.content_type)
          ? {
              page_markdown: {
                default: imageMarkdown,
                formatted_example: `${imageMarkdown}{size=medium align=center shape=auto}`,
              },
            }
          : {}),
        upload: {
          method: "PUT",
          url: `${input.appOrigin}/api/mcp/assets/${encodeURIComponent(objectId)}/content`,
          headers: {
            "content-type": created.object.content_type,
            "content-length": created.object.size_bytes,
            "x-context-use-upload-token": capability.token,
          },
          expires_at: capability.expiresAt,
        },
      });
    },
  );

  server.registerTool(
    "archive_asset",
    {
      description:
        "Archive one private asset by stable object UUID. Published assets and assets referenced by active pages are rejected.",
      inputSchema: archiveAssetSchema.extend(mutationReceiptSchemas).strict(),
      annotations: { destructiveHint: true },
    },
    async ({ object_id, knowledge_session_receipt }) => {
      const asset = await input.objects.assets.get(object_id);
      if (!asset) {
        return jsonContent(null);
      }
      if (!(await input.guidance.hasCurrentGuidance(knowledge_session_receipt))) {
        return input.guidance.required("archive_asset");
      }
      return jsonContent(await input.objects.assets.archive({ object_id }));
    },
  );
}
