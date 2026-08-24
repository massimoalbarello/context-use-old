import { describe, expect, test } from "bun:test";
import type { DashboardDocumentSummary } from "@context-use/shared";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AutomationList, type DashboardAutomation } from "./Automations.tsx";

const document: DashboardDocumentSummary = {
  document_id: "11111111-1111-4111-8111-111111111111",
  document_kind: "knowledge",
  authority: "knowledge",
  representation: "markdown",
  lifecycle: "active",
  current_revision_id: "22222222-2222-4222-8222-222222222222",
  title: "Activity distiller",
  summary: "Reconcile connected activity into linked knowledge.",
  filename: null,
  content_type: null,
  integration: null,
  source_model: null,
  operational_roles: ["automation_instructions"],
  updated_at: "2026-08-24T10:00:00.000Z",
};

describe("automation registry dashboard", () => {
  test("lists automations with a way to view their instructions", () => {
    const automations: DashboardAutomation[] = [{
      id: "33333333-3333-4333-8333-333333333333",
      name: "Activity distiller",
      instructions: document,
    }];
    const html = renderToStaticMarkup(createElement(AutomationList, {
      automations,
      onOpenDocument: () => undefined,
    }));

    expect(html).toContain("Activity distiller");
    expect(html).toContain("View instructions");
    expect(html).toContain("Reconcile connected activity into linked knowledge.");
  });

  test("keeps an automation visible when its instruction page is unavailable", () => {
    const html = renderToStaticMarkup(createElement(AutomationList, {
      automations: [{
        id: "33333333-3333-4333-8333-333333333333",
        name: "Paused workflow",
        instructions: null,
      }],
      onOpenDocument: () => undefined,
    }));

    expect(html).toContain("Paused workflow");
    expect(html).toContain("Instruction page unavailable");
  });
});
