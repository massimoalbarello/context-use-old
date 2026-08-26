import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SourceRecordPage } from "../types.ts";
import {
  SourceRecord,
  SourceRecordContents,
  sourceRecordPageUrl,
} from "./SourceRecord.tsx";

const record: SourceRecordPage = {
  id: "11111111-1111-4111-8111-111111111111",
  current_version_id: "22222222-2222-4222-8222-222222222222",
  version_number: 3,
  integration: "granola",
  model: "GranolaMeeting",
  source_updated_at: "2026-08-23T10:00:00.000Z",
  deleted_at: null,
  rendered_html: "<h1 id=\"product-review\">Product review</h1><p>Decisions and notes.</p>",
};

describe("source record page", () => {
  test("loads the canonical dashboard source-record representation", () => {
    expect(sourceRecordPageUrl("11111111-1111-4111-8111-111111111111"))
      .toBe("/api/dashboard/source-records/11111111-1111-4111-8111-111111111111");
  });

  test("starts with a page-shaped loading state", () => {
    const html = renderToStaticMarkup(createElement(SourceRecord, {
      objectId: "11111111-1111-4111-8111-111111111111",
    }));
    expect(html).toContain("Loading source record");
    expect(html).not.toContain("Private reference");
    expect(html).not.toContain("Representation");
  });

  test("shows rendered Markdown as a read-only page instead of a metadata card", () => {
    const html = renderToStaticMarkup(createElement(SourceRecordContents, {
      record,
      onArchive: () => undefined,
    }));
    expect(html).toContain("Connected source · Content read-only");
    expect(html).toContain("granola · Granola Meeting");
    expect(html).toContain("Product review");
    expect(html).toContain("Decisions and notes.");
    expect(html).toContain("class=\"rendered\"");
    expect(html).not.toContain("Private reference");
    expect(html).not.toContain("Representation");
    expect(html).toContain("Archive</button>");
    expect(html).not.toContain("Delete permanently");
  });

  test("offers permanent deletion only after a record is archived", () => {
    const html = renderToStaticMarkup(createElement(SourceRecordContents, {
      record: { ...record, deleted_at: "2026-08-26T10:00:00.000Z" },
      onDelete: () => undefined,
    }));
    expect(html).toContain("Archived");
    expect(html).toContain("Delete permanently");
    expect(html).not.toContain(">Archive</button>");
  });
});
