import { describe, expect, test } from "bun:test";
import {
  CorpusMigrationObjectError,
  mapInByteBoundedBatches,
} from "./corpus-migration-execution.ts";

describe("corpus migration object execution", () => {
  test("bounds both count and bytes in deterministic input-order batches", async () => {
    const items = [
      { documentId: "one", sizeBytes: 6 },
      { documentId: "two", sizeBytes: 4 },
      { documentId: "three", sizeBytes: 5 },
      { documentId: "four", sizeBytes: 5 },
    ];
    let activeCount = 0;
    let activeBytes = 0;
    let maximumCount = 0;
    let maximumBytes = 0;
    const starts: string[] = [];
    const values = await mapInByteBoundedBatches(
      items,
      { concurrency: 2, maxInFlightBytes: 10 },
      async (item) => {
        starts.push(item.documentId);
        activeCount += 1;
        activeBytes += item.sizeBytes;
        maximumCount = Math.max(maximumCount, activeCount);
        maximumBytes = Math.max(maximumBytes, activeBytes);
        await Promise.resolve();
        activeCount -= 1;
        activeBytes -= item.sizeBytes;
        return item.documentId.toUpperCase();
      },
    );

    expect(starts).toEqual(["one", "two", "three", "four"]);
    expect(maximumCount).toBe(2);
    expect(maximumBytes).toBe(10);
    expect(values).toEqual(["ONE", "TWO", "THREE", "FOUR"]);
  });

  test("runs an object larger than the byte budget by itself", async () => {
    const batches: number[] = [];
    let active = 0;
    await mapInByteBoundedBatches([
      { documentId: "large-record", sizeBytes: 64 },
      { documentId: "small-record", sizeBytes: 1 },
    ], { concurrency: 2, maxInFlightBytes: 16 }, async () => {
      active += 1;
      batches.push(active);
      await Promise.resolve();
      active -= 1;
    });
    expect(batches).toEqual([1, 1]);
  });

  test("settles a whole batch before returning a body-safe document error", async () => {
    const completed: string[] = [];
    const failure = new CorpusMigrationObjectError("knowledge", "safe-document-id", "read");
    await expect(mapInByteBoundedBatches([
      { documentId: "safe-document-id", sizeBytes: 1 },
      { documentId: "other-document-id", sizeBytes: 1 },
    ], { concurrency: 2, maxInFlightBytes: 2 }, async (item) => {
      await Promise.resolve();
      completed.push(item.documentId);
      if (item.documentId === "safe-document-id") throw failure;
    })).rejects.toBe(failure);
    expect(completed).toEqual(["safe-document-id", "other-document-id"]);
    expect(failure.message).not.toContain("body");
    expect(failure.message).not.toContain("documents/private");
  });
});
