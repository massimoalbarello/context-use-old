// @ts-expect-error Bun imports Markdown source as text; TypeScript has no text-loader type.
import rootGuide from "../templates/default/AGENTS.md" with { type: "text" };
// @ts-expect-error Bun imports Markdown source as text; TypeScript has no text-loader type.
import activityDistillerInstructions from "../templates/default/_pages/activity-distiller/instructions.md" with { type: "text" };
// @ts-expect-error Bun imports Markdown source as text; TypeScript has no text-loader type.
import activityDistillerState from "../templates/default/_pages/activity-distiller/state.md" with { type: "text" };
// @ts-expect-error Bun imports Markdown source as text; TypeScript has no text-loader type.
import diaryComposerInstructions from "../templates/default/_pages/diary-composer/instructions.md" with { type: "text" };
// @ts-expect-error Bun imports Markdown source as text; TypeScript has no text-loader type.
import diaryComposerState from "../templates/default/_pages/diary-composer/state.md" with { type: "text" };
import directoryMetadata from "../templates/default/directories.json" with { type: "text" };
import pageMetadata from "../templates/default/pages.json" with { type: "text" };
import retirements from "../templates/default/retired.json" with { type: "text" };

/**
 * The shipped production bootstrap contract is statically imported by the
 * application. The source assets remain reviewable, while startup never walks
 * or discovers a knowledge tree from the container filesystem.
 */
export const embeddedDefaultKnowledgeTemplate = {
  name: "default",
  guides: {
    "": rootGuide,
  },
  directoryMetadata: directoryMetadata as unknown as string,
  pageMetadata: pageMetadata as unknown as string,
  pageBodies: {
    "_pages/activity-distiller/instructions.md": activityDistillerInstructions,
    "_pages/activity-distiller/state.md": activityDistillerState,
    "_pages/diary-composer/instructions.md": diaryComposerInstructions,
    "_pages/diary-composer/state.md": diaryComposerState,
  },
  retirements: retirements as unknown as string,
} as const;
