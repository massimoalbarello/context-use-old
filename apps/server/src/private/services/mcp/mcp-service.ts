import type {
  KnowledgeSettingsRepository,
  ObjectLinkRepository,
  SourceRecordRepository,
} from "@context-use/database";
import type { SourceRecordReader } from "#private/repositories/nango/record-reader.ts";
import {
  createMcpServer,
  type McpContext,
  type McpObjectRepositories,
} from "#private/services/mcp/server.ts";
import {
  createStatelessMcpTransport,
  unsupportedMcpMethodResponse,
} from "#private/services/mcp/transport.ts";

export function createMcpService({
  sourceRecords,
  recordObjects,
  knowledgeSettings,
  objectLinks,
  objects,
  appOrigin,
  capabilitySecret,
}: {
  sourceRecords: SourceRecordReader | undefined;
  recordObjects: SourceRecordRepository | undefined;
  knowledgeSettings: KnowledgeSettingsRepository;
  objectLinks: ObjectLinkRepository;
  objects: McpObjectRepositories;
  appOrigin: string;
  capabilitySecret: string;
}) {
  return async ({ request, context }: { request: Request; context: McpContext }) => {
    const unsupportedMethod = unsupportedMcpMethodResponse(request);
    if (unsupportedMethod) {
      return unsupportedMethod;
    }
    const transport = createStatelessMcpTransport();
    const server = await createMcpServer({
      context,
      ...(sourceRecords ? { sourceRecords } : {}),
      ...(recordObjects ? { recordObjects } : {}),
      knowledgeSettings,
      objectLinks,
      objects,
      appOrigin,
      capabilitySecret,
    });
    await server.connect(transport);
    try {
      return await transport.handleRequest(request);
    } finally {
      await transport.close();
      await server.close();
    }
  };
}
