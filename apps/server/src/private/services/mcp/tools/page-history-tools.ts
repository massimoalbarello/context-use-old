import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { pageDelta } from "#private/services/dashboard/page-delta.ts";
import type { McpObjectRepositories } from "../contracts.ts";
import { jsonContent, jsonObjectContent, textContent } from "../tool-content.ts";

export function registerPageHistoryTools({
  server,
  objects,
}: {
  server: McpServer;
  objects: McpObjectRepositories;
}): void {
  server.registerTool(
    "list_page_changes",
    {
      description:
        "List authored page changes after an opaque cursor. Rows identify stable objects and revisions without bodies or blob locators. Paginate one fixed window with next_page_token, then persist next_cursor only after the complete window succeeds.",
      inputSchema: z
        .object({
          cursor: z
            .string()
            .regex(/^cu-page-changes-v1\.[0-9a-z]+$/)
            .optional(),
          page_token: z
            .string()
            .regex(/^cu-page-scan-v1\.[0-9a-z]+\.[0-9a-z]+\.[0-9a-z]+$/)
            .optional(),
          limit: z.number().int().min(1).max(500).default(200),
        })
        .strict()
        // biome-ignore lint/complexity/useMaxParams: Zod owns this callback signature.
        .superRefine((value, context) => {
          if (value.cursor && value.page_token) {
            context.addIssue({
              code: "custom",
              message: "Provide a cursor or page_token, not both",
            });
          }
        }),
      annotations: { readOnlyHint: true },
    },
    async ({ cursor, page_token, limit }) =>
      jsonObjectContent(
        await objects.pages.changesSince({
          ...(cursor ? { cursor } : {}),
          ...(page_token ? { pageToken: page_token } : {}),
          limit,
        }),
      ),
  );

  server.registerTool(
    "compare_page_revisions",
    {
      description:
        "Compare two immutable page revisions from a list_page_changes row. Returns title/summary changes and compact Markdown fragments without blob metadata.",
      inputSchema: z
        .object({
          object_id: z.string().uuid(),
          previous_revision_number: z.number().int().positive().nullable(),
          revision_number: z.number().int().positive(),
        })
        .strict()
        // biome-ignore lint/complexity/useMaxParams: Zod owns this callback signature.
        .superRefine((value, context) => {
          if (
            value.previous_revision_number !== null &&
            value.previous_revision_number >= value.revision_number
          ) {
            context.addIssue({
              code: "custom",
              message: "previous_revision_number must be less than revision_number",
            });
          }
        }),
      annotations: { readOnlyHint: true },
    },
    async ({ object_id, previous_revision_number, revision_number }) => {
      const [requestedPrevious, current] = await Promise.all([
        previous_revision_number === null
          ? Promise.resolve(null)
          : objects.pages.revision(object_id, previous_revision_number),
        objects.pages.revision(object_id, revision_number),
      ]);
      if (!current) {
        return textContent(
          [
            "PAGE_DELTA_UNAVAILABLE",
            `Page ${object_id} revision ${revision_number} is not retained; no safe comparison was produced.`,
          ].join("\n\n"),
          true,
        );
      }
      const retainedPrevious =
        previous_revision_number !== null && !requestedPrevious
          ? ((await objects.pages.oldestRetainedRevisionAfter(
              object_id,
              previous_revision_number,
              revision_number,
            )) ?? current)
          : null;
      const previous = requestedPrevious ?? retainedPrevious;
      const actualFromRevision =
        previous_revision_number === null
          ? null
          : requestedPrevious
            ? previous_revision_number
            : retainedPrevious!.revision_number;
      const delta = await pageDelta(previous, current);
      return jsonObjectContent({
        object_id,
        comparison: {
          requested_from_revision: previous_revision_number,
          actual_from_revision: actualFromRevision,
          to_revision: revision_number,
          complete: actualFromRevision === previous_revision_number,
        },
        metadata_changes: delta.metadata_changes,
        markdown_changes: delta.markdown_changes,
      });
    },
  );

  server.registerTool(
    "list_page_revisions",
    {
      description:
        "List one page's immutable revision metadata and commit attribution by stable object UUID.",
      inputSchema: z.object({ object_id: z.string().uuid() }).strict(),
      annotations: { readOnlyHint: true },
    },
    async ({ object_id }) => {
      const history = await objects.pages.history(object_id);
      return jsonContent(
        history.revisions.map(({ body_markdown: _body, ...revision }) => ({
          ...revision,
          object_id,
        })),
      );
    },
  );

  server.registerTool(
    "read_page_revision",
    {
      description:
        "Read one exact immutable page revision by stable object UUID and revision number.",
      inputSchema: z
        .object({
          object_id: z.string().uuid(),
          revision_number: z.number().int().positive(),
        })
        .strict(),
      annotations: { readOnlyHint: true },
    },
    async ({ object_id, revision_number }) => {
      const revision = await objects.pages.revision(object_id, revision_number);
      return revision
        ? jsonContent({
            ...revision,
            reference: `context-use://object/${object_id}`,
          })
        : jsonContent(null);
    },
  );
}
