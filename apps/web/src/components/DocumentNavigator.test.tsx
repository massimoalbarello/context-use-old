import { describe, expect, test } from "bun:test";
import type { DashboardDocumentSummary } from "@context-use/shared";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DocumentDetails } from "./DocumentDetails.tsx";
import { NewKnowledgeDocument } from "./NewKnowledgeDocument.tsx";
import {
  DocumentNavigator,
  documentCatalogUrl,
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
  operational_roles: ["automation_instructions"],
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
      selectedId: null,
      refreshToken: 0,
      onCreate: () => undefined,
      onSelect: () => undefined,
    }));
    expect(html).toContain("Recently updated");
    expect(html).toContain("Pages");
    expect(html).toContain("Assets");
    expect(html).toContain("Records");
    expect(html).toContain("Archived");
    expect(html).toContain("New page");
    expect(html).not.toContain("folder");
  });

  test("scopes search to the selected document type", () => {
    expect(documentCatalogUrl("quarterly plan", "knowledge"))
      .toBe("/api/dashboard/documents?limit=40&q=quarterly+plan&kind=knowledge");
    expect(documentCatalogUrl("quarterly plan", "record"))
      .toBe("/api/dashboard/documents?limit=40&q=quarterly+plan&kind=record");
    expect(documentCatalogUrl("quarterly plan", "archived"))
      .toBe("/api/dashboard/documents?limit=40&q=quarterly+plan&lifecycle=archived");
  });

  test("creates documents without asking for a directory or path", () => {
    const html = renderToStaticMarkup(createElement(NewKnowledgeDocument, {
      onCancel: () => undefined,
      onCreated: () => undefined,
    }));
    expect(html).toContain("Create a standalone document");
    expect(html).toContain("Title");
    expect(html).toContain("Summary");
    expect(html).toContain("context-use://document/&lt;uuid&gt;");
    expect(html).not.toContain("name=\"path\"");
    expect(html.toLowerCase()).not.toContain("folder");
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
