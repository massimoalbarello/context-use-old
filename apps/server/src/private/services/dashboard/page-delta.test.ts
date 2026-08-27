import { describe, expect, test } from "bun:test";
import { markdownChanges, pageDelta } from "#private/services/dashboard/page-delta.ts";

describe("page delta", () => {
  test("isolates a one-word edit without returning unchanged paragraphs or duplicate representations", async () => {
    const before = [
      "# Project\n",
      "\n",
      "The first paragraph remains unchanged.\n",
      "\n",
      "We agreed to meet on Tuesday.\n",
      "\n",
      "The last paragraph remains unchanged.\n",
    ].join("");
    const after = before.replace("Tuesday", "Wednesday");

    const changes = await markdownChanges(before, after);

    expect(changes).toEqual([
      {
        before: "We agreed to meet on Tuesday.\n",
        after: "We agreed to meet on Wednesday.\n",
      },
    ]);
    expect(JSON.stringify(changes)).not.toContain("first paragraph");
    expect(JSON.stringify(changes)).not.toContain("last paragraph");
    expect(Object.keys(changes[0] ?? {})).toEqual(["before", "after"]);
  });

  test("returns several distant Markdown edits as separate clean fragments", async () => {
    const before = [
      "# A busy day\n",
      "\n",
      "The opening remains unchanged.\n",
      "\n",
      "## Work\n",
      "\n",
      "The draft was reviewed.\n",
      "\n",
      "The bridge remains unchanged.\n",
      "\n",
      "## Evening\n",
      "\n",
      "Walked home.\n",
      "\n",
      "The ending remains unchanged.\n",
    ].join("");
    const after = before
      .replace("The draft was reviewed.", "The pull request was reviewed.")
      .replace("Walked home.", "Walked home with Ada.\nPrepared tomorrow's notes.");

    const changes = await markdownChanges(before, after);

    expect(changes).toEqual([
      {
        before: "The draft was reviewed.\n",
        after: "The pull request was reviewed.\n",
      },
      {
        before: "Walked home.\n",
        after: "Walked home with Ada.\nPrepared tomorrow's notes.\n",
      },
    ]);
    const output = JSON.stringify(changes);
    expect(output).not.toContain("opening remains");
    expect(output).not.toContain("bridge remains");
    expect(output).not.toContain("ending remains");
  });

  test.each([
    ["new-page insertion", "", "new page\n", [{ before: "", after: "new page\n" }]],
    ["whole-page deletion", "delete me\n", "", [{ before: "delete me\n", after: "" }]],
    ["final newline", "a\nb", "a\nb\n", [{ before: "b", after: "b\n" }]],
    [
      "line endings",
      "alpha\r\nbeta\r\n",
      "alpha\nbeta\n",
      [{ before: "alpha\r\nbeta\r\n", after: "alpha\nbeta\n" }],
    ],
    [
      "Unicode",
      "coffee ☕\n東京\n",
      "coffee and tea ☕\n東京へ\n",
      [{ before: "coffee ☕\n東京\n", after: "coffee and tea ☕\n東京へ\n" }],
    ],
  ])("returns exact before/after text for %s", async (_name, before, after, expected) => {
    expect(await markdownChanges(before, after)).toEqual(expected);
  });

  test("compares stable page revisions from canonical metadata", async () => {
    expect(
      await pageDelta(
        {
          title: "Old title",
          summary: "Stable summary",
          entity_type: null,
          body_markdown: "Old body\n",
        },
        {
          title: "New title",
          summary: "Stable summary",
          entity_type: "person",
          body_markdown: "New body\n",
        },
      ),
    ).toEqual({
      metadata_changes: [
        { field: "title", before: "Old title", after: "New title" },
        { field: "entity_type", before: null, after: "person" },
      ],
      markdown_changes: [{ before: "Old body\n", after: "New body\n" }],
    });
  });

  test("keeps a large replacement exact without adding another diff representation", async () => {
    const before = `${"before ".repeat(2_000)}\n`;
    const after = `${"after ".repeat(2_000)}\n`;

    expect(await markdownChanges(before, after)).toEqual([{ before, after }]);
  });
});
