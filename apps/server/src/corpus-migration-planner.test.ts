import { describe, expect, test } from "bun:test";
import { extractDocumentLinks } from "@context-use/database";
import {
  planDirectoryHubEligibility,
  planLegacyAutomationRegistry,
  referencedDirectoryDocumentIds,
  renderDirectoryHubMarkdown,
  rewriteCurrentKnowledgeMarkdown,
  type CorpusMigrationLinkIndex,
} from "./corpus-migration-planner.ts";

const relativePage = "11111111-1111-4111-8111-111111111111";
const rootPage = "22222222-2222-4222-8222-222222222222";
const directory = "33333333-3333-4333-8333-333333333333";
const rootDirectory = "44444444-4444-4444-8444-444444444444";
const operationalDirectory = "55555555-5555-4555-8555-555555555555";
const asset = "66666666-6666-4666-8666-666666666666";

const index: CorpusMigrationLinkIndex = {
  pages: [
    { documentId: relativePage, path: "people/alice/intro" },
    { documentId: rootPage, path: "intro" },
  ],
  directories: [
    { documentId: directory, path: "people/alice/projects" },
    { documentId: rootDirectory, path: "" },
    { documentId: operationalDirectory, path: "automations/activity-distiller", operational: true },
  ],
  publicAssets: [
    { documentId: asset, publicPath: "people/alice/photo" },
  ],
  documentIds: [relativePage, rootPage, directory, asset],
};

describe("corpus migration planner", () => {
  test("rewrites only exact resolvable links with relative-first wiki semantics", () => {
    const markdown = [
      "[[intro#background|Alice intro]]",
      "[[people/alice/projects#active|Projects]]",
      "[[missing|Readable missing label]]",
      `[[automations/activity-distiller|Operational directory]]`,
      `[Directory](/app/directories/${directory}#active)`,
      `[Root](context-use://directory/${rootDirectory})`,
      `[Operational](context-use://directory/${operationalDirectory})`,
      `[Old page](context-use://page/${rootPage}#bio)`,
      `![Old asset](context-use://asset/${asset}){shape=square}`,
      "![Photo](context-use://public-asset/people/alice/photo){size=small}",
      "[Download](context-use://public-asset/people/alice/photo)",
      "![Missing](context-use://public-asset/people/alice/missing){size=small}",
    ].join("\n");

    expect(rewriteCurrentKnowledgeMarkdown(markdown, "people/alice/work", index)).toBe([
      `[Alice intro](context-use://document/${relativePage}#background)`,
      `[Projects](context-use://document/${directory}#active)`,
      "Readable missing label",
      "Operational directory",
      `[Directory](context-use://document/${directory}#active)`,
      "Root",
      "Operational",
      `[Old page](context-use://document/${rootPage}#bio)`,
      `![Old asset](context-use://document/${asset}){shape=square}`,
      `![Photo](context-use://document/${asset}){size=small}`,
      `[Download](context-use://document/${asset})`,
      "Missing",
    ].join("\n"));
  });

  test("keeps ambiguous migration targets inert instead of guessing", () => {
    const ambiguous: CorpusMigrationLinkIndex = {
      pages: [
        { documentId: relativePage, path: "duplicate" },
        { documentId: rootPage, path: "duplicate" },
      ],
      directories: [],
      publicAssets: [
        { documentId: asset, publicPath: "duplicate" },
        { documentId: directory, publicPath: "duplicate" },
      ],
      documentIds: [relativePage, rootPage, asset, directory],
    };
    expect(rewriteCurrentKnowledgeMarkdown(
      "[[duplicate|Page]] [Asset](context-use://public-asset/duplicate)",
      "other/page",
      ambiguous,
    )).toBe("Page Asset");
  });

  test("never rewrites link examples inside inline or fenced code", () => {
    const markdown = [
      "Outside [[intro|Intro]].",
      "",
      "`[[intro|Inline]] [Dir](context-use://directory/33333333-3333-4333-8333-333333333333)`",
      "",
      "```md",
      "[[intro|Fenced]]",
      "![Photo](context-use://public-asset/people/alice/photo)",
      "```",
      "",
      "~~~",
      `[Directory](/app/directories/${directory})`,
      "~~~",
    ].join("\n");
    expect(rewriteCurrentKnowledgeMarkdown(markdown, "people/alice/work", index)).toBe([
      `Outside [Intro](context-use://document/${relativePage}).`,
      "",
      "`[[intro|Inline]] [Dir](context-use://directory/33333333-3333-4333-8333-333333333333)`",
      "",
      "```md",
      "[[intro|Fenced]]",
      "![Photo](context-use://public-asset/people/alice/photo)",
      "```",
      "",
      "~~~",
      `[Directory](/app/directories/${directory})`,
      "~~~",
    ].join("\n"));
  });

  test("keeps escaped and commented link examples inert and byte-exact", () => {
    const escaped = [
      `\\[[intro|Escaped wiki]]`,
      `\\[Escaped page](context-use://page/${rootPage})`,
      `\\[Escaped generic](context-use://document/${rootPage})`,
      `\\[Escaped directory](context-use://directory/${directory})`,
      `!\\[Escaped asset](context-use://public-asset/people/alice/photo)`,
      `<!-- [[intro|Comment wiki]] [Page](context-use://page/${rootPage}) -->`,
    ].join("\n");
    expect(rewriteCurrentKnowledgeMarkdown(escaped, "people/alice/work", index)).toBe(escaped);
  });

  test("keeps generic links only to active readable documents", () => {
    const missingPage = "77777777-7777-4777-8777-777777777777";
    const deletedRecord = "88888888-8888-4888-8888-888888888888";
    const deletedAsset = "99999999-9999-4999-8999-999999999999";
    expect(rewriteCurrentKnowledgeMarkdown([
      `[Readable](context-use://document/${rootPage}#bio)`,
      `[Missing page](context-use://document/${missingPage})`,
      `[Deleted record](context-use://document/${deletedRecord})`,
      `![Deleted asset](context-use://document/${deletedAsset}){size=small}`,
      `\`[Code](context-use://document/${missingPage})\``,
    ].join("\n"), "people/alice/work", index)).toBe([
      `[Readable](context-use://document/${rootPage}#bio)`,
      "Missing page",
      "Deleted record",
      "Deleted asset",
      `\`[Code](context-use://document/${missingPage})\``,
    ].join("\n"));
  });

  test("renders deterministic atomic hubs from the exact supplied projection", () => {
    expect(renderDirectoryHubMarkdown({
      title: " Alice's\r\nprojects ",
      summary: " Work Alice cares about. ",
      links: [
        { documentId: rootPage, label: "Zeta", summary: null, sortKey: "zeta" },
        { documentId: relativePage, label: "[Alpha]\r\nproject", summary: " First project. ", sortKey: "alpha" },
        { documentId: relativePage, label: "Duplicate", summary: null, sortKey: "zeta" },
      ],
    })).toBe([
      "# Alice's projects",
      "",
      "Work Alice cares about\\.",
      "",
      "## Contents",
      "",
      `- [&#91;Alpha&#93; project](context-use://document/${relativePage}) — First project\\.`,
      `- [Zeta](context-use://document/${rootPage})`,
      "",
    ].join("\n"));
  });

  test("renders legacy presentation metadata as inert Markdown text", () => {
    const injected = "77777777-7777-4777-8777-777777777777";
    const body = renderDirectoryHubMarkdown({
      title: `Projects\r\n[Injected](context-use://document/${injected})`,
      summary: `> ![Private](context-use://document/${injected})`,
      links: [{
        documentId: relativePage,
        label: `Alice\n[Injected](context-use://document/${injected})`,
        summary: `1. [Private](context-use://document/${injected})`,
        sortKey: "alice",
      }],
    });

    expect(body).toContain("Projects \\[Injected\\]\\(context\\-use://document/77777777\\-7777\\-4777\\-8777\\-777777777777\\)");
    expect(body).not.toContain("\n> ");
    expect(body).not.toContain("Alice\n");
    expect(extractDocumentLinks(body)).toEqual([relativePage]);
  });

  test("retires empty default categories and retains only corpus-justified hubs bottom-up", () => {
    const candidates = [
      {
        documentId: rootDirectory,
        path: "",
        parentPath: null,
        title: "Knowledge",
        summary: "Default root.",
        templateTitle: "Knowledge",
        templateSummary: "Default root.",
        retainedDirectDocuments: 0,
        legacyPublicReachable: true,
      },
      {
        documentId: "77777777-7777-4777-8777-777777777777",
        path: "places",
        parentPath: "",
        title: "Places",
        summary: "Default places.",
        templateTitle: "Places",
        templateSummary: "Default places.",
        retainedDirectDocuments: 0,
        legacyPublicReachable: false,
      },
      {
        documentId: "88888888-8888-4888-8888-888888888888",
        path: "topics",
        parentPath: "",
        title: "Topics",
        summary: "Default topics.",
        templateTitle: "Topics",
        templateSummary: "Default topics.",
        retainedDirectDocuments: 0,
        legacyPublicReachable: false,
      },
      {
        documentId: "99999999-9999-4999-8999-999999999999",
        path: "topics/systems",
        parentPath: "topics",
        title: "Systems I am exploring",
        summary: "Owner-created structure.",
        retainedDirectDocuments: 0,
        legacyPublicReachable: false,
      },
      {
        documentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        path: "library",
        parentPath: "",
        title: "Library",
        summary: "Default library.",
        templateTitle: "Library",
        templateSummary: "Default library.",
        retainedDirectDocuments: 0,
        legacyPublicReachable: true,
      },
      {
        documentId: operationalDirectory,
        path: "automations/activity-distiller",
        parentPath: "automations",
        title: "Activity distiller",
        summary: "Operational.",
        retainedDirectDocuments: 2,
        legacyPublicReachable: false,
        operational: true,
      },
    ];
    const result = planDirectoryHubEligibility(
      candidates,
      new Set(["77777777-7777-4777-8777-777777777777"]),
    );

    expect([...result.eligibleDocumentIds].sort()).toEqual([
      "77777777-7777-4777-8777-777777777777",
      "88888888-8888-4888-8888-888888888888",
      "99999999-9999-4999-8999-999999999999",
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    ]);
    expect([...result.retiredScaffoldingDocumentIds]).toEqual([]);
    expect([...result.operationalDocumentIds]).toEqual([operationalDirectory]);
    expect(result.eligibleDocumentIds.has(rootDirectory)).toBe(false);

    const empty = planDirectoryHubEligibility([candidates[1]!], new Set());
    expect([...empty.eligibleDocumentIds]).toEqual([]);
    expect([...empty.retiredScaffoldingDocumentIds]).toEqual([
      "77777777-7777-4777-8777-777777777777",
    ]);
    const existing = planDirectoryHubEligibility([{
      ...candidates[1]!,
      hasExistingHub: true,
    }], new Set());
    expect([...existing.eligibleDocumentIds]).toEqual([
      "77777777-7777-4777-8777-777777777777",
    ]);
  });

  test("finds inbound directory and wiki references without mistaking page-first links", () => {
    const referenced = referencedDirectoryDocumentIds([
      {
        path: "people/alice/work",
        bodyMarkdown: [
          `[[people/alice/projects|Projects]]`,
          `[[intro|Page wins]]`,
          `[Projects by UUID](/app/directories/${directory})`,
          `[[automations/activity-distiller|Operational]]`,
          "`[[people/alice/projects|Inline example]]`",
          "```md",
          `[[people/alice/projects|Fenced example]]`,
          "```",
        ].join("\n"),
      },
    ], index);
    expect([...referenced]).toEqual([directory]);

    const escaped = referencedDirectoryDocumentIds([{
      path: "people/alice/work",
      bodyMarkdown: [
        `\\[[people/alice/projects|Escaped wiki]]`,
        `\\[Escaped directory](context-use://directory/${directory})`,
      ].join("\n"),
    }], index);
    expect([...escaped]).toEqual([]);

    const rawHtml = [
      `<pre>[[people/alice/projects|Same-line example]]</pre>`,
      "- <SCRIPT>",
      `  [Directory example](context-use://directory/${directory})`,
      "  [[people/alice/projects|Multiline example]]",
      "  </SCRIPT>",
    ].join("\n");
    expect([...referencedDirectoryDocumentIds([{
      path: "people/alice/work",
      bodyMarkdown: rawHtml,
    }], index)]).toEqual([]);
    expect(rewriteCurrentKnowledgeMarkdown(rawHtml, "people/alice/work", index)).toBe(rawHtml);

    const otherRawHtml = [
      "<div>",
      "[[people/alice/projects|Block tag example]]",
      "</div>",
      "",
      `<?example [Directory](context-use://directory/${directory}) ?>`,
      "<![CDATA[",
      "[[people/alice/projects|CDATA example]]",
      "]]>",
    ].join("\n");
    expect([...referencedDirectoryDocumentIds([{
      path: "people/alice/work",
      bodyMarkdown: otherRawHtml,
    }], index)]).toEqual([]);
    expect(rewriteCurrentKnowledgeMarkdown(
      otherRawHtml,
      "people/alice/work",
      index,
    )).toBe(otherRawHtml);
  });

  test("registers only direct legacy automation instructions and reports every other operational page", () => {
    const instructions = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const state = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const notes = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const nested = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const orphanState = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    expect(planLegacyAutomationRegistry([
      { documentId: instructions, path: "automations/custom-digest/instructions" },
      { documentId: state, path: "automations/custom-digest/state" },
      { documentId: notes, path: "automations/custom-digest/notes" },
      { documentId: nested, path: "automations/custom-digest/nested/instructions" },
      { documentId: orphanState, path: "automations/orphan/state" },
      { documentId: rootPage, path: "automations/custom-digest/agents", guide: true },
    ], [
      { path: "automations/custom-digest", title: "My custom digest" },
      { path: "automations/orphan", title: "Orphan" },
    ])).toEqual({
      registrations: [{
        key: "custom-digest",
        name: "My custom digest",
        instructionsDocumentId: instructions,
        stateDocumentId: state,
      }],
      unrecognizedDocumentIds: [notes, nested, orphanState].sort(),
    });
  });
});
