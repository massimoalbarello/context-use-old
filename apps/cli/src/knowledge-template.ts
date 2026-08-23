import { sendSsmCommands } from "./aws.ts";
import { readInfrastructure } from "./lifecycle.ts";

export type KnowledgeTemplateAction = "plan" | "apply";

export function knowledgeTemplateCommands(
  action: KnowledgeTemplateAction,
  templateName = "default",
  forceTemplate = false,
): string[] {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(templateName)) throw new Error(`Invalid template name: ${templateName}`);
  const compose = "docker compose --env-file /data/context-use/secrets/runtime.env";
  if (action === "apply") {
    return [
      "set -euo pipefail",
      "cd /opt/context-use/deploy",
      `CONTEXT_USE_TEMPLATE_INSTALL=${templateName} CONTEXT_USE_FORCE_TEMPLATE=${forceTemplate ? "true" : "false"} ${compose} up --force-recreate --no-deps --abort-on-container-exit --exit-code-from knowledge-prepare knowledge-prepare`,
    ];
  }
  return [
    "set -euo pipefail",
    "cd /opt/context-use/deploy",
    `${compose} exec -T app bun apps/server/src/template-command.ts plan ${templateName}${forceTemplate ? " --force-template" : ""}`,
  ];
}

export async function runKnowledgeTemplateCommand(
  action: KnowledgeTemplateAction,
  options: { forceTemplate?: boolean } = {},
): Promise<string> {
  const { config, compute } = await readInfrastructure();
  if (config.recovery) throw new Error("Volume recovery is in progress; run `context-use recover`");
  if (!compute) throw new Error("No active instance");
  return sendSsmCommands(
    config.awsProfile,
    config.awsRegion,
    compute.instance_id,
    knowledgeTemplateCommands(action, "default", options.forceTemplate),
  );
}
