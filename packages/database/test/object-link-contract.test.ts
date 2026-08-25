import { describe, expect, test } from "bun:test";
import {
  GenericObjectLinkContractError,
  assertGenericObjectLinksOnly,
  genericObjectTargets,
} from "../src/index.ts";

const first = "018f7688-0ad4-7b71-a0ac-17ed7415b940";
const second = "018f7688-0ad4-7b71-a0ac-17ed7415b941";

describe("generic knowledge link contract", () => {
  test("accepts only rendered generic document links and preserves their full receipt", () => {
    const markdown = [
      `[Page](context-use://object/${first}#next_steps)`,
      `![Asset](context-use://object/${second})`,
      `Duplicate: [same](context-use://object/${first})`,
      "[Public page](/p/public-id)",
      "[Public Markdown](/p/public-id.md#section)",
      "[Public asset](/a/public-id)",
      "[Public root](/)",
      "[Local section](#local-section)",
      "[External](https://example.com/app/pages/not-private)",
    ].join("\n\n");

    expect(() => assertGenericObjectLinksOnly(markdown)).not.toThrow();
    expect(genericObjectTargets(markdown)).toEqual([first, second]);
  });

  test("accepts generic reference links and ordinary rendered web links", () => {
    const markdown = [
      `[generic]: context-use://object/${first}#section`,
      "",
      "[Referenced][generic]",
      "![Referenced image][generic]",
      "[Public](https://example.com/p/public-id)",
      "<a href=\"https://example.com/app/pages/not-private\">External</a>",
    ].join("\n");

    expect(() => assertGenericObjectLinksOnly(markdown)).not.toThrow();
    expect(genericObjectTargets(markdown)).toEqual([first]);
  });

  test.each([
    `context-use://object/${first}`,
    `[Page](context-use://page/${first})`,
    `![Asset](context-use://asset/${first})`,
    `[Directory](context-use://directory/${first})`,
    "[[private/path]]",
    "![[private/asset]]",
    "[Page](/app/pages/018f7688-0ad4-7b71-a0ac-17ed7415b940)",
    "[Directory](/app/directories/018f7688-0ad4-7b71-a0ac-17ed7415b940)",
    "[Record](/app/records/018f7688-0ad4-7b71-a0ac-17ed7415b940)",
    "[Asset](/app/assets/018f7688-0ad4-7b71-a0ac-17ed7415b940)",
    "[Document](/app/documents/018f7688-0ad4-7b71-a0ac-17ed7415b940)",
    "[Page](/api/dashboard/pages/018f7688-0ad4-7b71-a0ac-17ed7415b940)",
    "[Directory](/api/dashboard/directories/018f7688-0ad4-7b71-a0ac-17ed7415b940)",
    "[Record](/api/dashboard/records/018f7688-0ad4-7b71-a0ac-17ed7415b940)",
    "[Asset](/api/mcp/assets/018f7688-0ad4-7b71-a0ac-17ed7415b940)",
    "[Document](</api/public/documents/018f7688-0ad4-7b71-a0ac-17ed7415b940>)",
    `[see /app/pages/${first}](context-use://object/${second})`,
    `[context-use://asset/${first}](context-use://object/${second})`,
    `![[private/asset]](context-use://object/${second})`,
    `[private]: /app/pages/${first}\n\n[Open][private]`,
    `[legacy]: context-use://page/${first}\n\n[Open][legacy]`,
    `[continued]:\n  /app/pages/${first}\n\n[Open][continued]`,
    `Text <a href="/app/documents/${first}">private</a>.`,
    `Text <img src='/api/dashboard/assets/${first}'>.`,
    `Text <audio src="/app/assets/${first}"></audio>.`,
    `<div>\n<a href="/app/documents/${first}">private</a>\n</div>`,
    `<table>\n<tr><td><img src="&#x2F;api&#x2F;dashboard&#x2F;assets&#x2F;${first}"></td></tr>\n</table>`,
    `[encoded](&sol;app&sol;pages&sol;${first})`,
    `[encoded](context-use&colon;&sol;&sol;page&sol;${first})`,
    `[encoded](context-use&percnt;3A&percnt;2F&percnt;2Fpage&percnt;2F${first})`,
    `[controls](context-use&#x09;://page/${first})`,
    `[controls](contex&#x0a;t-use://page/${first})`,
    `[numeric](&#47;api&#47;dashboard&#47;documents&#47;${first})`,
    `[backslash](\\app\\documents\\${first})`,
    `<a href=\n"/app/documents/${first}">multiline</a>`,
    `<a href="&Tab;/app/documents/${first}">tabbed</a>`,
    `<a href="&NewLine;/api/dashboard/documents/${first}">newline</a>`,
    `<audio src="&bsol;app&bsol;assets&bsol;${first}"></audio>`,
    `[nested ![private /app/documents/${first}](https://example.com/image.png)](context-use://object/${second})`,
    `<div>\ncontext-use://page/${first}\n</div>`,
    `<div>\n[[private/path]]\n</div>`,
    `<table>\n<tr><td>context-use://asset/${first}</td></tr>\n</table>`,
    `[wrapped]((/app/pages/${first}))`,
    `[wrapped]([[private/path]])`,
    `[smuggled](/p/safe/app/pages/${first})`,
    `[smuggled](/p/safe.md/app/pages/${first})`,
    `[smuggled](/a/safe?next=/api/dashboard/assets/${first})`,
    `[same-origin shaped](https://context-use.example/app/pages/${first})`,
    `<a href="//context-use.example/api/dashboard/documents/${first}">private</a>`,
    `[external exfiltration](https://example.com/?next=context-use://page/${first})`,
    `[malformed](/app/pages/${first} "unterminated)`,
    `[malformed](/app/pages/${first} <bad>)`,
    `[malformed](</app/pages/${first}>)`,
    `[malformed](/app/pages/${first} (title) trailing)`,
    `[malformed]: /app/pages/${first} "unterminated`,
    `[malformed]: </app/pages/${first}>\n\n[Open][malformed]`,
    `[malformed]: /app/pages/${first} (title) trailing`,
    `See:/app/pages/${first}`,
    `"/app/pages/${first}"`,
    `x=/api/dashboard/documents/${first}`,
    `See:/%61pp/documents/${first}`,
    `See:/&percnt;61pp/documents/${first}`,
  ])("rejects a rendered legacy or private destination: %s", (markdown) => {
    expect(() => assertGenericObjectLinksOnly(markdown))
      .toThrow(GenericObjectLinkContractError);
  });

  test("invalid numeric entities fail with the stable contract error", () => {
    expect(() => assertGenericObjectLinksOnly(
      `<a href="&#999999999999999999;/app/documents/${first}">bad</a>`,
    )).toThrow(GenericObjectLinkContractError);
  });

  test("does not let a valid occurrence whitelist the same bytes in malformed prose", () => {
    const generic = `[ok](context-use://object/${first})`;
    expect(() => assertGenericObjectLinksOnly(`${generic}\n\n[outer](${generic})`))
      .toThrow(GenericObjectLinkContractError);
  });

  test("rejects pathological reference tables before entering the Markdown parser", () => {
    for (const markdown of [
      Array.from({ length: 513 }, (_, index) => (
        `[reference-${index}]: https://example.com/${index}`
      )).join("\n"),
      Array.from({ length: 513 }, (_, index) => (
        `[escaped\\]${index}]: https://example.com/${index}\n[use][escaped\\]${index}]`
      )).join("\n"),
      Array.from({ length: 513 }, (_, index) => (
        `[multiline-${index}\nlabel]: https://example.com/${index}`
      )).join("\n"),
    ]) {
      const startedAt = performance.now();
      expect(() => assertGenericObjectLinksOnly(markdown))
        .toThrow(GenericObjectLinkContractError);
      expect(performance.now() - startedAt).toBeLessThan(250);
    }
  });

  test("rejects pathological parser depth with the stable contract error", () => {
    expect(() => assertGenericObjectLinksOnly(`${"- ".repeat(256)}safe`)).not.toThrow();
    for (const markdown of [
      `${"> ".repeat(257)}safe`,
      `${"- ".repeat(257)}safe`,
      `${"1. ".repeat(257)}safe`,
      "*".repeat(100_001),
      `${"<div>".repeat(300)}safe${"</div>".repeat(300)}`,
    ]) {
      expect(() => assertGenericObjectLinksOnly(markdown))
        .toThrow(GenericObjectLinkContractError);
    }
  });

  test("bounds total container work across individually valid lines", () => {
    const markdown = `${`${"- ".repeat(256)}safe\n`.repeat(17)}`;
    const startedAt = performance.now();
    expect(() => assertGenericObjectLinksOnly(markdown))
      .toThrow(GenericObjectLinkContractError);
    expect(performance.now() - startedAt).toBeLessThan(250);
  });

  test("treats examples in inert Markdown regions as non-semantic", () => {
    const markdown = [
      "```md",
      `[[private/path]] [old](context-use://page/${first})`,
      "```",
      `Inline \`context-use://asset/${first}\` example.`,
      `<!-- [old](/app/pages/${first}) -->`,
      `<pre>[old](/api/dashboard/pages/${first})</pre>`,
      `\\[[escaped/path]] and \\[escaped](/app/pages/${first})`,
    ].join("\n\n");

    expect(() => assertGenericObjectLinksOnly(markdown)).not.toThrow();
    expect(genericObjectTargets(markdown)).toEqual([]);
  });
});
