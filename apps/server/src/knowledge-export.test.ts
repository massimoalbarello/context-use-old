import { describe, expect, test } from "bun:test";
import type { KnowledgeExportSnapshot } from "@context-use/database";
import { BlobReader, BlobWriter, TextWriter, ZipReader } from "@zip.js/zip.js";
import { planKnowledgeExport, streamKnowledgeExport } from "./knowledge-export.ts";
import type { ObjectStorage } from "./storage.ts";
import { isFinalizedZipFooter, zipFooterRange } from "./zip-footer.ts";

const documentOne = "11111111-1111-4111-8111-111111111111";
const documentTwo = "22222222-2222-4222-8222-222222222222";
const assetOne = "33333333-3333-4333-8333-333333333333";
const revisionOne = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const revisionTwo = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function snapshot(): KnowledgeExportSnapshot {
  return {
    pages: [
      {
        document_id: documentOne,
        current_revision_id: revisionOne,
        title: "Q3 Brief",
        summary: "The current Acme briefing.",
        body_markdown: [
          `[Other](context-use://page/${documentTwo}#overview)`,
          `![Site photo](context-use://asset/${assetOne})`,
        ].join("\n\n"),
      },
      {
        document_id: documentTwo,
        current_revision_id: revisionTwo,
        title: "Other Note",
        summary: "A note referenced by the Acme brief.",
        body_markdown: `Back to [brief](context-use://document/${documentOne}).`,
      },
    ],
    assets: [{
      document_id: assetOne,
      filename: "site/photo.jpg",
      content_type: "image/jpeg",
      size_bytes: 11,
      content_hash: "a".repeat(64),
      s3_object_key: `objects/${assetOne}`,
    }],
    links: [
      {
        source_document_id: documentOne,
        source_revision_id: revisionOne,
        target_document_id: documentTwo,
      },
      {
        source_document_id: documentOne,
        source_revision_id: revisionOne,
        target_document_id: assetOne,
      },
      {
        source_document_id: documentTwo,
        source_revision_id: revisionTwo,
        target_document_id: documentOne,
      },
    ],
  };
}

describe("portable knowledge export", () => {
  test("plans a deterministic UUID graph without compatibility paths", () => {
    const planned = planKnowledgeExport(snapshot());

    expect(planned.pages.map(({ archivePath }) => archivePath)).toEqual([
      `documents/${documentOne}.md`,
      `documents/${documentTwo}.md`,
    ]);
    expect(planned.assets[0]?.archivePath).toBe(`assets/${assetOne}/photo.jpg`);
    expect(planned.pages[0]?.body).toContain(`context-use://document/${documentTwo}`);
    expect(planned.pages[0]?.body).toContain(`context-use://document/${assetOne}`);
    expect(planned.manifest).toMatchObject({
      schema: "context-use-hypermedia-export/v1",
      documents: [
        { document_id: documentOne, current_revision_id: revisionOne },
        { document_id: documentTwo, current_revision_id: revisionTwo },
        { document_id: assetOne, document_kind: "asset", size_bytes: 11 },
      ],
      links: expect.arrayContaining([
        {
          source_document_id: documentOne,
          source_revision_id: revisionOne,
          target_document_id: documentTwo,
        },
      ]),
    });
    const serialized = JSON.stringify(planned.manifest);
    expect(serialized).not.toContain("current_path");
    expect(serialized).not.toContain("public_path");
    expect(serialized).not.toContain("s3_object_key");
  });

  test("streams a standard ZIP graph containing the manifest, Markdown and original asset bytes", async () => {
    const assetBytes = new TextEncoder().encode("asset-bytes");
    const storage: ObjectStorage = {
      write: async () => undefined,
      delete: async () => undefined,
      verify: async () => true,
      read: async (key) => {
        expect(key).toBe(`objects/${assetOne}`);
        return new Blob([assetBytes]);
      },
    };
    const archive = await new Response(streamKnowledgeExport(snapshot(), storage)).blob();
    const archiveBytes = new Uint8Array(await archive.arrayBuffer());
    const footerRange = zipFooterRange(archiveBytes.byteLength)!;
    expect(isFinalizedZipFooter(archiveBytes.slice(footerRange.start, footerRange.end + 1))).toBe(true);
    const reader = new ZipReader(new BlobReader(archive), { useWebWorkers: false });
    const entries = await reader.getEntries();
    expect(entries.map(({ filename }) => filename)).toEqual([
      "context-use-export/",
      "context-use-export/manifest.json",
      "context-use-export/documents/",
      `context-use-export/documents/${documentOne}.md`,
      `context-use-export/documents/${documentTwo}.md`,
      "context-use-export/assets/",
      `context-use-export/assets/${assetOne}/`,
      `context-use-export/assets/${assetOne}/photo.jpg`,
    ]);
    expect(entries.filter(({ directory }) => !directory).every(({ compressionMethod }) => compressionMethod === 0)).toBeTrue();
    const manifest = entries.find(({ filename }) => filename.endsWith("manifest.json"))!;
    if (!("getData" in manifest)) throw new Error("Expected the manifest to be a file");
    expect(JSON.parse(await manifest.getData(new TextWriter()))).toMatchObject({
      schema: "context-use-hypermedia-export/v1",
    });
    const asset = entries.find(({ filename }) => filename.endsWith("photo.jpg"))!;
    if (!("getData" in asset)) throw new Error("Expected the exported asset to be a file");
    expect(new Uint8Array(await (await asset.getData(new BlobWriter())).arrayBuffer())).toEqual(assetBytes);
    await reader.close();
  });

  test("produces a valid empty graph export", async () => {
    const storage: ObjectStorage = {
      write: async () => undefined,
      delete: async () => undefined,
      verify: async () => true,
      read: async () => { throw new Error("No asset read expected"); },
    };
    const archive = await new Response(streamKnowledgeExport({
      pages: [],
      assets: [],
      links: [],
    }, storage)).blob();
    const reader = new ZipReader(new BlobReader(archive), { useWebWorkers: false });
    const entries = await reader.getEntries();
    expect(entries.map(({ filename }) => filename)).toEqual([
      "context-use-export/",
      "context-use-export/manifest.json",
      "context-use-export/documents/",
      "context-use-export/assets/",
    ]);
    await reader.close();
  });
});
