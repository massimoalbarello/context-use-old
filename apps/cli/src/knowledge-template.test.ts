import { expect, test } from "bun:test";
import { knowledgeTemplateCommands } from "./knowledge-template.ts";

test("template commands use the installed application image without updating the deployment", () => {
  expect(knowledgeTemplateCommands("plan")).toEqual([
    "set -euo pipefail",
    "cd /opt/context-use/deploy",
    "docker compose --env-file /data/context-use/secrets/runtime.env exec -T app bun apps/server/src/template-command.ts plan default",
  ]);
  const apply = knowledgeTemplateCommands("apply").join("\n");
  expect(apply).toContain("CONTEXT_USE_TEMPLATE_INSTALL=default");
  expect(apply).toContain("CONTEXT_USE_FORCE_TEMPLATE=false");
  expect(apply).toContain("--force-recreate --no-deps --abort-on-container-exit");
  expect(apply).toContain("--exit-code-from knowledge-prepare knowledge-prepare");
  expect(apply).not.toContain(" exec ");
  expect(apply).not.toContain(" app ");
  expect(apply).not.toContain("template-command.ts");
  expect(knowledgeTemplateCommands("apply", "default", true).at(-1))
    .toContain("CONTEXT_USE_FORCE_TEMPLATE=true");
  expect(() => knowledgeTemplateCommands("apply", "../other")).toThrow("Invalid template name");
});
