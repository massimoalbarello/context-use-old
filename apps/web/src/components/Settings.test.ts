import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  formatExportBytes,
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

describe("knowledge bundle settings", () => {
  test("formats the current export size for passkey review", () => {
    expect(formatExportBytes(0)).toBe("0 B");
    expect(formatExportBytes(1024)).toBe("1.00 KB");
    expect(formatExportBytes(5_000_000_000)).toBe("4.66 GB");
  });

  test("exposes logical full-bundle export and import without the legacy portable export", () => {
    const html = renderToStaticMarkup(createElement(Settings, {
      passkeys: [],
      onPasskeysChanged: async () => undefined,
    }));
    expect(html).toContain("Full backup and migration");
    expect(html).toContain("Import full bundle");
    expect(html).toContain('type="file"');
    expect(html).toContain("Original UUIDs are retained");
    expect(html).toContain("independent of the current SQL schema");
    expect(html).not.toContain("Export knowledge");
    expect(html).not.toContain("Markdown vault");
    expect(html).not.toContain("Knowledge template");
    expect(html).not.toContain("Clear knowledge base");
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
