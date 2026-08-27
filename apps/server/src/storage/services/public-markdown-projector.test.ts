import { describe, expect, test } from "bun:test";
import { projectPublicMarkdown } from "#storage/services/public-markdown-projector.ts";

const source = "11111111-1111-4111-8111-111111111111";
const page = "22222222-2222-4222-8222-222222222222";
const asset = "33333333-3333-4333-8333-333333333333";
const privateObject = "44444444-4444-4444-8444-444444444444";
const publicPage = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const publicAsset = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

describe("canonical public Markdown projection", () => {
  test("uses canonical public UUID routes and strips every private identity", () => {
    const result = projectPublicMarkdown(
      [
        `[Page](context-use://object/${page}#details)`,
        `![Photo](context-use://object/${asset}){size=medium}`,
        `[Old page](context-use://page/${page})`,
        `![Old asset](context-use://asset/${asset})`,
        `[Private](context-use://object/${privateObject})`,
        `Literal ${source} and <script>leak ${privateObject}</script>`,
      ].join("\n\n"),
      [
        {
          target_object_id: page,
          outcome: "active_public",
          public_id: publicPage,
          public_target_kind: "page",
        },
        {
          target_object_id: asset,
          outcome: "active_public",
          public_id: publicAsset,
          public_target_kind: "asset",
        },
        {
          target_object_id: privateObject,
          outcome: "private",
          public_id: null,
          public_target_kind: null,
        },
      ],
    );

    expect(result.bodyMarkdown).toContain(`[Page](/p/${publicPage}#details)`);
    expect(result.bodyMarkdown).toContain(`![Photo](/a/${publicAsset}){size=medium}`);
    expect(result.bodyMarkdown).toContain("Old page");
    expect(result.bodyMarkdown).toContain("Old asset");
    expect(result.bodyMarkdown).toContain("Private");
    expect(result.bodyMarkdown).not.toContain(source);
    expect(result.bodyMarkdown).not.toContain(privateObject);
    expect(result.bodyMarkdown).not.toContain("<script>");
    expect(result.observedPublicIds).toEqual([publicPage, publicAsset].sort());
  });

  test("fails closed for inactive, conflicting and wrong-representation images", () => {
    const projected = projectPublicMarkdown(
      [
        `[Inactive](context-use://object/${page})`,
        `![Page as image](context-use://object/${source})`,
      ].join("\n"),
      [
        {
          target_object_id: page,
          outcome: "inactive_public",
          public_id: null,
          public_target_kind: null,
        },
        {
          target_object_id: source,
          outcome: "self",
          public_id: publicPage,
          public_target_kind: "page",
        },
      ],
    );

    expect(projected.bodyMarkdown).toBe("Inactive\nPage as image");
    expect(projected.observedPublicIds).toEqual([]);
  });
});
