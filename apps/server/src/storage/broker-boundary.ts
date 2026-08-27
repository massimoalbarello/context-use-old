import { timingSafeEqual } from "node:crypto";
import type { BlobStorageBackend, ByteRange } from "#storage/object-storage.ts";
import type { StorageBrokerTokens } from "./broker-contracts.ts";

function sameSecret({ left, right }: { left: string; right: string }): boolean {
  if (!left || !right) {
    return false;
  }
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function bearer(request: Request): string {
  return request.headers.get("authorization")?.match(/^Bearer ([A-Za-z0-9_-]{32,256})$/)?.[1] ?? "";
}

export function privateAuthorized({
  request,
  tokens,
}: {
  request: Request;
  tokens: StorageBrokerTokens;
}): boolean {
  const supplied = bearer(request);
  return sameSecret({ left: supplied, right: tokens.private });
}

export function publicAuthorized({
  request,
  tokens,
}: {
  request: Request;
  tokens: StorageBrokerTokens;
}): boolean {
  return sameSecret({ left: bearer(request), right: tokens.public });
}

export function denied(): Response {
  return new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });
}

export function parseRange(value: string | null): ByteRange | undefined {
  const match = value?.match(/^bytes=(\d+)-(\d+)$/);
  if (!match) {
    return undefined;
  }
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
    return undefined;
  }
  return { start, end };
}

export async function readBlob({
  storage,
  blobKey,
  range,
}: {
  storage: BlobStorageBackend;
  blobKey: string;
  range: ByteRange | undefined;
}): Promise<Response> {
  try {
    const body = await storage.read(blobKey, range);
    return new Response(body, {
      status: range ? 206 : 200,
      headers: { "cache-control": "no-store" },
    });
  } catch {
    return denied();
  }
}
