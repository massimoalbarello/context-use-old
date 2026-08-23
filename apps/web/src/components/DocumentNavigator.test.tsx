import { describe, expect, test } from "bun:test";
import type { DashboardDocumentSummary } from "@context-use/shared";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DocumentDetails } from "./DocumentDetails.tsx";
import {
  DocumentNavigator,
  documentDisplaySummary,
  documentDisplayTitle,
} from "./DocumentNavigator.tsx";

const document: DashboardDocumentSummary = {
  document_id: "11111111-1111-4111-8111-111111111111",
  document_kind: "knowledge",
  authority: "knowledge",
  representation: "markdown",
  lifecycle: "active",
  current_revision_id: "22222222-2222-4222-8222-222222222222",
  title: "Investment notes",
  summary: "A concise summary of the current investment thesis.",
  filename: null,
  content_type: null,
  operational_roles: ["directory_hub"],
  updated_at: "2026-08-23T10:00:00.000Z",
};

describe("search-first document navigation", () => {
  test("uses page titles and summaries as the primary result preview", () => {
    expect(documentDisplayTitle(document)).toBe("Investment notes");
    expect(documentDisplaySummary(document)).toBe(
      "A concise summary of the current investment thesis.",
    );
    expect(documentDisplayTitle({ ...document, title: null, filename: "report.pdf" }))
      .toBe("report.pdf");
    expect(documentDisplaySummary({
      ...document,
      document_kind: "asset",
      title: null,
      summary: null,
      filename: "report.pdf",
      content_type: "application/pdf",
    })).toBe("Asset · application/pdf");
  });

  test("renders a recent-document navigator before a query is entered", () => {
    const html = renderToStaticMarkup(createElement(DocumentNavigator, {
      query: "",
      includeRetired: false,
      selectedId: null,
      refreshToken: 0,
      onSelect: () => undefined,
    }));
    expect(html).toContain("Recently updated");
    expect(html).toContain("Pages");
    expect(html).toContain("Assets");
    expect(html).not.toContain("folder");
  });

  test("fallback document details expose stable references without filesystem labels", () => {
    const html = renderToStaticMarkup(createElement(DocumentDetails, { document }));
    expect(html).toContain("Investment notes");
    expect(html).toContain("A concise summary of the current investment thesis.");
    expect(html).toContain(`context-use://document/${document.document_id}`);
    expect(html).not.toContain("Path");
    expect(html).not.toContain("current_path");
  });
});
