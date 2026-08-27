import { expect, test } from "bun:test";
import {
  createKnowledgeGuideReceipt,
  type KnowledgeGuideReceiptContext,
  type KnowledgeGuideRevision,
  verifyKnowledgeGuideReceipt,
} from "#private/services/mcp/guidance-receipt.ts";

const guide: KnowledgeGuideRevision = {
  pageId: "11111111-1111-4111-8111-111111111111",
  revisionId: "22222222-2222-4222-8222-222222222222",
};

const context: KnowledgeGuideReceiptContext = {
  clientId: "mcp-client",
  sessionId: "mcp-session",
};

test("knowledge guide receipts bind one guide revision to one MCP session", () => {
  const receipt = createKnowledgeGuideReceipt(guide, context);
  const [, encodedManifest] = receipt.split(".");

  expect(receipt).toStartWith("cu-knowledge-guide-v1.");
  expect(JSON.parse(Buffer.from(encodedManifest!, "base64url").toString("utf8"))).toEqual([
    guide.pageId,
    guide.revisionId,
    context.clientId,
    context.sessionId,
  ]);
  expect(verifyKnowledgeGuideReceipt(receipt, { ...guide }, { ...context })).toBe(true);
  expect(
    verifyKnowledgeGuideReceipt(
      receipt,
      {
        ...guide,
        revisionId: "33333333-3333-4333-8333-333333333333",
      },
      context,
    ),
  ).toBe(false);
  expect(
    verifyKnowledgeGuideReceipt(
      receipt,
      {
        ...guide,
        pageId: "44444444-4444-4444-8444-444444444444",
      },
      context,
    ),
  ).toBe(false);
  expect(
    verifyKnowledgeGuideReceipt(receipt, guide, {
      ...context,
      clientId: "another-client",
    }),
  ).toBe(false);
  expect(
    verifyKnowledgeGuideReceipt(receipt, guide, {
      ...context,
      sessionId: "another-session",
    }),
  ).toBe(false);
});

test("rejects a tampered knowledge guide receipt", () => {
  const receipt = createKnowledgeGuideReceipt(guide, context);
  const [prefix, encodedManifest, signature] = receipt.split(".");
  const decoded = JSON.parse(Buffer.from(encodedManifest!, "base64url").toString("utf8"));
  decoded[1] = "33333333-3333-4333-8333-333333333333";
  const tamperedManifest = Buffer.from(JSON.stringify(decoded)).toString("base64url");
  const tampered = `${prefix}.${tamperedManifest}.${signature}`;

  expect(verifyKnowledgeGuideReceipt(tampered, guide, context)).toBe(false);
  expect(verifyKnowledgeGuideReceipt(`${receipt}x`, guide, context)).toBe(false);
  expect(verifyKnowledgeGuideReceipt("not-a-receipt", guide, context)).toBe(false);
});

test("rejects invalid guide or context inputs", () => {
  expect(() =>
    createKnowledgeGuideReceipt(
      {
        ...guide,
        pageId: "not-a-page-id",
      },
      context,
    ),
  ).toThrow("Knowledge guide object and revision IDs must be UUIDs");
  expect(() =>
    createKnowledgeGuideReceipt(guide, {
      ...context,
      sessionId: "",
    }),
  ).toThrow("Knowledge guide receipt context is invalid");

  const receipt = createKnowledgeGuideReceipt(guide, context);
  expect(
    verifyKnowledgeGuideReceipt(
      receipt,
      {
        ...guide,
        revisionId: "not-a-revision-id",
      },
      context,
    ),
  ).toBe(false);
});
