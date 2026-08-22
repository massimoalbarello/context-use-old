import { describe, expect, test } from "bun:test";
import {
  KNOWLEDGE_PREPARATION_SCOPE,
  summarizeTemplateResult,
  type TemplateResult,
} from "@context-use/shared";
import { renderToStaticMarkup } from "react-dom/server";
import {
  KnowledgePreparationScopeNotice,
  TemplatePlan,
  canApplyTemplateChanges,
  preparationActionLabel,
} from "./KnowledgeTemplate.tsx";

const plan: TemplateResult = {
  template: "default",
  applied: false,
  actions: [
    { action: "create-directory", path: "topics", detail: "Create Topics" },
    { action: "update-guide", path: "agents", detail: "Update untouched template guide" },
    { action: "conflict", path: "people/agents", detail: "Preserve locally modified guide" },
    { action: "unchanged", path: "about/tasks/agents", detail: "Already matches the template" },
  ],
};

describe("knowledge template settings", () => {
  test("summarizes changes and conflicts without counting unchanged entries", () => {
    expect(summarizeTemplateResult(plan)).toEqual({
      changes: 2,
      conflicts: 1,
      unchanged: 1,
      replacements: 0,
    });
  });

  test("renders actionable plan entries and hides unchanged noise", () => {
    const html = renderToStaticMarkup(<TemplatePlan result={plan} />);
    expect(html).toContain("2</strong> changes");
    expect(html).toContain("1</strong> conflict");
    expect(html).toContain("topics");
    expect(html).toContain("people/agents");
    expect(html).not.toContain("about/tasks/agents");
  });

  test("makes forced local replacements explicit", () => {
    const forced: TemplateResult = {
      ...plan,
      actions: [
        { action: "update-directory", path: "people", detail: "Overwrite local directory metadata with the template", replaces_local: true },
        { action: "replace-guide", path: "agents", detail: "Replace eligible template-owned guide", replaces_local: true },
        { action: "conflict", path: "people/agents", detail: "Guide was archived locally" },
      ],
    };
    expect(summarizeTemplateResult(forced).replacements).toBe(2);
    const html = renderToStaticMarkup(<TemplatePlan result={forced} />);
    expect(html).toContain("2</strong> local replacements");
    expect(html).toContain("Guide was archived locally");
  });

  test("reports when the installed template is already current", () => {
    const html = renderToStaticMarkup(<TemplatePlan result={{
      template: "default",
      applied: false,
      actions: [{ action: "unchanged", path: "agents", detail: "Already matches the template" }],
    }} />);
    expect(html).toContain("Template is current");
    expect(html).toContain("matches the default template bundled with this release");
  });

  test("keeps isolated full preparation distinct from dashboard template changes", () => {
    const summary = summarizeTemplateResult({
      template: "default",
      applied: false,
      actions: [{ action: "unchanged", path: "agents", detail: "Already current" }],
    });
    expect(preparationActionLabel(summary, false)).toBe("Apply template changes");
    expect(preparationActionLabel({ ...summary, conflicts: 1 }, false))
      .toBe("Apply template changes");
    expect(canApplyTemplateChanges(summary, false)).toBe(false);
    expect(canApplyTemplateChanges(summary, true)).toBe(true);
    const html = renderToStaticMarkup(
      <KnowledgePreparationScopeNotice scope={KNOWLEDGE_PREPARATION_SCOPE} />,
    );
    expect(html).toContain("isolated deployment one-shot");
    expect(html).toContain("context-use knowledge-template apply");
    expect(html).toContain("hypermedia corpus");
    expect(html).toContain("pinned public revisions remain protected");
    expect(html).not.toContain("preparation completed");
  });
});
