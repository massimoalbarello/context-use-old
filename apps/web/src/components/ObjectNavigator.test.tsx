import { describe, expect, test } from "bun:test";
import type { DashboardObjectSummary } from "@context-use/shared";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ObjectDetails } from "./ObjectDetails.tsx";
import { EntityIdentity } from "./EntityType.tsx";
import { NewPage } from "./NewPage.tsx";
import {
  ObjectNavigator,
  objectCatalogUrl,
  objectDisplaySummary,
  objectDisplayTitle,
} from "./ObjectNavigator.tsx";

const document: DashboardObjectSummary = {
  object_id: "11111111-1111-4111-8111-111111111111",
  object_kind: "page",
  authority: "knowledge",
  representation: "markdown",
  lifecycle: "active",
  current_revision_id: "22222222-2222-4222-8222-222222222222",
  entity_type: null,
  title: "Investment notes",
  summary: "A concise summary of the current investment thesis.",
  filename: null,
  content_type: null,
  integration: null,
  source_model: null,
  operational_roles: ["automation_instructions"],
  updated_at: "2026-08-23T10:00:00.000Z",
};

describe("search-first object navigation", () => {
  test("uses page titles and summaries as the primary result preview", () => {
    expect(objectDisplayTitle(document)).toBe("Investment notes");
    expect(objectDisplaySummary(document)).toBe(
      "A concise summary of the current investment thesis.",
    );
    expect(objectDisplayTitle({ ...document, title: null, filename: "report.pdf" }))
      .toBe("report.pdf");
    expect(objectDisplaySummary({
      ...document,
      object_kind: "asset",
      title: null,
      summary: null,
      filename: "report.pdf",
      content_type: "application/pdf",
    })).toBe("Asset · application/pdf");
    expect(objectDisplayTitle({
      ...document,
      object_kind: "record",
      authority: "source",
      title: null,
      integration: "github",
      source_model: "GitHubPullRequest",
    })).toBe("Git Hub Pull Request");
    expect(objectDisplaySummary({
      ...document,
      object_kind: "record",
      authority: "source",
      summary: null,
      integration: "github",
      source_model: "GitHubPullRequest",
    })).toBe("Connected source · github");
  });

  test("renders a recent-object navigator before a query is entered", () => {
    const html = renderToStaticMarkup(createElement(ObjectNavigator, {
      query: "",
      selectedId: null,
      refreshToken: 0,
      onSelect: () => undefined,
    }));
    expect(html).toContain("Recently updated");
    expect(html).toContain("All types");
    expect(html).not.toContain("New page");
    expect(html).not.toContain("folder");
  });

  test("scopes search to one or more selected object types", () => {
    expect(objectCatalogUrl("quarterly plan", ["page"]))
      .toBe("/api/dashboard/objects?limit=40&q=quarterly+plan&types=page");
    expect(objectCatalogUrl("quarterly plan", ["record", "public"]))
      .toBe("/api/dashboard/objects?limit=40&q=quarterly+plan&types=record%2Cpublic");
    expect(objectCatalogUrl("quarterly plan", ["public", "archived"]))
      .toBe("/api/dashboard/objects?limit=40&q=quarterly+plan&types=public%2Carchived");
    expect(objectCatalogUrl("quarterly plan", ["page"], undefined, ["person", "place"]))
      .toBe("/api/dashboard/objects?limit=40&q=quarterly+plan&types=page&entities=person%2Cplace");
  });

  test("creates pages without asking for a directory or path", () => {
    const html = renderToStaticMarkup(createElement(NewPage, {
      onCancel: () => undefined,
      onCreated: () => undefined,
    }));
    expect(html).toContain("Create a standalone page");
    expect(html).toContain("Title");
    expect(html).toContain("Summary");
    expect(html).toContain("Entity type");
    expect(html).toContain("None — ordinary page");
    expect(html).toContain("Organization");
    expect(html).toContain("context-use://object/&lt;uuid&gt;");
    expect(html).not.toContain("name=\"path\"");
    expect(html.toLowerCase()).not.toContain("folder");
  });

  test("renders a legible entity identity with the shared label and icon", () => {
    const html = renderToStaticMarkup(createElement(EntityIdentity, { type: "place" }));
    expect(html).toContain("entity-identity entity-place");
    expect(html).toContain("Place");
    expect(html).toContain("<svg");
  });

  test("fallback object details expose stable references and titles", () => {
    const html = renderToStaticMarkup(createElement(ObjectDetails, { object: document }));
    expect(html).toContain("Investment notes");
    expect(html).toContain("A concise summary of the current investment thesis.");
    expect(html).toContain(`context-use://object/${document.object_id}`);
    expect(html).not.toContain("Path");
  });
});
