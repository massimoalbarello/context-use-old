import { describe, expect, test } from "bun:test";
import {
  ATTACHMENT_TOOL_NAME,
  DEFAULT_MEMORY_SLOT,
  PLUGIN_ID,
  RECALL_TOOL_NAMES,
  applyContextUseSetup,
  createInstallSnapshot,
  inspectContextUseSetup,
  restorePreviousMemorySetup,
  validateMcpUrl,
} from "./setup.js";

describe("Context-use OpenClaw setup", () => {
  test("configures the complete memory integration in one mutation", () => {
    const config = {
      tools: { alsoAllow: ["existing_tool"] },
      plugins: {
        slots: { memory: "memory-core" },
        entries: {
          "context-use-memory": {
            config: {
              allowedUploadOrigins: ["https://memory.example"],
            },
          },
        },
      },
    };

    applyContextUseSetup(config, {
      mcpUrl: "https://memory.example/mcp",
    });

    expect(config.plugins.slots.memory).toBe(PLUGIN_ID);
    expect(config.tools.alsoAllow).toEqual([
      "existing_tool",
      ATTACHMENT_TOOL_NAME,
    ]);
    expect(
      config.plugins.entries[PLUGIN_ID].config.allowedUploadOrigins,
    ).toEqual(["https://memory.example"]);
    expect(config.plugins.entries[PLUGIN_ID].config.captureEnabled).toBe(true);
    expect(
      config.plugins.entries["active-memory"].config.toolsAllow,
    ).toEqual(RECALL_TOOL_NAMES);
    expect(config.mcp.servers["context-use"]).toMatchObject({
      url: "https://memory.example/mcp",
      transport: "streamable-http",
      auth: "oauth",
      oauthScope: "offline_access mcp:access",
      toolFilter: { include: ["*"] },
    });
    expect(inspectContextUseSetup(config)).toMatchObject({
      configured: true,
      captureEnabled: true,
      attachmentToolAllowed: true,
      activeRecallConfigured: true,
      mcpConfigured: true,
    });
  });

  test("setup is idempotent", () => {
    const config = {};
    applyContextUseSetup(config, { mcpUrl: "https://memory.example/mcp" });
    applyContextUseSetup(config, { mcpUrl: "https://memory.example/mcp" });
    expect(
      config.tools.alsoAllow.filter(
        (name) => name === ATTACHMENT_TOOL_NAME,
      ),
    ).toHaveLength(1);
  });

  test("recognizes an existing stdio MCP bridge", () => {
    const config = {
      mcp: {
        servers: {
          "context-use": {
            command: "node",
            args: ["context-use-mcp-bridge.mjs"],
          },
        },
      },
    };
    applyContextUseSetup(config);
    expect(inspectContextUseSetup(config)).toMatchObject({
      configured: true,
      mcpConfigured: true,
      mcpTransport: "stdio",
    });
    expect(config.mcp.servers["context-use"].command).toBe("node");
  });

  test("restores the exact previous memory configuration", () => {
    const previousActiveMemory = {
      enabled: true,
      config: { enabled: true, mode: "escalate" },
    };
    const config = {
      tools: { alsoAllow: ["existing_tool"] },
      plugins: {
        slots: { memory: "custom-memory" },
        entries: { "active-memory": previousActiveMemory },
      },
    };
    const snapshot = createInstallSnapshot(config);

    applyContextUseSetup(config, { mcpUrl: "https://memory.example/mcp" });
    restorePreviousMemorySetup(config, snapshot);

    expect(config.tools.alsoAllow).toEqual(["existing_tool"]);
    expect(config.plugins.slots.memory).toBe("custom-memory");
    expect(config.plugins.entries["active-memory"]).toEqual(
      previousActiveMemory,
    );
    expect(config.plugins.entries[PLUGIN_ID].config.captureEnabled).toBe(false);
  });

  test("infers a safe baseline for an existing manual installation", () => {
    const config = {};
    applyContextUseSetup(config, { mcpUrl: "https://memory.example/mcp" });
    const snapshot = createInstallSnapshot(config);
    expect(snapshot.inferred).toBe(true);

    restorePreviousMemorySetup(config, snapshot);
    expect(config.plugins.slots.memory).toBe(DEFAULT_MEMORY_SLOT);
    expect(config.plugins.entries["active-memory"]).toBeUndefined();
    expect(config.tools.alsoAllow).not.toContain(ATTACHMENT_TOOL_NAME);
  });

  test("accepts HTTPS and loopback development MCP URLs only", () => {
    expect(validateMcpUrl("https://memory.example/mcp")).toBe(
      "https://memory.example/mcp",
    );
    expect(validateMcpUrl("http://127.0.0.1:3000/mcp")).toBe(
      "http://127.0.0.1:3000/mcp",
    );
    expect(() => validateMcpUrl("http://memory.example/mcp")).toThrow();
  });
});
