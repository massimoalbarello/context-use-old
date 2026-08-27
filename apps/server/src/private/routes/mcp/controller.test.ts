import { describe, expect, test } from "bun:test";
import type { KnowledgeSettingsRepository, ObjectLinkRepository } from "@context-use/database";
import { Elysia } from "elysia";
import { createMcpService } from "#private/services/mcp/mcp-service.ts";
import type { McpObjectRepositories } from "#private/services/mcp/server.ts";
import { createMcpController } from "./controller.ts";

const appOrigin = "http://localhost:3000";
const resource = `${appOrigin}/mcp`;

function toolListRequest({ endpoint, token }: { endpoint: string; token: string }): Request {
  return new Request(endpoint, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "mcp-protocol-version": "2025-06-18",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
}

describe("MCP audience binding", () => {
  test("serves MCP only after the auth service returns a live principal", async () => {
    const app = testApp(async (token) =>
      token === "authorized-token-that-is-long-enough"
        ? {
            state: "authorized" as const,
            clientId: "profile-test-client",
            sessionId: "profile-test-session",
          }
        : { state: "unauthorized" as const },
    );

    const knowledgeResponse = await app.handle(
      toolListRequest({ endpoint: resource, token: "authorized-token-that-is-long-enough" }),
    );
    expect(knowledgeResponse.status).toBe(200);

    const knowledgeTools = (
      (await knowledgeResponse.json()) as {
        result: { tools: Array<{ name: string }> };
      }
    ).result.tools.map(({ name }) => name);
    expect(knowledgeTools).toContain("create_page");
    expect(knowledgeTools.some((name) => name.includes("automation"))).toBe(false);

    expect(
      (await app.handle(toolListRequest({ endpoint: resource, token: "wrong-audience-token" })))
        .status,
    ).toBe(401);
  });

  test("rejects a signed MCP token when the auth service reports it inactive", async () => {
    const app = testApp(async () => ({ state: "unauthorized" as const }));
    expect(
      (await app.handle(toolListRequest({ endpoint: resource, token: "inactive-token" }))).status,
    ).toBe(401);
  });
});

function testApp(
  authorizeMcpBearer: (
    token: string,
  ) => Promise<
    { state: "authorized"; clientId: string; sessionId: string } | { state: "unauthorized" }
  >,
) {
  const handleMcp = createMcpService({
    sourceRecords: undefined,
    recordObjects: undefined,
    knowledgeSettings: {} as KnowledgeSettingsRepository,
    objectLinks: {} as ObjectLinkRepository,
    objects: {} as McpObjectRepositories,
    appOrigin,
    capabilitySecret: "test-capability-secret-that-is-long-enough",
  });
  return new Elysia().use(
    createMcpController({
      appOrigin,
      authorizationIssuer: appOrigin,
      authorization: { authorizeMcpBearer },
      resource,
      handleMcp,
      upload: () => new Response(null, { status: 501 }),
      download: () => new Response(null, { status: 501 }),
    }),
  );
}
