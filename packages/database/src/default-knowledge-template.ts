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

export type HypermediaBootstrapTemplateDocument = {
  title: string;
  summary: string;
  body_markdown: string;
};

export type HypermediaBootstrapTemplate = {
  name: "default";
  documents: {
    global_guide: HypermediaBootstrapTemplateDocument;
    activity_distiller_instructions: HypermediaBootstrapTemplateDocument;
    activity_distiller_state: HypermediaBootstrapTemplateDocument;
    diary_composer_instructions: HypermediaBootstrapTemplateDocument;
    diary_composer_state: HypermediaBootstrapTemplateDocument;
  };
  automations: readonly [{
    key: "activity-distiller";
    name: "Activity distiller";
    instructions: "activity_distiller_instructions";
    state: "activity_distiller_state";
  }, {
    key: "diary-composer";
    name: "Diary composer";
    instructions: "diary_composer_instructions";
    state: "diary_composer_state";
  }];
};

function markdown(source: string): string {
  return source.trimEnd() + "\n";
}

/**
 * The only installation template is a compile-time hypermedia document set.
 * It has no directory tree, path resolver, filesystem discovery, or runtime
 * template selector.
 */
export const defaultHypermediaBootstrapTemplate: HypermediaBootstrapTemplate = {
  name: "default",
  documents: {
    global_guide: {
      title: "AGENTS.md",
      summary: "The global instructions for maintaining this knowledge base.",
      body_markdown: markdown(rootGuide),
    },
    activity_distiller_instructions: {
      title: "Activity distiller",
      summary: "Instructions for reconciling connected activity one record at a time into maintained, linked hypermedia knowledge.",
      body_markdown: markdown(activityDistillerInstructions),
    },
    activity_distiller_state: {
      title: "Activity distiller state",
      summary: "The current opaque source checkpoint for the activity distiller.",
      body_markdown: markdown(activityDistillerState),
    },
    diary_composer_instructions: {
      title: "Diary composer",
      summary: "Instructions for selecting diary-worthy activity deltas and composing them into connected prose within the knowledge neighborhood.",
      body_markdown: markdown(diaryComposerInstructions),
    },
    diary_composer_state: {
      title: "Diary composer state",
      summary: "The current opaque change-ledger checkpoint for the diary composer.",
      body_markdown: markdown(diaryComposerState),
    },
  },
  automations: [{
    key: "activity-distiller",
    name: "Activity distiller",
    instructions: "activity_distiller_instructions",
    state: "activity_distiller_state",
  }, {
    key: "diary-composer",
    name: "Diary composer",
    instructions: "diary_composer_instructions",
    state: "diary_composer_state",
  }],
};
