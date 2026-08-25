import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "./config.ts";

export type KnowledgeGuideRevision = {
  pageId: string;
  revisionId: string;
};

export type KnowledgeGuideReceiptContext = {
  clientId: string;
  sessionId: string;
};

const RECEIPT_PREFIX = "cu-knowledge-guide-v1";
const MAX_RECEIPT_LENGTH = 8_192;
const MAX_CONTEXT_ID_LENGTH = 512;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type ReceiptManifest = [
  pageId: string,
  revisionId: string,
  clientId: string,
  sessionId: string,
];

function validContextId(value: string): boolean {
  return value.length >= 1 && value.length <= MAX_CONTEXT_ID_LENGTH;
}

function manifest(
  guide: KnowledgeGuideRevision,
  context: KnowledgeGuideReceiptContext,
): ReceiptManifest {
  if (!UUID.test(guide.pageId) || !UUID.test(guide.revisionId)) {
    throw new Error("Knowledge guide object and revision IDs must be UUIDs");
  }
  if (!validContextId(context.clientId) || !validContextId(context.sessionId)) {
    throw new Error("Knowledge guide receipt context is invalid");
  }
  return [guide.pageId, guide.revisionId, context.clientId, context.sessionId];
}

function receiptSignature(encodedManifest: string): Buffer {
  return createHmac("sha256", config.MCP_ASSET_CAPABILITY_SECRET)
    .update("context-use:mcp-knowledge-guide:v1\0")
    .update(encodedManifest)
    .digest();
}

export function createKnowledgeGuideReceipt(
  guide: KnowledgeGuideRevision,
  context: KnowledgeGuideReceiptContext,
): string {
  const encodedManifest = Buffer.from(JSON.stringify(manifest(guide, context)), "utf8")
    .toString("base64url");
  return `${RECEIPT_PREFIX}.${encodedManifest}.${receiptSignature(encodedManifest).toString("base64url")}`;
}

function receiptManifest(receipt: string): ReceiptManifest | null {
  if (receipt.length > MAX_RECEIPT_LENGTH) return null;
  const [prefix, encodedManifest, encodedSignature, ...extra] = receipt.split(".");
  if (prefix !== RECEIPT_PREFIX || !encodedManifest || !encodedSignature || extra.length) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(encodedManifest) || !/^[A-Za-z0-9_-]+$/.test(encodedSignature)) {
    return null;
  }

  const suppliedSignature = Buffer.from(encodedSignature, "base64url");
  if (suppliedSignature.toString("base64url") !== encodedSignature) return null;
  const expectedSignature = receiptSignature(encodedManifest);
  if (suppliedSignature.length !== expectedSignature.length
    || !timingSafeEqual(suppliedSignature, expectedSignature)) return null;

  const manifestBuffer = Buffer.from(encodedManifest, "base64url");
  if (manifestBuffer.toString("base64url") !== encodedManifest) return null;
  let value: unknown;
  try {
    value = JSON.parse(manifestBuffer.toString("utf8"));
  } catch {
    return null;
  }
  if (!Array.isArray(value) || value.length !== 4) return null;
  const [pageId, revisionId, clientId, sessionId] = value;
  if (typeof pageId !== "string" || !UUID.test(pageId)
    || typeof revisionId !== "string" || !UUID.test(revisionId)
    || typeof clientId !== "string" || !validContextId(clientId)
    || typeof sessionId !== "string" || !validContextId(sessionId)) return null;
  return [pageId, revisionId, clientId, sessionId];
}

export function verifyKnowledgeGuideReceipt(
  receipt: string,
  guide: KnowledgeGuideRevision,
  context: KnowledgeGuideReceiptContext,
): boolean {
  let expected: ReceiptManifest;
  try {
    expected = manifest(guide, context);
  } catch {
    return false;
  }
  const actual = receiptManifest(receipt);
  return actual !== null
    && actual.every((value, index) => value === expected[index]);
}
