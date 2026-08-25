import { describe, expect, test } from "bun:test";
import { extractObjectLinks } from "../src/links.ts";

const first = "11111111-1111-4111-8111-111111111111";
const second = "22222222-2222-4222-8222-222222222222";

describe("canonical object links", () => {
  test("extracts unique generic identities from links and embedded objects", () => {
    const markdown = [
      `[Page](context-use://object/${first}#overview)`,
      `![Asset](context-use://object/${second})`,
      `[Duplicate](context-use://object/${first})`,
    ].join("\n");

    expect(extractObjectLinks(markdown)).toEqual([first, second]);
  });

  test("ignores unsupported private link schemes", () => {
    const markdown = [
      `[Page](context-use://page/${first})`,
      `![Asset](context-use://asset/${first})`,
      `[Directory](context-use://directory/${first})`,
      `[Dashboard](/app/pages/${first})`,
      "[[directory/page]]",
    ].join("\n");

    expect(extractObjectLinks(markdown)).toEqual([]);
  });

  test("ignores canonical examples in inert Markdown regions", () => {
    const markdown = [
      `\`[inline](context-use://object/${first})\``,
      "```md",
      `[fenced](context-use://object/${first})`,
      "```",
      `<!-- [comment](context-use://object/${first}) -->`,
      `<pre>[html](context-use://object/${first})</pre>`,
      `\\[escaped](context-use://object/${first})`,
      `[visible](context-use://object/${second})`,
    ].join("\n");

    expect(extractObjectLinks(markdown)).toEqual([second]);
  });

  test("keeps links inside block HTML inert while indexing later prose", () => {
    const markdown = [
      "<div>",
      `[hidden](context-use://object/${first})`,
      "</div>",
      "",
      `[visible](context-use://object/${second})`,
    ].join("\n");

    expect(extractObjectLinks(markdown)).toEqual([second]);
  });

  test("treats an unterminated fence as inert through end of input", () => {
    expect(extractObjectLinks([
      "```md",
      `[hidden](context-use://object/${first})`,
    ].join("\n"))).toEqual([]);
  });
});
