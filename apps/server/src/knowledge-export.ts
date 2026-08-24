import type {
  KnowledgeExportAsset,
  KnowledgeExportLink,
  KnowledgeExportPage,
  KnowledgeExportSnapshot,
} from "@context-use/database";
import type { ObjectStorage } from "./storage.ts";
import {
  addKnowledgeZipDirectory,
  addKnowledgeZipText,
  addStoredKnowledgeAsset,
  streamKnowledgeZip,
  type KnowledgeZipWriter,
} from "./knowledge-zip.ts";

const EXPORT_ROOT = "context-use-export";
const MAX_FILENAME_BYTES = 180;

export type KnowledgeGraphManifest = {
  schema: "context-use-hypermedia-export/v1";
  documents: Array<
    | {
      document_id: string;
      document_kind: "knowledge";
      current_revision_id: string;
      title: string;
      summary: string;
      content_path: string;
    }
    | {
      document_id: string;
      document_kind: "asset";
      filename: string;
      content_type: string;
      size_bytes: number;
      content_hash: string;
      content_path: string;
    }
  >;
  links: KnowledgeExportLink[];
};

export type PlannedKnowledgeExport = {
  manifest: KnowledgeGraphManifest;
  pages: Array<KnowledgeExportPage & { archivePath: string; body: string }>;
  assets: Array<KnowledgeExportAsset & { archivePath: string }>;
};

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (utf8Length(value) <= maxBytes) return value;
  let result = "";
  for (const character of value) {
    if (utf8Length(result + character) > maxBytes) break;
    result += character;
  }
  return result;
}

function safeFilename(value: string): string {
  let safe = value.normalize("NFC")
    .split(/[\\/]/).at(-1)!
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "");
  if (!safe || safe === "." || safe === "..") safe = "asset";
  const stem = safe.split(".")[0] ?? safe;
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem)) safe = `_${safe}`;
  return truncateUtf8(safe, MAX_FILENAME_BYTES) || "asset";
}

export function planKnowledgeExport(snapshot: KnowledgeExportSnapshot): PlannedKnowledgeExport {
  const pages = [...snapshot.pages]
    .sort((left, right) => left.document_id.localeCompare(right.document_id))
    .map((page) => ({
      ...page,
      archivePath: `documents/${page.document_id}.md`,
      body: page.body_markdown,
    }));
  const assets = [...snapshot.assets]
    .sort((left, right) => left.document_id.localeCompare(right.document_id))
    .map((asset) => ({
      ...asset,
      archivePath: `assets/${asset.document_id}/${safeFilename(asset.filename)}`,
    }));
  const links = [...snapshot.links].sort((left, right) => (
    left.source_document_id.localeCompare(right.source_document_id)
      || left.source_revision_id.localeCompare(right.source_revision_id)
      || left.target_document_id.localeCompare(right.target_document_id)
  ));
  return {
    pages,
    assets,
    manifest: {
      schema: "context-use-hypermedia-export/v1",
      documents: [
        ...pages.map((page) => ({
          document_id: page.document_id,
          document_kind: "knowledge" as const,
          current_revision_id: page.current_revision_id,
          title: page.title,
          summary: page.summary,
          content_path: page.archivePath,
        })),
        ...assets.map((asset) => ({
          document_id: asset.document_id,
          document_kind: "asset" as const,
          filename: asset.filename,
          content_type: asset.content_type,
          size_bytes: Number(asset.size_bytes),
          content_hash: asset.content_hash,
          content_path: asset.archivePath,
        })),
      ].sort((left, right) => left.document_id.localeCompare(right.document_id)),
      links,
    },
  };
}

async function writeKnowledgeExport(
  zip: KnowledgeZipWriter,
  planned: PlannedKnowledgeExport,
  storage: ObjectStorage,
  signal: AbortSignal,
): Promise<void> {
  await addKnowledgeZipDirectory(zip, `${EXPORT_ROOT}/`, signal);
  await addKnowledgeZipText(
    zip,
    `${EXPORT_ROOT}/manifest.json`,
    `${JSON.stringify(planned.manifest, null, 2)}\n`,
    signal,
  );
  await addKnowledgeZipDirectory(zip, `${EXPORT_ROOT}/documents/`, signal);
  for (const page of planned.pages) {
    await addKnowledgeZipText(zip, `${EXPORT_ROOT}/${page.archivePath}`, page.body, signal);
  }
  await addKnowledgeZipDirectory(zip, `${EXPORT_ROOT}/assets/`, signal);
  for (const asset of planned.assets) {
    await addKnowledgeZipDirectory(zip, `${EXPORT_ROOT}/assets/${asset.document_id}/`, signal);
    await addStoredKnowledgeAsset(zip, `${EXPORT_ROOT}/${asset.archivePath}`, asset, storage, signal);
  }
}

export function streamKnowledgeExport(
  snapshot: KnowledgeExportSnapshot,
  storage: ObjectStorage,
): ReadableStream<Uint8Array> {
  const planned = planKnowledgeExport(snapshot);
  return streamKnowledgeZip((zip, signal) => writeKnowledgeExport(zip, planned, storage, signal));
}
