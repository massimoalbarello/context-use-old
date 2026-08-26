import { diffLines, type Change } from "diff";
import type { PageEntityType } from "@context-use/shared";

export type DocumentRevisionForDelta = {
  title: string;
  summary: string;
  entity_type: PageEntityType | null;
  body_markdown: string;
};

export type DocumentMetadataChange = {
  field: "title" | "summary" | "entity_type";
  before: string | null;
  after: string | null;
};

export type MarkdownChange = {
  before: string;
  after: string;
};

function lineDiff(oldMarkdown: string, newMarkdown: string): Promise<Change[]> {
  return new Promise((resolve) => {
    diffLines(oldMarkdown, newMarkdown, { callback: resolve });
  });
}

export async function markdownChanges(
  oldMarkdown: string,
  newMarkdown: string,
): Promise<MarkdownChange[]> {
  const parts = await lineDiff(oldMarkdown, newMarkdown);
  const changes: MarkdownChange[] = [];
  let current: MarkdownChange | undefined;

  const finishCurrent = () => {
    if (!current) return;
    changes.push(current);
    current = undefined;
  };

  for (const part of parts) {
    if (!part.added && !part.removed) {
      finishCurrent();
      continue;
    }

    current ??= {
      before: "",
      after: "",
    };

    if (part.removed) {
      current.before += part.value;
    } else {
      current.after += part.value;
    }
  }
  finishCurrent();
  return changes;
}

export async function pageDelta(
  previous: DocumentRevisionForDelta | null,
  current: DocumentRevisionForDelta,
): Promise<{ metadata_changes: DocumentMetadataChange[]; markdown_changes: MarkdownChange[] }> {
  const metadataChanges: DocumentMetadataChange[] = [];
  for (const field of ["title", "summary", "entity_type"] as const) {
    const before = previous?.[field] ?? null;
    if (before !== current[field]) {
      metadataChanges.push({ field, before, after: current[field] });
    }
  }
  return {
    metadata_changes: metadataChanges,
    markdown_changes: await markdownChanges(previous?.body_markdown ?? "", current.body_markdown),
  };
}
