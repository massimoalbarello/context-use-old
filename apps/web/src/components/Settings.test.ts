import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  formatExportBytes,
  KnowledgeExportPreparationStatus,
  Settings,
  publicEntrypointOptionLabel,
  storedExportJob,
  type KnowledgeExportJob,
} from "./Settings.tsx";

const processing: KnowledgeExportJob = {
  intentId: "11111111-1111-4111-8111-111111111111",
  status: "processing",
  downloadUrl: "/api/dashboard/knowledge-exports/11111111-1111-4111-8111-111111111111/download",
};

const noop = () => undefined;

test("public entrypoint candidates are identified by title and summary, not a path", () => {
  expect(publicEntrypointOptionLabel({
    public_id: "11111111-1111-4111-8111-111111111111",
    public_title: "Investment thesis",
    public_summary: "Why the portfolio favors durable compounders.",
    public_last_edited_at: "2026-08-23T12:00:00.000Z",
  })).toBe("Investment thesis — Why the portfolio favors durable compounders.");
});

describe("knowledge export settings", () => {
  test("formats the current export size for passkey review", () => {
    expect(formatExportBytes(0)).toBe("0 B");
    expect(formatExportBytes(1024)).toBe("1.00 KB");
    expect(formatExportBytes(5_000_000_000)).toBe("4.66 GB");
  });

  test("recovers a confirmed export after Settings is remounted", () => {
    const intentId = "11111111-1111-4111-8111-111111111111";
    const recovered = storedExportJob({
      getItem: () => JSON.stringify({ intentId }),
    });
    expect(recovered).toEqual({
      intentId,
      status: "processing",
      downloadUrl: `/api/dashboard/knowledge-exports/${intentId}/download`,
    });
    expect(storedExportJob({ getItem: () => "not json" })).toBeNull();
    expect(storedExportJob({ getItem: () => JSON.stringify({ intentId, reset: true }) })).toBeNull();
  });

  test("exposes logical full-bundle export and import without legacy reset controls", () => {
    const html = renderToStaticMarkup(createElement(Settings, {
      passkeys: [],
      onPasskeysChanged: async () => undefined,
    }));
    expect(html).toContain("Full backup and migration");
    expect(html).toContain("Import full bundle");
    expect(html).toContain('type="file"');
    expect(html).toContain("Original UUIDs are retained");
    expect(html).toContain("independent of the current SQL schema");
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

  test("shows explicit processing feedback without exposing a premature download", () => {
    const html = renderToStaticMarkup(KnowledgeExportPreparationStatus({
      job: processing,
      onDownload: noop,
      onReset: noop,
    }));
    expect(html).toContain("Preparing latest snapshot");
    expect(html).toContain("leave Settings and return");
    expect(html).toContain('role="status"');
    expect(html).not.toContain("Download archive");
  });

  test("reveals the resumable download link only when the archive is ready", () => {
    const html = renderToStaticMarkup(KnowledgeExportPreparationStatus({
      job: {
        ...processing,
        status: "ready",
        filename: "context-use-export-2026-08-13.zip",
        sizeBytes: 5_000_000_000,
      },
      onDownload: noop,
      onReset: noop,
    }));
    expect(html).toContain("Archive ready to download");
    expect(html).toContain("context-use-export-2026-08-13.zip · 4.66 GB");
    expect(html).toContain(`href="${processing.downloadUrl}"`);
    expect(html).toContain("Download archive");
  });
});
