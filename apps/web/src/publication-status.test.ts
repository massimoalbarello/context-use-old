import { describe, expect, test } from "bun:test";
import { isPublishedPageOutdated } from "./publication-status.ts";

function page(id: string, publishedVersionId: string | null, currentVersionId = `${id}-latest`) {
  return {
    current_version_id: currentVersionId,
    published_version_id: publishedVersionId,
  };
}

describe("publication status", () => {
  const privatePage = page("private", null);
  const currentPage = page("current", "current-latest");
  const outdatedPage = page("outdated", "outdated-v1");

  test("only treats a published older snapshot as outdated", () => {
    expect(isPublishedPageOutdated(privatePage)).toBeFalse();
    expect(isPublishedPageOutdated(currentPage)).toBeFalse();
    expect(isPublishedPageOutdated(outdatedPage)).toBeTrue();
  });
});
