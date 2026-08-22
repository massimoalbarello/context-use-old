import { describe, expect, test } from "bun:test";
import {
  extractAssetLinks,
  extractDocumentLinks,
  extractDirectoryLinks,
  extractPageLinks,
  extractWikiLinks,
  mapMarkdownOutsideCode,
  normalizeInternalDocumentLinks,
  normalizeInternalPageLinks,
  wikiLinkCandidatePaths,
} from "../src/links.ts";

describe("hypermedia links", () => {
  test("extracts and deduplicates stable page links", () => {
    const id = "018f3d6d-4050-7c95-8d5a-001122334455";
    expect(extractPageLinks(`[one](context-use://page/${id}#overview) [two](context-use://page/${id})`)).toEqual([id]);
    expect(extractDocumentLinks(`[one](context-use://document/${id}) ![two](context-use://document/${id})`)).toEqual([id]);
  });

  test("canonicalizes new page and asset references to generic document links", () => {
    const page = "018f3d6d-4050-7c95-8d5a-001122334455";
    const asset = "11111111-1111-4111-8111-111111111111";
    const markdown = `[related](/app/pages/${page}#Useful-Section) ![photo](context-use://asset/${asset})`;
    const canonical = `[related](context-use://document/${page}#useful-section) ![photo](context-use://document/${asset})`;
    expect(normalizeInternalDocumentLinks(markdown)).toBe(canonical);
    expect(normalizeInternalPageLinks(markdown)).toBe(canonical);
    expect(extractPageLinks(markdown)).toEqual([page]);
    expect(extractAssetLinks(markdown)).toEqual([asset]);
    expect(extractDocumentLinks(markdown)).toEqual([page, asset]);
  });

  test("extracts stable directory links and normalizes dashboard index routes", () => {
    const id = "018f3d6d-4050-7c95-8d5a-001122334455";
    const markdown = `[chapters](/app/directories/${id}#Useful-Section)`;
    expect(normalizeInternalDocumentLinks(markdown)).toBe(`[chapters](context-use://directory/${id}#useful-section)`);
    expect(extractDirectoryLinks(`${markdown} [again](context-use://directory/${id})`)).toEqual([id]);
    expect(extractPageLinks(markdown)).toEqual([]);
  });

  test("extracts assets without treating them as pages", () => {
    const id = "018f3d6d-4050-7c95-8d5a-001122334455";
    expect(extractAssetLinks(`![photo](context-use://asset/${id})`)).toEqual([id]);
    expect(extractPageLinks(`![photo](context-use://asset/${id})`)).toEqual([]);
  });

  test("keeps immutable legacy schemes parseable while emitting only generic links", () => {
    const page = "018f3d6d-4050-7c95-8d5a-001122334455";
    const asset = "11111111-1111-4111-8111-111111111111";
    const directory = "22222222-2222-4222-8222-222222222222";
    const markdown = [
      `[page](context-use://page/${page})`,
      `![asset](context-use://asset/${asset})`,
      `[directory](context-use://directory/${directory})`,
    ].join(" ");

    expect(extractPageLinks(markdown)).toEqual([page]);
    expect(extractAssetLinks(markdown)).toEqual([asset]);
    expect(extractDirectoryLinks(markdown)).toEqual([directory]);
    expect(normalizeInternalDocumentLinks(markdown)).toBe([
      `[page](context-use://document/${page})`,
      `![asset](context-use://document/${asset})`,
      `[directory](context-use://directory/${directory})`,
    ].join(" "));
  });

  test("extracts Obsidian wikilinks with aliases and ignores embeds", () => {
    expect(extractWikiLinks(
      "[[about/intro#overview|My intro]] [[about/learnings/claude]] [[about/intro#details|Duplicate]] ![[assets/photo]]",
    )).toEqual([
      { path: "about/intro", label: "My intro" },
      { path: "about/learnings/claude", label: "claude" },
    ]);
  });

  test("prefers the source directory for short Obsidian paths", () => {
    expect(wikiLinkCandidatePaths("claude", "me/learnings/intro")).toEqual([
      "me/learnings/claude",
      "claude",
    ]);
    expect(wikiLinkCandidatePaths("fabric/intro", "about/intro")).toEqual(["fabric/intro"]);
  });

  test("keeps inline and fenced link examples byte-exact and out of every graph index", () => {
    const outside = "018f3d6d-4050-7c95-8d5a-001122334455";
    const code = "11111111-1111-4111-8111-111111111111";
    const directory = "22222222-2222-4222-8222-222222222222";
    const markdown = [
      `[outside](context-use://page/${outside}) [[outside-wiki]]`,
      `\`[inline](context-use://asset/${code}) [[inline-wiki]]\``,
      "```md",
      `[fenced](/app/pages/${code})`,
      `[directory](/app/directories/${directory})`,
      "[[fenced-wiki]]",
      "```",
      "~~~md",
      `![asset](context-use://asset/${code})`,
      "~~~",
    ].join("\n");
    const normalized = normalizeInternalDocumentLinks(markdown);

    expect(normalized).toBe(markdown.replace(
      `context-use://page/${outside}`,
      `context-use://document/${outside}`,
    ));
    expect(extractDocumentLinks(markdown)).toEqual([outside]);
    expect(extractPageLinks(markdown)).toEqual([outside]);
    expect(extractAssetLinks(markdown)).toEqual([]);
    expect(extractDirectoryLinks(markdown)).toEqual([]);
    expect(extractWikiLinks(markdown)).toEqual([{ path: "outside-wiki", label: "outside-wiki" }]);
  });

  test("keeps non-rendered escaped, commented and indented links byte-exact and out of the graph", () => {
    const hidden = "11111111-1111-4111-8111-111111111111";
    const visible = "018f3d6d-4050-7c95-8d5a-001122334455";
    const markdown = [
      `\\[escaped](/app/pages/${hidden}) \\[[escaped-wiki]]`,
      `<!-- [commented](context-use://document/${hidden}) [[commented-wiki]] -->`,
      "",
      `    [indented](/app/pages/${hidden}) [[indented-wiki]]`,
      "",
      "> ```md",
      `> [quoted-fence](/app/pages/${hidden}) [[quoted-wiki]]`,
      "> ```",
      "",
      "- ```md",
      `  [list-fence](context-use://page/${hidden}) [[list-wiki]]`,
      "  ```",
      "",
      "```md",
      "    ```",
      `[not-a-closing-fence](context-use://asset/${hidden})`,
      "```",
      `[visible](context-use://page/${visible}) [[visible-wiki]]`,
    ].join("\n");

    expect(normalizeInternalDocumentLinks(markdown)).toBe(markdown.replace(
      `context-use://page/${visible}`,
      `context-use://document/${visible}`,
    ));
    expect(mapMarkdownOutsideCode(markdown, (plain) => plain
      .replaceAll("context-use://", "rewritten://")
      .replaceAll("[[", "rewritten[["))).toBe(markdown
        .replace(`context-use://page/${visible}`, `rewritten://page/${visible}`)
        .replace("[[visible-wiki]]", "rewritten[[visible-wiki]]"));
    expect(extractDocumentLinks(markdown)).toEqual([visible]);
    expect(extractPageLinks(markdown)).toEqual([visible]);
    expect(extractAssetLinks(markdown)).toEqual([]);
    expect(extractDirectoryLinks(markdown)).toEqual([]);
    expect(extractWikiLinks(markdown)).toEqual([{ path: "visible-wiki", label: "visible-wiki" }]);
  });

  test("keeps CommonMark type-1 HTML blocks inert without suppressing inline HTML", () => {
    const hidden = "11111111-1111-4111-8111-111111111111";
    const visible = "22222222-2222-4222-8222-222222222222";
    const markdown = [
      `<PRE>[same-line](context-use://page/${hidden})</PRE>`,
      "> - <script>",
      `>   [multiline](context-use://directory/${hidden})`,
      ">   [[hidden-wiki]]",
      ">   </SCRIPT>",
      `Inline <pre>[visible](context-use://page/${visible})</pre> prose.`,
    ].join("\n");

    expect(normalizeInternalDocumentLinks(markdown)).toBe([
      `<PRE>[same-line](context-use://page/${hidden})</PRE>`,
      "> - <script>",
      `>   [multiline](context-use://directory/${hidden})`,
      ">   [[hidden-wiki]]",
      ">   </SCRIPT>",
      `Inline <pre>[visible](context-use://document/${visible})</pre> prose.`,
    ].join("\n"));
    expect(extractDocumentLinks(markdown)).toEqual([visible]);
    expect(extractDirectoryLinks(markdown)).toEqual([]);
    expect(extractWikiLinks(markdown)).toEqual([]);

    const unterminated = [
      "<textarea>",
      `[through-eof](context-use://page/${hidden})`,
      "[[through-eof-wiki]]",
    ].join("\n");
    expect(normalizeInternalDocumentLinks(unterminated)).toBe(unterminated);
    expect(extractDocumentLinks(unterminated)).toEqual([]);
    expect(extractWikiLinks(unterminated)).toEqual([]);

    const droppedContainer = [
      "> - <script>",
      `[outside](context-use://page/${visible})`,
      ">   </script>",
    ].join("\n");
    expect(normalizeInternalDocumentLinks(droppedContainer)).toContain(
      `[outside](context-use://document/${visible})`,
    );
    expect(extractDocumentLinks(droppedContainer)).toEqual([visible]);
  });

  test("keeps CommonMark declaration and block-tag HTML inert until their terminators", () => {
    const hidden = "11111111-1111-4111-8111-111111111111";
    const visible = "22222222-2222-4222-8222-222222222222";
    const markdown = [
      "<div>",
      `[div](context-use://page/${hidden})`,
      "</div>",
      "",
      "<table>",
      `| [table](context-use://page/${hidden}) |`,
      "</table>",
      "",
      `<?example [pi](context-use://page/${hidden}) ?>`,
      "<![CDATA[",
      `[cdata](context-use://page/${hidden})`,
      "]]>",
      "<!DOCTYPE html>",
      `Inline <div>[visible](context-use://page/${visible})</div> prose.`,
    ].join("\n");

    expect(normalizeInternalDocumentLinks(markdown)).toBe(markdown.replace(
      `context-use://page/${visible}`,
      `context-use://document/${visible}`,
    ));
    expect(extractDocumentLinks(markdown)).toEqual([visible]);
    expect(extractPageLinks(markdown)).toEqual([visible]);
  });

  test("keeps CommonMark type-7 HTML blocks inert without suppressing inline tags", () => {
    const hidden = "11111111-1111-4111-8111-111111111111";
    const visible = "22222222-2222-4222-8222-222222222222";
    const markdown = [
      `<knowledge-card data-example="[attribute](context-use://page/${hidden})">`,
      `[body](context-use://page/${hidden}) [[hidden-wiki]]`,
      "</knowledge-card>",
      "",
      "> - <Warning>",
      `>   [nested](context-use://directory/${hidden}) [[nested-wiki]]`,
      ">   </Warning>",
      "",
      "A paragraph keeps a standalone custom tag inline",
      "<knowledge-card>",
      `[visible](context-use://page/${visible}) [[visible-wiki]]`,
      "",
      `Inline <knowledge-card>[also-visible](context-use://page/${visible})</knowledge-card> prose.`,
    ].join("\n");

    expect(normalizeInternalDocumentLinks(markdown)).toBe(markdown
      .replaceAll(
        `context-use://page/${visible}`,
        `context-use://document/${visible}`,
      ));
    expect(mapMarkdownOutsideCode(markdown, (plain) => plain.replaceAll("[[", "changed[[")))
      .toBe(markdown
        .replace("[[visible-wiki]]", "changed[[visible-wiki]]"));
    expect(extractDocumentLinks(markdown)).toEqual([visible]);
    expect(extractPageLinks(markdown)).toEqual([visible]);
    expect(extractDirectoryLinks(markdown)).toEqual([]);
    expect(extractWikiLinks(markdown)).toEqual([
      { path: "visible-wiki", label: "visible-wiki" },
    ]);
  });
});
