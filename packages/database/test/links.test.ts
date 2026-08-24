import { describe, expect, test } from "bun:test";
import { extractDocumentLinks } from "../src/links.ts";

const first = "11111111-1111-4111-8111-111111111111";
const second = "22222222-2222-4222-8222-222222222222";

describe("canonical document links", () => {
  test("extracts unique generic identities from links and embedded documents", () => {
    const markdown = [
      `[Page](context-use://document/${first}#overview)`,
      `![Asset](context-use://document/${second})`,
      `[Duplicate](context-use://document/${first})`,
    ].join("\n");

    expect(extractDocumentLinks(markdown)).toEqual([first, second]);
  });

  test("ignores unsupported private link schemes", () => {
    const markdown = [
      `[Page](context-use://page/${first})`,
      `![Asset](context-use://asset/${first})`,
      `[Directory](context-use://directory/${first})`,
      `[Dashboard](/app/pages/${first})`,
      "[[directory/page]]",
    ].join("\n");

    expect(extractDocumentLinks(markdown)).toEqual([]);
  });

  test("ignores canonical examples in inert Markdown regions", () => {
    const markdown = [
      `\`[inline](context-use://document/${first})\``,
      "```md",
      `[fenced](context-use://document/${first})`,
      "```",
      `<!-- [comment](context-use://document/${first}) -->`,
      `<pre>[html](context-use://document/${first})</pre>`,
      `\\[escaped](context-use://document/${first})`,
      `[visible](context-use://document/${second})`,
    ].join("\n");

    expect(extractDocumentLinks(markdown)).toEqual([second]);
  });

  test("keeps links inside block HTML inert while indexing later prose", () => {
    const markdown = [
      "<div>",
      `[hidden](context-use://document/${first})`,
      "</div>",
      "",
      `[visible](context-use://document/${second})`,
    ].join("\n");

    expect(extractDocumentLinks(markdown)).toEqual([second]);
  });

  test("treats an unterminated fence as inert through end of input", () => {
    expect(extractDocumentLinks([
      "```md",
      `[hidden](context-use://document/${first})`,
    ].join("\n"))).toEqual([]);
  });
});
