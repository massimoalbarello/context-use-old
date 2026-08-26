import { describe, expect, test } from "bun:test";
import { defaultHypermediaBootstrapTemplate } from "./default-knowledge-template.ts";

describe("default knowledge entity and linking contract", () => {
  const guide = defaultHypermediaBootstrapTemplate.pages.global_guide.body_markdown;
  const distiller = defaultHypermediaBootstrapTemplate.pages
    .activity_distiller_instructions.body_markdown;

  test("keeps the bounded entity-anchor invariant in the root guide", () => {
    expect(guide).toContain("`person`, `organization`, `place`, `event`");
    expect(guide).toContain("single canonical introductory page");
    expect(guide).toContain("Projects, ongoing efforts, tasks and preparations remain ordinary");
    expect(guide).toContain("#heading-slug");
    expect(guide).toContain("search active\nknowledge for all plausible earlier mentions");
    expect(guide).toContain("ordinary page tools");
  });

  test("has the distiller apply the root contract without copying it", () => {
    expect(distiller).toContain("global guide's entity-anchor and link-completeness rules");
    expect(distiller).toContain("confidently resolved plain-text mention");
    expect(distiller).not.toContain("`person`, `organization`, `place`, `event`");
    expect(distiller).not.toContain("single canonical introductory page");
  });
});
