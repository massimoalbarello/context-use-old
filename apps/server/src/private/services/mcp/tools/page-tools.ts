import { archivePageSchema, createPageSchema, updatePageSchema } from "@context-use/shared";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { GuidancePolicy, McpContext, McpObjectRepositories } from "../contracts.ts";
import { mutationReceiptSchemas } from "../guidance-policy.ts";
import { jsonContent, textContent } from "../tool-content.ts";

function unknownPage({ objectId, retryTool }: { objectId: string; retryTool: string }) {
  return textContent(
    [
      "OBJECT_NOT_FOUND",
      `No active page has object id ${objectId}, so nothing was changed.`,
      `Use search_objects, copy the stable object_id exactly, and retry ${retryTool}.`,
    ].join("\n\n"),
    true,
  );
}

export function registerPageTools(input: {
  server: McpServer;
  context: McpContext;
  objects: McpObjectRepositories;
  guidance: GuidancePolicy;
}): void {
  const { server } = input;
  const actor = { kind: "mcp" as const, subject: input.context.clientId };

  server.registerTool(
    "create_page",
    {
      description:
        "Create a private Markdown page with a stable object UUID and no caller-selected path. Requires a current knowledge_session_receipt from begin_knowledge_session. The summary is used in search and link previews.",
      inputSchema: createPageSchema.extend(mutationReceiptSchemas).strict(),
      annotations: { destructiveHint: false },
    },
    async ({ knowledge_session_receipt, ...page }) => {
      if (!(await input.guidance.hasCurrentGuidance(knowledge_session_receipt))) {
        return input.guidance.required("create_page");
      }
      const created = await input.objects.pages.create(page, actor);
      return jsonContent({
        object_id: created.object_id,
        current_revision_id: created.current_revision_id,
        revision_number: created.revision_number,
        entity_type: created.entity_type,
        title: created.title,
        summary: created.summary,
        body_markdown: created.body_markdown,
        reference: `context-use://object/${created.object_id}`,
      });
    },
  );

  server.registerTool(
    "update_page",
    {
      description:
        "Create a new immutable revision of an active page by stable object UUID. Read it first and pass expected_revision_number for optimistic concurrency.",
      inputSchema: updatePageSchema
        .extend({
          object_id: z.string().uuid(),
          ...mutationReceiptSchemas,
        })
        .strict(),
      annotations: { destructiveHint: false },
    },
    async ({ object_id, knowledge_session_receipt, ...page }) => {
      const existing = await input.objects.pages.get(object_id);
      if (!existing || existing.archived_at) {
        return unknownPage({ objectId: object_id, retryTool: "update_page" });
      }
      if (!(await input.guidance.hasCurrentGuidance(knowledge_session_receipt))) {
        return input.guidance.required("update_page");
      }
      const updated = await input.objects.pages.update(object_id, page, actor);
      if (!updated) {
        return unknownPage({ objectId: object_id, retryTool: "update_page" });
      }
      return jsonContent({
        object_id: updated.object_id,
        current_revision_id: updated.current_revision_id,
        revision_number: updated.revision_number,
        entity_type: updated.entity_type,
        title: updated.title,
        summary: updated.summary,
        body_markdown: updated.body_markdown,
        reference: `context-use://object/${updated.object_id}`,
      });
    },
  );

  server.registerTool(
    "archive_page",
    {
      description:
        "Archive one unpublished page by stable object UUID using optimistic concurrency. Requires a current knowledge_session_receipt from begin_knowledge_session.",
      inputSchema: archivePageSchema
        .extend({
          object_id: z.string().uuid(),
          ...mutationReceiptSchemas,
        })
        .strict(),
      annotations: { destructiveHint: true },
    },
    async ({ object_id, knowledge_session_receipt, ...archive }) => {
      const existing = await input.objects.pages.get(object_id);
      if (!existing) {
        return unknownPage({ objectId: object_id, retryTool: "archive_page" });
      }
      if (!(await input.guidance.hasCurrentGuidance(knowledge_session_receipt))) {
        return input.guidance.required("archive_page");
      }
      const archived = await input.objects.pages.archive(object_id, archive, actor);
      return archived
        ? jsonContent({
            object_id: archived.object_id,
            current_revision_id: archived.current_revision_id,
            revision_number: archived.revision_number,
            archived_at: archived.archived_at,
            reference: `context-use://object/${archived.object_id}`,
          })
        : unknownPage({ objectId: object_id, retryTool: "archive_page" });
    },
  );
}
