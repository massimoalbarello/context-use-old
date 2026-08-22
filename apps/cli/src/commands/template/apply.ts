import * as p from "@clack/prompts";
import { defineCommand } from "@parshjs/core";
import { z } from "zod";
import { runKnowledgeTemplateCommand } from "../../knowledge-template.ts";

export const command = defineCommand("template apply", {
  description: "Run isolated template, operational-document, and corpus preparation.",
  options: {
    "force-template": {
      schema: z.boolean().optional(),
      description: "Replace eligible template-owned directory metadata and managed pages; preserve owner-authored guides and control documents.",
    },
  },
  handler: async ({ options }) => {
    const output = (await runKnowledgeTemplateCommand("apply", {
      forceTemplate: options["force-template"] ?? false,
    })).trim();
    p.note(output || "Knowledge preparation completed", "Knowledge prepared");
  },
});
