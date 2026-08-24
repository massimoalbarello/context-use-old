import { describe, expect, test } from "bun:test";
import {
  publicationArtifactReceiptSchema,
  publicationEntrypointSchema,
  publicationIntentSchema,
  publicRouteSchema,
} from "./index.ts";

const documentId = "00000000-0000-4000-8000-000000000010";
const revisionId = "00000000-0000-4000-8000-000000000020";
const pageIntentId = "00000000-0000-4000-8000-000000000021";
const assetIntentId = "00000000-0000-4000-8000-000000000022";
const firstPublicId = "11111111-1111-4111-8111-aaaaaaaaaaaa";
const secondPublicId = "22222222-2222-4222-8222-bbbbbbbbbbbb";
const hash = (digit: string): string => digit.repeat(64);

const pageReceipt = {
  intent_id: pageIntentId,
  target_kind: "page" as const,
  body_size_bytes: 128,
  body_content_hash: hash("a"),
  public_title: "Public title",
  public_summary: "A concise public summary.",
  public_last_edited_at: "2026-08-23T12:34:56.000Z",
  projected_target_public_ids: [firstPublicId, secondPublicId],
  observed_public_uuid_tokens: [firstPublicId, secondPublicId],
  projection_receipt_hash: hash("b"),
};

const assetReceipt = {
  intent_id: assetIntentId,
  target_kind: "asset" as const,
  body_size_bytes: 256,
  body_content_hash: hash("c"),
  public_filename: "portrait.jpg",
  public_content_type: "image/jpeg",
  public_width: 1200,
  public_height: 1500,
  public_duration_seconds: null,
};

describe("publication shared contracts", () => {
  test("accepts exactly four intent variants", () => {
    for (const intent of [
      {
        action: "publish",
        target_kind: "page",
        target_document_id: documentId,
        expected_revision_id: revisionId,
      },
      { action: "unpublish", target_kind: "page", target_document_id: documentId },
      { action: "publish", target_kind: "asset", target_document_id: documentId },
      { action: "unpublish", target_kind: "asset", target_document_id: documentId },
    ]) {
      expect(publicationIntentSchema.safeParse(intent).success).toBe(true);
    }

    for (const intent of [
      { action: "publish", target_kind: "page", target_document_id: documentId },
      {
        action: "unpublish",
        target_kind: "page",
        target_document_id: documentId,
        expected_revision_id: revisionId,
      },
      {
        action: "publish",
        target_kind: "asset",
        target_document_id: documentId,
        expected_revision_id: revisionId,
      },
      { action: "publish", target_kind: "asset", target_document_id: documentId, extra: true },
    ]) {
      expect(publicationIntentSchema.safeParse(intent).success).toBe(false);
    }
  });

  test("discriminates page and asset staging receipts", () => {
    expect(publicationArtifactReceiptSchema.parse(pageReceipt)).toEqual(pageReceipt);
    expect(publicationArtifactReceiptSchema.parse(assetReceipt)).toEqual(assetReceipt);
    expect(publicationArtifactReceiptSchema.safeParse({
      ...pageReceipt,
      public_filename: "leak.txt",
    }).success).toBe(false);
    expect(publicationArtifactReceiptSchema.safeParse({
      ...assetReceipt,
      projected_target_public_ids: [],
    }).success).toBe(false);
    expect(publicationArtifactReceiptSchema.safeParse({
      ...pageReceipt,
      representation_token: hash("d"),
    }).success).toBe(false);

    const { intent_id: _missingPageIntentId, ...pageWithoutIntentId } = pageReceipt;
    const { intent_id: _missingAssetIntentId, ...assetWithoutIntentId } = assetReceipt;
    expect(publicationArtifactReceiptSchema.safeParse(pageWithoutIntentId).success).toBe(false);
    expect(publicationArtifactReceiptSchema.safeParse(assetWithoutIntentId).success).toBe(false);
    expect(publicationArtifactReceiptSchema.safeParse({
      ...pageReceipt,
      intentId: pageIntentId,
    }).success).toBe(false);
    expect(publicationArtifactReceiptSchema.safeParse({
      ...pageReceipt,
      target_kind: "asset",
      intent_id: assetIntentId,
    }).success).toBe(false);
  });

  test("enforces receipt hashes, metadata bounds, and timestamp syntax", () => {
    expect(publicationArtifactReceiptSchema.safeParse({
      ...pageReceipt,
      body_content_hash: "A".repeat(64),
    }).success).toBe(false);
    expect(publicationArtifactReceiptSchema.safeParse({
      ...pageReceipt,
      projection_receipt_hash: "a".repeat(63),
    }).success).toBe(false);
    expect(publicationArtifactReceiptSchema.safeParse({
      ...pageReceipt,
      body_size_bytes: 4_000_001,
    }).success).toBe(false);
    expect(publicationArtifactReceiptSchema.safeParse({
      ...pageReceipt,
      public_title: "x".repeat(241),
    }).success).toBe(false);
    expect(publicationArtifactReceiptSchema.safeParse({
      ...pageReceipt,
      public_summary: "first\nsecond",
    }).success).toBe(false);
    expect(publicationArtifactReceiptSchema.safeParse({
      ...pageReceipt,
      public_last_edited_at: "2026-08-23 12:34:56",
    }).success).toBe(false);
    expect(publicationArtifactReceiptSchema.safeParse({
      ...assetReceipt,
      public_filename: "../portrait.jpg",
    }).success).toBe(false);
    expect(publicationArtifactReceiptSchema.safeParse({
      ...assetReceipt,
      public_content_type: "image/jpeg\r\nX-Leak: 1",
    }).success).toBe(false);
    expect(publicationArtifactReceiptSchema.safeParse({
      ...assetReceipt,
      public_width: 0,
    }).success).toBe(false);
    expect(publicationArtifactReceiptSchema.safeParse({
      ...assetReceipt,
      body_size_bytes: 5_000_000_001,
    }).success).toBe(false);
    expect(publicationArtifactReceiptSchema.safeParse({
      ...assetReceipt,
      public_duration_seconds: "1234567890.12345678901234567890",
    }).success).toBe(true);
    expect(publicationArtifactReceiptSchema.safeParse({
      ...assetReceipt,
      public_duration_seconds: 1.25,
    }).success).toBe(false);
    for (const duration of ["-1", "+1", "01", "1e3", ".5", "1."]) {
      expect(publicationArtifactReceiptSchema.safeParse({
        ...assetReceipt,
        public_duration_seconds: duration,
      }).success).toBe(false);
    }
  });

  test("requires bounded, sorted, unique lowercase UUID arrays", () => {
    expect(publicationArtifactReceiptSchema.safeParse({
      ...pageReceipt,
      projected_target_public_ids: [secondPublicId, firstPublicId],
    }).success).toBe(false);
    expect(publicationArtifactReceiptSchema.safeParse({
      ...pageReceipt,
      projected_target_public_ids: [firstPublicId, firstPublicId],
    }).success).toBe(false);
    expect(publicationArtifactReceiptSchema.safeParse({
      ...pageReceipt,
      projected_target_public_ids: [firstPublicId.toUpperCase()],
      observed_public_uuid_tokens: [firstPublicId.toUpperCase()],
    }).success).toBe(false);
    expect(publicationArtifactReceiptSchema.safeParse({
      ...pageReceipt,
      observed_public_uuid_tokens: [firstPublicId],
    }).success).toBe(false);

    const tooManyIds = Array.from({ length: 100_001 }, (_, index) => (
      `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`
    ));
    expect(publicationArtifactReceiptSchema.safeParse({
      ...pageReceipt,
      projected_target_public_ids: tooManyIds,
    }).success).toBe(false);
  });

  test("accepts only exact public resolver routes", () => {
    for (const route of [
      "/p/",
      "/p/about/",
      "/p/about/intro",
      "/p/about/intro.md",
      `/p/${firstPublicId}`,
      `/p/${firstPublicId}.md`,
      "/a/media/portrait",
      `/a/${firstPublicId}`,
    ]) {
      expect(publicRouteSchema.safeParse(route).success).toBe(true);
    }
    for (const route of [
      "/p",
      "/a/",
      "/p/About",
      "/p/about//intro",
      "/p/about?preview=true",
      "/p/about#section",
      "/p/about.md/",
      "/p//",
      "/a/media/portrait/",
      `/p/${firstPublicId.toUpperCase()}`,
      "https://example.test/p/about",
      `/p/${"a".repeat(513)}`,
    ]) {
      expect(publicRouteSchema.safeParse(route).success).toBe(false);
    }
  });

  test("sets or clears the entrypoint by public identity", () => {
    expect(publicationEntrypointSchema.parse({ public_id: firstPublicId })).toEqual({
      public_id: firstPublicId,
    });
    expect(publicationEntrypointSchema.parse({ public_id: null })).toEqual({ public_id: null });
    expect(publicationEntrypointSchema.safeParse({ entrypoint_public_id: firstPublicId }).success)
      .toBe(false);
    expect(publicationEntrypointSchema.safeParse({}).success).toBe(false);
  });
});
