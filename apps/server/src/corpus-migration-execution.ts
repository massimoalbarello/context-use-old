export type ByteSizedMigrationItem = {
  documentId: string;
  sizeBytes: number;
};

export type ByteBoundedExecutionOptions = {
  concurrency: number;
  maxInFlightBytes: number;
};

function positiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer`);
  }
}

/**
 * Run deterministic input-order batches while bounding both concurrent object
 * operations and the bytes their bodies may retain. One object larger than the
 * budget runs alone; rejecting it would make the 64 MiB raw-record ceiling
 * incompatible with a tighter steady-state hydration budget.
 *
 * Every operation in the current batch is allowed to settle before an error is
 * returned. That prevents object writes from continuing after the caller has
 * already reported migration failure.
 */
export async function mapInByteBoundedBatches<T extends ByteSizedMigrationItem, R>(
  items: T[],
  options: ByteBoundedExecutionOptions,
  transform: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  positiveSafeInteger(options.concurrency, "Migration concurrency");
  positiveSafeInteger(options.maxInFlightBytes, "Migration byte budget");
  for (const item of items) {
    if (!Number.isSafeInteger(item.sizeBytes) || item.sizeBytes < 0) {
      throw new Error(`Migration object size is invalid for document ${item.documentId}`);
    }
  }

  const results = new Array<R>(items.length);
  let cursor = 0;
  while (cursor < items.length) {
    const batchStart = cursor;
    let batchBytes = 0;
    while (cursor < items.length && cursor - batchStart < options.concurrency) {
      const size = items[cursor]!.sizeBytes;
      if (cursor > batchStart && batchBytes + size > options.maxInFlightBytes) break;
      batchBytes += size;
      cursor += 1;
    }
    const settled = await Promise.allSettled(
      items.slice(batchStart, cursor).map((item, offset) => transform(item, batchStart + offset)),
    );
    const failure = settled.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
    settled.forEach((result, offset) => {
      if (result.status === "fulfilled") results[batchStart + offset] = result.value;
    });
  }
  return results;
}

export class CorpusMigrationObjectError extends Error {
  constructor(
    readonly documentKind: "asset" | "knowledge" | "published" | "record",
    readonly documentId: string,
    readonly operation: "read" | "verify" | "write",
  ) {
    super(`Corpus migration could not ${operation} ${documentKind} document ${documentId}`);
    this.name = "CorpusMigrationObjectError";
  }
}
