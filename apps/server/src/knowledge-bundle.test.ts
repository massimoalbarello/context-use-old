import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  KNOWLEDGE_BUNDLE_DATASETS,
  type KnowledgeBundleExportRecord,
  type KnowledgeBundleBlob,
  type KnowledgeBundleRepository,
} from "@context-use/database";
import {
  KNOWLEDGE_BUNDLE_MAGIC,
  streamFullKnowledgeBundle,
  validateFullKnowledgeBundle,
} from "./knowledge-bundle.ts";
import type { BrokeredStorage } from "./storage-client.ts";

const intentId = "11111111-1111-4111-8111-111111111111";
const documentId = "22222222-2222-4222-8222-222222222222";
const targetId = "33333333-3333-4333-8333-333333333333";

function fixture() {
  const objectBody = Buffer.concat([
    Buffer.alloc(70_000, 1),
    Buffer.from(`context-use://object/${targetId}`),
  ]);
  const record: KnowledgeBundleExportRecord = {
    dataset: "hypermedia_documents",
    ordinal: 1,
    record: { id: documentId, linked_document_id: targetId },
  };
  const object: KnowledgeBundleBlob = {
    ordinal: 1,
    blob_kind: "asset",
    blob_key: `blobs/${documentId}`,
    size_bytes: objectBody.byteLength,
    content_hash: createHash("sha256").update(objectBody).digest("hex"),
    content_type: "application/octet-stream",
  };
  return { objectBody, record, object };
}

function exportRepository(record: KnowledgeBundleExportRecord, object: KnowledgeBundleBlob) {
  return {
    exportDatasets: async () => KNOWLEDGE_BUNDLE_DATASETS.map((dataset) => ({
      dataset,
      record_count: dataset === record.dataset ? 1 : 0,
    })),
    exportRecords: async (_id: string, dataset: string, after: number) => (
      dataset === record.dataset && after === 0 ? [record] : []
    ),
    exportBlobs: async (_id: string, after: number) => after === 0 ? [object] : [],
    updateExportProgress: async () => undefined,
  } as unknown as KnowledgeBundleRepository;
}

describe("full knowledge bundle", () => {
  test("round-trips original UUID records and verifies a streamed byte frame", async () => {
    const { objectBody, record, object } = fixture();
    const exportStorage = {
      read: async (key: string) => {
        expect(key).toBe(object.blob_key);
        return new Blob([objectBody]);
      },
    } as unknown as BrokeredStorage;
    const archive = new Uint8Array(await new Response(streamFullKnowledgeBundle({
      intentId,
      repository: exportRepository(record, object),
      storage: exportStorage,
    })).arrayBuffer());
    expect(new TextDecoder().decode(archive.slice(0, KNOWLEDGE_BUNDLE_MAGIC.length)))
      .toBe(KNOWLEDGE_BUNDLE_MAGIC);

    const parts = [archive.slice(0, 31), archive.slice(31, 65_579), archive.slice(65_579)];
    const stored = new Map(parts.map((part, index) => [`imports/test/parts/${index}`, part]));
    const importedRecords: KnowledgeBundleExportRecord[] = [];
    const importedObjects: KnowledgeBundleBlob[] = [];
    let completed: { recordsTotal: number; objectsTotal: number; objectBytes: number } | null = null;
    const importRepository = {
      insertImportRecords: async (_id: string, records: KnowledgeBundleExportRecord[]) => {
        importedRecords.push(...records);
      },
      insertImportBlob: async (_id: string, value: KnowledgeBundleBlob) => {
        importedObjects.push(value);
      },
      updateImportProgress: async () => undefined,
      finishImportValidation: async (_id: string, _manifest: object, totals: typeof completed) => {
        completed = totals;
      },
    } as unknown as KnowledgeBundleRepository;
    const importStorage = {
      read: async (key: string) => new Blob([stored.get(key)!]),
    } as unknown as BrokeredStorage;
    await validateFullKnowledgeBundle({
      importId: "44444444-4444-4444-8444-444444444444",
      parts: parts.map((_part, index) => ({ object_key: `imports/test/parts/${index}` })),
      repository: importRepository,
      storage: importStorage,
    });

    expect(importedRecords).toEqual([record]);
    expect(importedObjects).toEqual([object]);
    expect(completed as { recordsTotal: number; objectsTotal: number; objectBytes: number } | null).toEqual({
      recordsTotal: 1,
      objectsTotal: 1,
      objectBytes: objectBody.byteLength,
    });
  });

  test("rejects a corrupted frame before accepting the bundle", async () => {
    const { objectBody, record, object } = fixture();
    const archive = new Uint8Array(await new Response(streamFullKnowledgeBundle({
      intentId,
      repository: exportRepository(record, object),
      storage: { read: async () => new Blob([objectBody]) } as unknown as BrokeredStorage,
    })).arrayBuffer());
    archive[Math.floor(archive.byteLength / 2)]! ^= 1;
    await expect(validateFullKnowledgeBundle({
      importId: "55555555-5555-4555-8555-555555555555",
      parts: [{ object_key: "imports/test/parts/0" }],
      repository: {
        insertImportRecords: async () => undefined,
        insertImportBlob: async () => undefined,
        updateImportProgress: async () => undefined,
        finishImportValidation: async () => undefined,
      } as unknown as KnowledgeBundleRepository,
      storage: { read: async () => new Blob([archive]) } as unknown as BrokeredStorage,
    })).rejects.toThrow("integrity verification");
  });
});
