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
  operational_roles: ["automation_instructions"],
  updated_at: "2026-08-24T10:00:00.000Z",
};

describe("automation registry dashboard", () => {
  test("shows registry status and direct hypermedia document links", () => {
    const automations: DashboardAutomation[] = [{
      id: "33333333-3333-4333-8333-333333333333",
      key: "activity-distiller",
      name: "Activity distiller",
      enabled: true,
      updated_at: "2026-08-24T10:00:00.000Z",
      disabled_at: null,
      instructions: document,
      state: { ...document, document_id: "44444444-4444-4444-8444-444444444444", title: "Activity distiller state", operational_roles: ["automation_state"] },
    }];
    const html = renderToStaticMarkup(createElement(AutomationList, {
      automations,
      onOpenDocument: () => undefined,
    }));

    expect(html).toContain("activity-distiller");
    expect(html).toContain("Enabled");
    expect(html).toContain(`context-use://document/${document.document_id}`);
    expect(html).toContain("Activity distiller state");
  });

  test("keeps disabled and stateless registrations visible", () => {
    const html = renderToStaticMarkup(createElement(AutomationList, {
      automations: [{
        id: "33333333-3333-4333-8333-333333333333",
        key: "paused-workflow",
        name: "Paused workflow",
        enabled: false,
        updated_at: "2026-08-24T10:00:00.000Z",
        disabled_at: "2026-08-24T09:00:00.000Z",
        instructions: document,
        state: null,
      }],
      onOpenDocument: () => undefined,
    }));

    expect(html).toContain("Disabled");
    expect(html).toContain("No state document");
  });
});
