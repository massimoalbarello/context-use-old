import { describe, expect, test } from "bun:test";
import { pathlessPublicationIntentBody } from "./publication-auth.ts";

describe("pathless publication authorization", () => {
  const targetId = "11111111-1111-4111-8111-111111111111";
  const revisionId = "22222222-2222-4222-8222-222222222222";

  test("binds a page publish to its exact current revision without a path", () => {
    expect(pathlessPublicationIntentBody({
      action: "publish",
      targetKind: "page",
      targetId,
      versionId: revisionId,
    })).toEqual({
      action: "publish",
      target_kind: "page",
      target_document_id: targetId,
      expected_revision_id: revisionId,
    });
  });

  test("uses exact pathless variants for asset and unpublish operations", () => {
    expect(pathlessPublicationIntentBody({
      action: "publish",
      targetKind: "asset",
      targetId,
      versionId: null,
    })).toEqual({
      action: "publish",
      target_kind: "asset",
      target_document_id: targetId,
    });
    expect(pathlessPublicationIntentBody({
      action: "unpublish",
      targetKind: "page",
      targetId,
      versionId: null,
    })).toEqual({
      action: "unpublish",
      target_kind: "page",
      target_document_id: targetId,
    });
  });

  test("rejects a page publish without exact revision evidence", () => {
    expect(() => pathlessPublicationIntentBody({
      action: "publish",
      targetKind: "page",
      targetId,
      versionId: null,
    })).toThrow("exact revision");
  });
});
