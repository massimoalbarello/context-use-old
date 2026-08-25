export const PLUGIN_ID = "context-use-memory";
export const ATTACHMENT_TOOL_NAME = "context_use_attachment";
export const MCP_SERVER_NAME = "context-use";
export const DEFAULT_MEMORY_SLOT = "memory-core";
export const RECALL_TOOL_NAMES = [
  "context-use__search_objects",
  "context-use__read_object",
];

export const RECALL_PROMPT =
  "You are a read-only Context-use recall subagent. Search Context-use for knowledge relevant to the current conversation. Use only the configured Context-use read tools; never mutate knowledge. Prefer the most specific canonical objects, distinguish remembered facts from inference, and return only concise context that will materially improve the answer. Include stable Context-use object references when useful. If nothing relevant is found, return NO_REPLY.";

const DEFAULT_PLUGIN_ENTRY = {
  enabled: true,
  hooks: {
    allowConversationAccess: true,
    timeouts: { agent_end: 150000 },
  },
  subagent: { allowModelOverride: true },
  config: {
    captureEnabled: true,
    ownerOnly: true,
    timeoutMs: 120000,
    maxCaptureChars: 20000,
    maxInspectBytes: 20000000,
    retainCuratorTranscripts: false,
    logging: true,
  },
};

const DEFAULT_ACTIVE_MEMORY_ENTRY = {
  enabled: true,
  hooks: {
    allowPromptInjection: true,
    allowConversationAccess: true,
  },
  config: {
    enabled: true,
    allowedChatTypes: ["direct", "explicit"],
    timeoutMs: 60000,
    queryMode: "recent",
    recentUserTurns: 2,
    recentAssistantTurns: 1,
    promptStyle: "precision-heavy",
    toolsAllow: RECALL_TOOL_NAMES,
    promptOverride: RECALL_PROMPT,
    maxSummaryChars: 900,
    persistTranscripts: false,
    logging: true,
  },
};

function optionalRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : undefined;
}

function ensureRecord(parent, key) {
  const current = optionalRecord(parent[key]);
  if (current) return current;
  const next = {};
  parent[key] = next;
  return next;
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function propertySnapshot(parent, key) {
  return Object.prototype.hasOwnProperty.call(parent, key)
    ? { exists: true, value: clone(parent[key]) }
    : { exists: false };
}

function restoreProperty(parent, key, snapshot) {
  if (snapshot?.exists) parent[key] = clone(snapshot.value);
  else delete parent[key];
}

function mergeEntry(existingValue, defaults) {
  const existing = optionalRecord(existingValue) ?? {};
  const existingHooks = optionalRecord(existing.hooks) ?? {};
  const existingTimeouts = optionalRecord(existingHooks.timeouts) ?? {};
  const defaultHooks = optionalRecord(defaults.hooks) ?? {};
  const defaultTimeouts = optionalRecord(defaultHooks.timeouts) ?? {};
  const existingSubagent = optionalRecord(existing.subagent) ?? {};
  const defaultSubagent = optionalRecord(defaults.subagent) ?? {};
  const existingConfig = optionalRecord(existing.config) ?? {};
  const defaultConfig = optionalRecord(defaults.config) ?? {};

  return {
    ...existing,
    ...defaults,
    hooks: {
      ...existingHooks,
      ...defaultHooks,
      timeouts: { ...existingTimeouts, ...defaultTimeouts },
    },
    subagent: { ...existingSubagent, ...defaultSubagent },
    config: { ...existingConfig, ...defaultConfig },
  };
}

export function isContextUseRecallEntry(value) {
  const config = optionalRecord(optionalRecord(value)?.config);
  if (!config) return false;
  const tools = Array.isArray(config.toolsAllow) ? config.toolsAllow : [];
  return (
    tools.length === RECALL_TOOL_NAMES.length &&
    RECALL_TOOL_NAMES.every((name) => tools.includes(name)) &&
    typeof config.promptOverride === "string" &&
    config.promptOverride.includes("Context-use recall subagent")
  );
}

export function createInstallSnapshot(config) {
  const root = optionalRecord(config) ?? {};
  const tools = optionalRecord(root.tools) ?? {};
  const plugins = optionalRecord(root.plugins) ?? {};
  const slots = optionalRecord(plugins.slots) ?? {};
  const entries = optionalRecord(plugins.entries) ?? {};
  const alreadyManaged =
    slots.memory === PLUGIN_ID &&
    isContextUseRecallEntry(entries["active-memory"]);

  if (alreadyManaged) {
    const alsoAllow = Array.isArray(tools.alsoAllow)
      ? tools.alsoAllow.filter((name) => name !== ATTACHMENT_TOOL_NAME)
      : undefined;
    return {
      version: 1,
      inferred: true,
      toolsAlsoAllow:
        alsoAllow === undefined
          ? { exists: false }
          : { exists: true, value: alsoAllow },
      memorySlot: { exists: true, value: DEFAULT_MEMORY_SLOT },
      activeMemoryEntry: { exists: false },
    };
  }

  return {
    version: 1,
    inferred: false,
    toolsAlsoAllow: propertySnapshot(tools, "alsoAllow"),
    memorySlot: propertySnapshot(slots, "memory"),
    activeMemoryEntry: propertySnapshot(entries, "active-memory"),
  };
}

export function validateMcpUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid Context-use MCP URL: ${rawUrl}`);
  }
  const isLoopback = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback)) {
    throw new Error("Context-use MCP URL must use HTTPS (HTTP is allowed only for loopback development).");
  }
  return url.toString();
}

export function resolveConfiguredMcpUrl(config) {
  const url = resolveConfiguredMcpServer(config)?.url;
  return typeof url === "string" ? url : undefined;
}

export function resolveConfiguredMcpServer(config) {
  const servers = optionalRecord(optionalRecord(config?.mcp)?.servers);
  return optionalRecord(servers?.[MCP_SERVER_NAME]);
}

export function applyContextUseSetup(config, options = {}) {
  const tools = ensureRecord(config, "tools");
  const alsoAllow = Array.isArray(tools.alsoAllow) ? tools.alsoAllow : [];
  tools.alsoAllow = [...new Set([...alsoAllow, ATTACHMENT_TOOL_NAME])];

  const plugins = ensureRecord(config, "plugins");
  const slots = ensureRecord(plugins, "slots");
  const entries = ensureRecord(plugins, "entries");
  slots.memory = PLUGIN_ID;
  entries[PLUGIN_ID] = mergeEntry(entries[PLUGIN_ID], DEFAULT_PLUGIN_ENTRY);
  entries["active-memory"] = mergeEntry(
    entries["active-memory"],
    DEFAULT_ACTIVE_MEMORY_ENTRY,
  );

  if (options.mcpUrl) {
    const mcp = ensureRecord(config, "mcp");
    const servers = ensureRecord(mcp, "servers");
    const existing = optionalRecord(servers[MCP_SERVER_NAME]) ?? {};
    const next = {
      ...existing,
      url: validateMcpUrl(options.mcpUrl),
      transport: "streamable-http",
      auth: "oauth",
      toolFilter: { include: ["*"] },
      oauthScope: "offline_access mcp:access",
    };
    delete next.command;
    delete next.args;
    delete next.cwd;
    delete next.env;
    servers[MCP_SERVER_NAME] = next;
  }

  return config;
}

export function restorePreviousMemorySetup(config, snapshot) {
  const tools = ensureRecord(config, "tools");
  const plugins = ensureRecord(config, "plugins");
  const slots = ensureRecord(plugins, "slots");
  const entries = ensureRecord(plugins, "entries");

  if (snapshot?.version === 1) {
    restoreProperty(tools, "alsoAllow", snapshot.toolsAlsoAllow);
    restoreProperty(slots, "memory", snapshot.memorySlot);
    restoreProperty(entries, "active-memory", snapshot.activeMemoryEntry);
  } else {
    const alsoAllow = Array.isArray(tools.alsoAllow) ? tools.alsoAllow : [];
    tools.alsoAllow = alsoAllow.filter(
      (name) => name !== ATTACHMENT_TOOL_NAME,
    );
    if (slots.memory === PLUGIN_ID) slots.memory = DEFAULT_MEMORY_SLOT;
    if (isContextUseRecallEntry(entries["active-memory"])) {
      delete entries["active-memory"];
    }
  }

  const entry = optionalRecord(entries[PLUGIN_ID]);
  if (entry) {
    const pluginConfig = optionalRecord(entry.config) ?? {};
    entries[PLUGIN_ID] = {
      ...entry,
      enabled: true,
      config: { ...pluginConfig, captureEnabled: false },
    };
  }
  return config;
}

export function inspectContextUseSetup(config) {
  const tools = optionalRecord(config?.tools) ?? {};
  const plugins = optionalRecord(config?.plugins) ?? {};
  const slots = optionalRecord(plugins.slots) ?? {};
  const entries = optionalRecord(plugins.entries) ?? {};
  const pluginEntry = optionalRecord(entries[PLUGIN_ID]);
  const pluginConfig = optionalRecord(pluginEntry?.config) ?? {};
  const mcpServer = resolveConfiguredMcpServer(config);
  const mcpUrl = resolveConfiguredMcpUrl(config);
  return {
    configured: slots.memory === PLUGIN_ID && isContextUseRecallEntry(entries["active-memory"]),
    memorySlot: slots.memory,
    captureEnabled: pluginConfig.captureEnabled === true,
    attachmentToolAllowed:
      Array.isArray(tools.alsoAllow) &&
      tools.alsoAllow.includes(ATTACHMENT_TOOL_NAME),
    activeRecallConfigured: isContextUseRecallEntry(entries["active-memory"]),
    mcpConfigured: Boolean(mcpServer),
    mcpTransport:
      typeof mcpServer?.url === "string"
        ? mcpServer.transport ?? "streamable-http"
        : typeof mcpServer?.command === "string"
          ? "stdio"
          : undefined,
    mcpUrl,
  };
}
