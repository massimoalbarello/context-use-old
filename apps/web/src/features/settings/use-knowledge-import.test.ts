import { describe, expect, test } from "bun:test";
import { summarizeUploadedParts } from "./use-knowledge-import.ts";

describe("resumable knowledge import progress", () => {
  test("orders completed parts numerically and counts the short final part exactly", () => {
    expect(
      summarizeUploadedParts({
        fileSize: 10_250,
        partSize: 1_000,
        totalParts: 11,
        uploaded: new Set([10, 2, 0]),
      }),
    ).toEqual({
      uploadedParts: [0, 2, 10],
      bytesCompleted: 2_250,
    });
  });

  test("ignores out-of-range server state instead of inflating progress", () => {
    expect(
      summarizeUploadedParts({
        fileSize: 1_500,
        partSize: 1_000,
        totalParts: 2,
        uploaded: new Set([0, 1, 2]),
      }),
    ).toEqual({
      uploadedParts: [0, 1],
      bytesCompleted: 1_500,
    });
  });
});
