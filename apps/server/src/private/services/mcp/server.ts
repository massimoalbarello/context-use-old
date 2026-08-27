import type {
  KnowledgeSettingsRepository,
  ObjectLinkRepository,
  SourceRecordRepository,
} from "@context-use/database";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SourceRecordReader } from "#private/repositories/nango/record-reader.ts";
import type { McpContext, McpObjectRepositories } from "./contracts.ts";
import { createGuidancePolicy } from "./guidance-policy.ts";
import { createHypermediaReader } from "./hypermedia-reader.ts";
import { registerAssetTools } from "./tools/asset-tools.ts";
import { registerKnowledgeSessionTool } from "./tools/knowledge-session-tool.ts";
import { registerObjectTools } from "./tools/object-tools.ts";
import { registerPageHistoryTools } from "./tools/page-history-tools.ts";
import { registerPageTools } from "./tools/page-tools.ts";
import { registerSourceRecordTools } from "./tools/source-record-tools.ts";

export type { McpContext, McpObjectRepositories } from "./contracts.ts";

const SERVER_INSTRUCTIONS =
  "Use Context Use proactively when the user states a concrete " +
  "durable fact, decision, correction, relationship, plan, or completed activity about " +
  "their life or work, even if they do not explicitly say “remember.” Before the first " +
  "knowledge mutation in an authenticated session, call begin_knowledge_session, read its " +
  "configured global guide, and reuse its receipt across every target in that session. " +
  "Use the stable-ID object tools (search_objects, read_object, create_page, update_page, " +
  "archive_page, archive_record, create_asset_upload, archive_asset). Navigate knowledge " +
  "through search results, stable object identities and hyperlinks.";

export function createMcpServer({
  context,
  sourceRecords,
  recordObjects,
  knowledgeSettings,
  objectLinks,
  objects,
  appOrigin = "http://localhost:3000",
  capabilitySecret = "development-only-mcp-capability-secret",
}: {
  context: McpContext;
  sourceRecords?: SourceRecordReader;
  recordObjects?: SourceRecordRepository;
  knowledgeSettings: KnowledgeSettingsRepository;
  objectLinks: ObjectLinkRepository;
  objects: McpObjectRepositories;
  appOrigin?: string;
  capabilitySecret?: string;
}): McpServer {
  const server = new McpServer(
    { name: "context-use", version: "0.1.100" },
    { instructions: SERVER_INSTRUCTIONS },
  );
  const hypermedia = createHypermediaReader({ objectLinks });
  const guidance = createGuidancePolicy({
    settings: knowledgeSettings,
    context,
    capabilitySecret,
  });

  registerObjectTools({
    server,
    context,
    objects,
    ...(recordObjects ? { records: recordObjects } : {}),
    hypermedia,
    appOrigin,
    capabilitySecret,
  });
  registerPageTools({ server, context, objects, guidance });
  registerAssetTools({
    server,
    context,
    objects,
    guidance,
    appOrigin,
    capabilitySecret,
  });
  registerSourceRecordTools({
    server,
    ...(sourceRecords ? { reader: sourceRecords } : {}),
    ...(recordObjects ? { records: recordObjects } : {}),
    hypermedia,
  });
  registerKnowledgeSessionTool({
    server,
    context,
    settings: knowledgeSettings,
    objects,
    capabilitySecret,
  });
  registerPageHistoryTools({ server, objects });
  return server;
}
