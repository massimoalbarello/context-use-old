import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  Settings,
  publicEntrypointOptionLabel,
} from "./Settings.tsx";

test("public entrypoint candidates are identified by title and summary, not a path", () => {
  expect(publicEntrypointOptionLabel({
    public_id: "11111111-1111-4111-8111-111111111111",
    public_title: "Investment thesis",
    public_summary: "Why the portfolio favors durable compounders.",
    public_last_edited_at: "2026-08-23T12:00:00.000Z",
  })).toBe("Investment thesis — Why the portfolio favors durable compounders.");
});

describe("settings", () => {
  test("does not expose the removed knowledge bundle workflow", () => {
    const html = renderToStaticMarkup(createElement(Settings, {
      passkeys: [],
      onPasskeysChanged: async () => undefined,
    }));
    expect(html).not.toContain("Full backup and migration");
    expect(html).not.toContain("Import full bundle");
  });

  test("includes MCP clients without redundant knowledge badges", () => {
    const html = renderToStaticMarkup(createElement(Settings, {
      passkeys: [],
      onPasskeysChanged: async () => undefined,
    }));
    expect(html).toContain("MCP clients");
    expect(html).toContain("Private server URL");
    expect(html).toContain("Connected clients");
    expect(html).not.toContain("mcp-access-badge");
  });

});
