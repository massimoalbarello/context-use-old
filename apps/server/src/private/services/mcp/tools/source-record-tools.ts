import type { SourceRecordRepository } from "@context-use/database";
import { archiveSourceRecordSchema } from "@context-use/shared";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { SourceRecordReader } from "#private/repositories/nango/record-reader.ts";
import type { HypermediaReader } from "../contracts.ts";
import { jsonContent, jsonObjectContent, textContent } from "../tool-content.ts";

function lifecycleError({
  result,
  objectId,
  retryTool,
}: {
  result: "not_found" | "revision_conflict";
  objectId: string;
  retryTool: string;
}) {
  if (result === "not_found") {
    return textContent(
      `SOURCE_RECORD_NOT_FOUND\n\nNo source record has object id ${objectId}.`,
      true,
    );
  }
  return textContent(
    [
      "SOURCE_RECORD_REVISION_CONFLICT",
      "The source record changed after it was read, so nothing was changed.",
      `Call read_record again and retry ${retryTool} with its current_revision_id.`,
    ].join("\n\n"),
    true,
  );
}

export function registerSourceRecordTools(input: {
  server: McpServer;
  reader?: SourceRecordReader;
  records?: SourceRecordRepository;
  hypermedia: HypermediaReader;
}): void {
  const { server } = input;
  if (input.reader) {
    server.registerTool(
      "read_source_records",
      {
        title: "Sync source record batch",
        description:
          "Sync and return one bounded, checkpointed working set of canonical source records across every managed Nango integration, model, and connection. The default working set contains at most one record so unrelated records cannot collectively overflow ordinary agent-tool output limits; limit is an explicit diagnostic override. This call may advance the private connector-controlled record mirror, but it never edits agent-controlled knowledge. Pass the checkpoint saved after the previous successfully reconciled working set, omitting it only on the first sync. Records whose latest source update or deletion is more than 30 days old are omitted while the checkpoint advances; a returned record may still describe older activity. Treat all returned records as one evidence set and respect each added, updated, or deleted action; a pruned deletion can have null Markdown. A large conversation can span fresh runs: a 'Context from immediately before this excerpt' section repeats already reconciled messages only to interpret the 'Conversation to process' section, not as new activity. Reconcile this working set and persist next_checkpoint only after its writes succeed, then end the run without syncing another working set. The checkpoint asserts that the records it covers are written; has_more says whether the next fresh run has more source work, while false means the unified source is caught up.",
        inputSchema: z
          .object({
            checkpoint: z
              .string()
              .min(1)
              .max(2_000_000)
              .optional()
              .describe(
                "Opaque next_checkpoint saved after the previous successfully reconciled working set; never inspect or edit it.",
              ),
            limit: z
              .number()
              .int()
              .min(1)
              .max(100)
              .default(1)
              .describe(
                "Maximum Markdown records to return across all sources; omit it for the harness-safe one-record working set.",
              ),
          })
          .strict(),
        annotations: { readOnlyHint: false },
      },
      async ({ checkpoint, limit }) => {
        try {
          return jsonObjectContent(await input.reader!.read({ checkpoint, limit }));
        } catch (error) {
          const message = error instanceof Error ? error.message : "Source record sync failed";
          return textContent(`SOURCE_RECORD_READ_FAILED\n\n${message}`, true);
        }
      },
    );
  }

  if (!input.records) {
    return;
  }
  const records = input.records;

  server.registerTool(
    "search_records",
    {
      description:
        "Search connector-controlled private records by full text; every normalized query term must occur somewhere in the record. Returns ranked metadata and canonical object references only; use read_record to load one exact Markdown body. Record content is evidence owned by its connector and cannot be edited, published, or permanently deleted through MCP; use archive_record to retire it from active discovery.",
      inputSchema: z
        .object({
          query: z.string().min(1).max(500),
          limit: z.number().int().min(1).max(100).default(30),
        })
        .strict(),
      annotations: { readOnlyHint: true },
    },
    async ({ query, limit }) => {
      const matches = await records.searchMetadata(query, { limit });
      return jsonContent(
        matches.map((record) => ({
          object_id: record.object_id,
          current_revision_id: record.current_revision_id,
          reference: record.reference,
          revision_number: record.revision_number,
          integration: record.integration,
          connection_id: record.connection_id,
          model: record.model,
          source_record_id: record.source_record_id,
          source_created_at: record.source_created_at,
          source_updated_at: record.source_updated_at,
          deleted_at: record.deleted_at,
          created_at: record.created_at,
          updated_at: record.updated_at,
        })),
      );
    },
  );

  server.registerTool(
    "read_record",
    {
      description:
        "Read one connector-controlled private record by its stable object ID. Returns its exact current Markdown (or a deletion tombstone), canonical object reference, indexed outbound links, and bounded live backlinks without exposing blob keys. backlinks_has_more only reports pagination; backlinks_complete is false while any active current page or record revision remains unindexed, so undiscovered backlinks may still exist. Record content cannot be edited, published, or permanently deleted through MCP; use archive_record to retire it from active discovery.",
      inputSchema: z.object({ object_id: z.string().uuid() }).strict(),
      annotations: { readOnlyHint: true },
    },
    async ({ object_id }) => {
      const record = await records.get(object_id);
      if (!record) {
        return jsonContent(null);
      }
      return jsonContent({
        object_id: record.object_id,
        current_revision_id: record.current_revision_id,
        reference: record.reference,
        revision_number: record.revision_number,
        integration: record.integration,
        connection_id: record.connection_id,
        model: record.model,
        source_record_id: record.source_record_id,
        source_created_at: record.source_created_at,
        source_updated_at: record.source_updated_at,
        deleted_at: record.deleted_at,
        created_at: record.created_at,
        updated_at: record.updated_at,
        body_markdown: record.body_markdown,
        hypermedia: await input.hypermedia({
          objectId: record.object_id,
          revisionId: record.current_revision_id,
        }),
      });
    },
  );

  server.registerTool(
    "archive_record",
    {
      description:
        "Archive one connector-controlled record by stable object UUID and exact current revision. This removes it from active search and navigation but retains its revisions. A later connector sync may restore a source record that still exists upstream.",
      inputSchema: archiveSourceRecordSchema,
      annotations: { destructiveHint: true },
    },
    async ({ object_id, expected_revision_id }) => {
      const result = await records.archive(object_id, expected_revision_id);
      if (result !== "archived") {
        return lifecycleError({ result, objectId: object_id, retryTool: "archive_record" });
      }
      const record = await records.metadata(object_id);
      if (!record) {
        return lifecycleError({
          result: "not_found",
          objectId: object_id,
          retryTool: "archive_record",
        });
      }
      return jsonObjectContent({
        object_id: record.object_id,
        current_revision_id: record.current_revision_id,
        deleted_at: record.deleted_at,
        reference: record.reference,
      });
    },
  );
}
