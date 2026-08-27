import type { KnowledgeSettingsRepository } from "@context-use/database";
import { z } from "zod";
import type { GuidancePolicy, McpContext } from "./contracts.ts";
import { verifyKnowledgeGuideReceipt } from "./guidance-receipt.ts";
import { textContent } from "./tool-content.ts";

export const knowledgeSessionReceiptSchema = z
  .string()
  .min(1)
  .max(8_192)
  .optional()
  .describe(
    "Receipt from begin_knowledge_session. Reuse it across every target in this authenticated session until the configured global guide changes. Never store receipts in knowledge.",
  );

export const mutationReceiptSchemas = {
  knowledge_session_receipt: knowledgeSessionReceiptSchema,
};

export function createGuidancePolicy(input: {
  settings: KnowledgeSettingsRepository;
  context: McpContext;
  capabilitySecret: string;
}): GuidancePolicy {
  return {
    async hasCurrentGuidance(receipt) {
      const guide = await input.settings.globalGuide();
      if (!guide || receipt === undefined) {
        return false;
      }
      return verifyKnowledgeGuideReceipt(
        receipt,
        {
          pageId: guide.document_id,
          revisionId: guide.current_revision_id,
        },
        input.context,
        input.capabilitySecret,
      );
    },
    required(retryTool) {
      return textContent(
        [
          "KNOWLEDGE_GUIDE_REQUIRED",
          "Call begin_knowledge_session with {}, read the returned configured global guide, and retry with its knowledge_session_receipt.",
          `Then retry ${retryTool}.`,
        ].join("\n\n"),
        true,
      );
    },
  };
}
