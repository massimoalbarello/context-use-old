import { createHash } from "node:crypto";
import {
  KNOWLEDGE_BUNDLE_FORMAT,
  KNOWLEDGE_BUNDLE_DATASETS,
  KNOWLEDGE_BUNDLE_VERSION,
  type KnowledgeBundleExportRecord,
  type KnowledgeBundleObject,
  type KnowledgeBundleRepository,
} from "@context-use/database";
import type { BrokeredStorage } from "./storage-client.ts";

export const KNOWLEDGE_BUNDLE_CONTENT_TYPE = "application/vnd.context-use.knowledge-bundle";
export const KNOWLEDGE_BUNDLE_MAGIC = "CONTEXT-USE-KNOWLEDGE-BUNDLE-V1\n";
const MAX_HEADER_BYTES = 64 * 1024;
const supportedDatasets = new Set<string>(KNOWLEDGE_BUNDLE_DATASETS);

type BundleFrameHeader = {
  type: "manifest" | "record" | "object" | "end";
  length: number;
  sha256: string;
  dataset?: string;
  ordinal?: number;
  object_kind?: KnowledgeBundleObject["object_kind"];
  object_key?: string;
  content_type?: string;
};

type BundleManifest = {
  format: typeof KNOWLEDGE_BUNDLE_FORMAT;
  model_version: typeof KNOWLEDGE_BUNDLE_VERSION;
  created_at: string;
  datasets: Array<{ name: string; records: number }>;
};

function encoded(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function headerBytes(header: BundleFrameHeader): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(header)}\n`);
}

function bodyHeader(
  type: BundleFrameHeader["type"],
  body: Uint8Array,
  metadata: Omit<BundleFrameHeader, "type" | "length" | "sha256"> = {},
): Uint8Array {
  return headerBytes({
    type,
    length: body.byteLength,
    sha256: createHash("sha256").update(body).digest("hex"),
    ...metadata,
  });
}

async function* bundleBytes(input: {
  intentId: string;
  repository: KnowledgeBundleRepository;
  storage: BrokeredStorage;
}): AsyncGenerator<Uint8Array> {
  const { intentId, repository, storage } = input;
  let recordsCompleted = 0;
  let objectsCompleted = 0;
  let bytesCompleted = 0;
  yield new TextEncoder().encode(KNOWLEDGE_BUNDLE_MAGIC);

  const datasets = await repository.exportDatasets(intentId);
  const manifest: BundleManifest = {
    format: KNOWLEDGE_BUNDLE_FORMAT,
    model_version: KNOWLEDGE_BUNDLE_VERSION,
    created_at: new Date().toISOString(),
    datasets: datasets.map((dataset) => ({ name: dataset.dataset, records: dataset.record_count })),
  };
  const manifestBody = encoded(manifest);
  yield bodyHeader("manifest", manifestBody);
  yield manifestBody;

  for (const dataset of datasets) {
    let after = 0;
    while (true) {
      const records = await repository.exportRecords(intentId, dataset.dataset, after);
      if (!records.length) break;
      for (const record of records) {
        const body = encoded(record.record);
        yield bodyHeader("record", body, {
          dataset: record.dataset,
          ordinal: Number(record.ordinal),
        });
        yield body;
        after = Number(record.ordinal);
        recordsCompleted += 1;
        bytesCompleted += body.byteLength;
      }
      await repository.updateExportProgress(intentId, {
        phase: "records",
        recordsCompleted,
        objectsCompleted,
        bytesCompleted,
      });
    }
  }

  let afterObject = 0;
  while (true) {
    const objects = await repository.exportObjects(intentId, afterObject);
    if (!objects.length) break;
    for (const object of objects) {
      const sizeBytes = Number(object.size_bytes);
      const header: BundleFrameHeader = {
        type: "object",
        length: sizeBytes,
        sha256: object.content_hash,
        ordinal: Number(object.ordinal),
        object_kind: object.object_kind,
        object_key: object.object_key,
        content_type: object.content_type,
      };
      yield headerBytes(header);
      const body = new Response(await storage.read(object.object_key)).body;
      if (!body) throw new Error(`Knowledge object ${object.object_key} is unavailable`);
      const observedHash = createHash("sha256");
      let observedSize = 0;
      const reader = body.getReader();
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        observedSize += chunk.value.byteLength;
        if (observedSize > sizeBytes) throw new Error(`Knowledge object ${object.object_key} changed size`);
        observedHash.update(chunk.value);
        yield chunk.value;
      }
      if (observedSize !== sizeBytes || observedHash.digest("hex") !== object.content_hash) {
        throw new Error(`Knowledge object ${object.object_key} failed integrity verification`);
      }
      afterObject = Number(object.ordinal);
      objectsCompleted += 1;
      bytesCompleted += observedSize;
      await repository.updateExportProgress(intentId, {
        phase: "objects",
        recordsCompleted,
        objectsCompleted,
        bytesCompleted,
      });
    }
  }

  const end = encoded({ records: recordsCompleted, objects: objectsCompleted });
  yield bodyHeader("end", end);
  yield end;
}

export function streamFullKnowledgeBundle(input: {
  intentId: string;
  repository: KnowledgeBundleRepository;
  storage: BrokeredStorage;
}): ReadableStream<Uint8Array> {
  const iterator = bundleBytes(input);
  return new ReadableStream({
    async pull(controller) {
      const next = await iterator.next();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    async cancel(reason) {
      await iterator.throw?.(reason).catch(() => undefined);
    },
  });
}

class JoinedPartReader {
  private current: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private pending = new Uint8Array();
  private offset = 0;
  private partIndex = 0;

  constructor(
    private readonly parts: Array<{ object_key: string }>,
    private readonly storage: BrokeredStorage,
  ) {}

  private async fill(): Promise<boolean> {
    while (this.offset >= this.pending.byteLength) {
      const chunk = await this.current?.read();
      if (chunk && !chunk.done) {
        this.pending = new Uint8Array(chunk.value);
        this.offset = 0;
        return true;
      }
      this.current?.releaseLock();
      this.current = null;
      const part = this.parts[this.partIndex++];
      if (!part) return false;
      const body = new Response(await this.storage.read(part.object_key)).body;
      if (!body) throw new Error("Knowledge bundle upload part is unavailable");
      this.current = body.getReader();
    }
    return true;
  }

  async readExactly(length: number): Promise<Uint8Array> {
    if (!Number.isSafeInteger(length) || length < 0) throw new Error("Invalid knowledge bundle frame length");
    const result = new Uint8Array(length);
    let written = 0;
    while (written < length) {
      if (!await this.fill()) throw new Error("Knowledge bundle ended unexpectedly");
      const available = this.pending.byteLength - this.offset;
      const consumed = Math.min(available, length - written);
      result.set(this.pending.subarray(this.offset, this.offset + consumed), written);
      this.offset += consumed;
      written += consumed;
    }
    return result;
  }

  async readLine(): Promise<string | null> {
    const bytes: number[] = [];
    while (bytes.length <= MAX_HEADER_BYTES) {
      if (!await this.fill()) return bytes.length ? (() => { throw new Error("Truncated knowledge bundle header"); })() : null;
      const value = this.pending[this.offset++]!;
      if (value === 10) return new TextDecoder().decode(Uint8Array.from(bytes));
      bytes.push(value);
    }
    throw new Error("Knowledge bundle frame header is too large");
  }
}

function parseHeader(line: string): BundleFrameHeader {
  const parsed = JSON.parse(line) as Partial<BundleFrameHeader>;
  if (!["manifest", "record", "object", "end"].includes(parsed.type ?? "")
      || !Number.isSafeInteger(parsed.length) || Number(parsed.length) < 0
      || typeof parsed.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(parsed.sha256)) {
    throw new Error("Invalid knowledge bundle frame header");
  }
  return parsed as BundleFrameHeader;
}

type ObjectFrameHeader = BundleFrameHeader & Required<Pick<BundleFrameHeader,
  "ordinal" | "object_kind" | "object_key" | "content_type">>;

function validObjectHeader(header: BundleFrameHeader): header is ObjectFrameHeader {
  if (!header.object_kind || !header.object_key || !header.content_type) return false;
  const uuid = "[a-f0-9-]{36}";
  const keyMatches = header.object_kind === "private_revision"
    ? new RegExp(`^documents/private/${uuid}\\.md$`).test(header.object_key)
    : header.object_kind === "asset"
      ? new RegExp(`^objects/${uuid}$`).test(header.object_key)
      : header.object_kind === "public_asset"
        ? new RegExp(`^artifacts/public/${uuid}$`).test(header.object_key)
        : new RegExp(`^documents/public/${uuid}\\.md$`).test(header.object_key);
  return keyMatches && (!["private_revision", "retained_page", "public_page"].includes(header.object_kind)
    || header.content_type === "text/markdown; charset=utf-8");
}

async function readVerifiedBody(reader: JoinedPartReader, header: BundleFrameHeader): Promise<Uint8Array> {
  if (header.length > 64 * 1024 * 1024) throw new Error("Knowledge bundle metadata frame is too large");
  const body = await reader.readExactly(header.length);
  if (createHash("sha256").update(body).digest("hex") !== header.sha256) {
    throw new Error("Knowledge bundle frame failed integrity verification");
  }
  return body;
}

function verifiedFrameStream(
  reader: JoinedPartReader,
  header: BundleFrameHeader,
): { stream: ReadableStream<Uint8Array>; verified: Promise<void> } {
  let remaining = header.length;
  const hash = createHash("sha256");
  let resolveVerified!: () => void;
  let rejectVerified!: (error: unknown) => void;
  const verified = new Promise<void>((resolve, reject) => {
    resolveVerified = resolve;
    rejectVerified = reject;
  });
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (!remaining) {
          const observed = hash.digest("hex");
          if (observed !== header.sha256) throw new Error("Knowledge bundle frame failed integrity verification");
          controller.close();
          resolveVerified();
          return;
        }
        const chunk = await reader.readExactly(Math.min(64 * 1024, remaining));
        remaining -= chunk.byteLength;
        hash.update(chunk);
        controller.enqueue(chunk);
      } catch (error) {
        controller.error(error);
        rejectVerified(error);
      }
    },
    cancel(reason) {
      rejectVerified(reason ?? new Error("Knowledge bundle object consumption was cancelled"));
    },
  });
  return { stream, verified };
}

async function discardFrame(reader: JoinedPartReader, header: BundleFrameHeader): Promise<void> {
  const frame = verifiedFrameStream(reader, header);
  await Promise.all([
    (async () => {
      const body = frame.stream.getReader();
      while (!(await body.read()).done) {
        // Validation is deliberately streaming and keeps no object bytes in RAM.
      }
    })(),
    frame.verified,
  ]);
}

export async function validateFullKnowledgeBundle(input: {
  importId: string;
  parts: Array<{ object_key: string }>;
  repository: KnowledgeBundleRepository;
  storage: BrokeredStorage;
}): Promise<void> {
  const reader = new JoinedPartReader(input.parts, input.storage);
  if (await reader.readLine() !== KNOWLEDGE_BUNDLE_MAGIC.trimEnd()) {
    throw new Error("This is not a Context Use knowledge bundle");
  }
  let manifest: BundleManifest | null = null;
  let records = 0;
  let objects = 0;
  let objectBytes = 0;
  let sawEnd = false;
  const pendingRecords: KnowledgeBundleExportRecord[] = [];
  while (true) {
    const line = await reader.readLine();
    if (line === null) break;
    const header = parseHeader(line);
    const body = header.type === "object" ? null : await readVerifiedBody(reader, header);
    if (header.type === "manifest") {
      if (manifest || records || objects) throw new Error("Knowledge bundle manifest is out of order");
      const value = JSON.parse(new TextDecoder().decode(body!)) as BundleManifest;
      if (value.format !== KNOWLEDGE_BUNDLE_FORMAT || value.model_version !== KNOWLEDGE_BUNDLE_VERSION
          || !Array.isArray(value.datasets)
          || value.datasets.length !== KNOWLEDGE_BUNDLE_DATASETS.length
          || value.datasets.some((dataset, index) => dataset.name !== KNOWLEDGE_BUNDLE_DATASETS[index]
            || !Number.isSafeInteger(dataset.records) || dataset.records < 0)) {
        throw new Error("This knowledge bundle model version is not supported");
      }
      manifest = value;
    } else if (header.type === "record") {
      if (!manifest || sawEnd || typeof header.dataset !== "string" || !header.ordinal) {
        throw new Error("Invalid knowledge bundle record frame");
      }
      if (!supportedDatasets.has(header.dataset)) throw new Error("Knowledge bundle contains an unknown dataset");
      pendingRecords.push({
        dataset: header.dataset,
        ordinal: header.ordinal,
        record: JSON.parse(new TextDecoder().decode(body!)) as Record<string, unknown>,
      });
      records += 1;
      if (pendingRecords.length >= 250) {
        await input.repository.insertImportRecords(input.importId, pendingRecords.splice(0));
        await input.repository.updateImportProgress(input.importId, {
          phase: "records", recordsCompleted: records, objectsCompleted: objects, bytesCompleted: objectBytes,
        });
      }
    } else if (header.type === "object") {
      if (!manifest || sawEnd || !header.ordinal || !validObjectHeader(header)) {
        throw new Error("Invalid knowledge bundle object frame");
      }
      await discardFrame(reader, header);
      await input.repository.insertImportObject(input.importId, {
        ordinal: header.ordinal,
        object_kind: header.object_kind,
        object_key: header.object_key,
        size_bytes: header.length,
        content_hash: header.sha256,
        content_type: header.content_type,
      });
      objects += 1;
      objectBytes += header.length;
      await input.repository.updateImportProgress(input.importId, {
        phase: "objects", recordsCompleted: records, objectsCompleted: objects, bytesCompleted: objectBytes,
      });
    } else {
      const summary = JSON.parse(new TextDecoder().decode(body!)) as { records?: unknown; objects?: unknown };
      if (!manifest || sawEnd || summary.records !== records || summary.objects !== objects) {
        throw new Error("Knowledge bundle final counts do not match");
      }
      sawEnd = true;
    }
  }
  if (pendingRecords.length) await input.repository.insertImportRecords(input.importId, pendingRecords);
  if (!manifest || !sawEnd) throw new Error("Knowledge bundle is incomplete");
  const expectedRecords = manifest.datasets.reduce((total, dataset) => total + dataset.records, 0);
  if (expectedRecords !== records) throw new Error("Knowledge bundle dataset counts do not match");
  await input.repository.finishImportValidation(input.importId, manifest, {
    recordsTotal: records,
    objectsTotal: objects,
    objectBytes,
  });
}

export async function materializeFullKnowledgeBundle(input: {
  importId: string;
  parts: Array<{ object_key: string }>;
  repository: KnowledgeBundleRepository;
  storage: BrokeredStorage;
  principal: { ownerUserId: string; sessionId: string };
}): Promise<void> {
  const reader = new JoinedPartReader(input.parts, input.storage);
  if (await reader.readLine() !== KNOWLEDGE_BUNDLE_MAGIC.trimEnd()) {
    throw new Error("This is not a Context Use knowledge bundle");
  }
  let records = 0;
  let objects = 0;
  let bytes = 0;
  let sawEnd = false;
  while (true) {
    const line = await reader.readLine();
    if (line === null) break;
    const header = parseHeader(line);
    if (header.type === "object") {
      if (!header.ordinal || !validObjectHeader(header) || sawEnd) {
        throw new Error("Invalid knowledge bundle object frame");
      }
      const frame = verifiedFrameStream(reader, header);
      await Promise.all([
        input.storage.writeImportedObject({
          importId: input.importId,
          object: {
            object_key: header.object_key,
            size_bytes: header.length,
            content_hash: header.sha256,
            content_type: header.content_type,
          },
          body: frame.stream,
        }),
        frame.verified,
      ]);
      await input.repository.markImportObjectMaterialized(input.importId, header.ordinal);
      objects += 1;
      bytes += header.length;
      await input.repository.updateImportProgress(input.importId, {
        phase: "objects", recordsCompleted: records, objectsCompleted: objects, bytesCompleted: bytes,
      });
      continue;
    }
    const body = await readVerifiedBody(reader, header);
    if (header.type === "record") records += 1;
    if (header.type === "end") {
      const summary = JSON.parse(new TextDecoder().decode(body)) as { records?: unknown; objects?: unknown };
      if (summary.records !== records || summary.objects !== objects) {
        throw new Error("Knowledge bundle final counts do not match during restore");
      }
      sawEnd = true;
    }
  }
  if (!sawEnd) throw new Error("Knowledge bundle is incomplete");
  await input.repository.updateImportProgress(input.importId, {
    phase: "database", recordsCompleted: records, objectsCompleted: objects, bytesCompleted: bytes,
  });
  await input.repository.restoreImport(input.importId, input.principal);
}
