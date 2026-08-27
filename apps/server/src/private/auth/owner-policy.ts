import { createHash, timingSafeEqual } from "node:crypto";

export const ownerUserId = "context-use-owner";
const developmentSetupTokenHash =
  "0c3f0f8b90068b05d8039bf05db2da4742c31a23e51cfa864a96a0efe17b1694";

export function normalizeOwnerEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isVerifiedOwner(
  email: string | null | undefined,
  verified: boolean | null | undefined,
  expectedEmail = "owner@example.com",
): boolean {
  return Boolean(verified && email?.trim().toLowerCase() === normalizeOwnerEmail(expectedEmail));
}

/**
 * Why a verified passkey still cannot be given a session. Better Auth reports
 * anything that goes wrong once a passkey verifies as a bare "Authentication
 * failed", so these causes are distinguished before it gets that far and the
 * login screen turns each `code` into a sentence the owner can act on.
 */
export function ownerSessionRejection(
  owner: { email: string; emailVerified: boolean } | null,
  expectedEmail = "owner@example.com",
): { message: string; code: string } | null {
  if (!owner) {
    return { message: "This installation has no owner identity", code: "OWNER_IDENTITY_MISSING" };
  }
  if (!isVerifiedOwner(owner.email, owner.emailVerified, expectedEmail)) {
    return {
      message: "The owner identity does not match this installation",
      code: "OWNER_IDENTITY_MISMATCHED",
    };
  }
  return null;
}

export function ownerSetupContext(
  context: string | null | undefined,
  expectedEmail = "owner@example.com",
  expectedTokenHash = developmentSetupTokenHash,
): { email: string } | null {
  if (!context || context.length > 1_024) {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(context);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "email" && key !== "token")) {
    return null;
  }
  if (typeof record.email !== "string" || typeof record.token !== "string") {
    return null;
  }
  const email = record.email.trim().toLowerCase();
  if (
    email !== expectedEmail.trim().toLowerCase() ||
    !/^[A-Za-z0-9_-]{43,128}$/.test(record.token)
  ) {
    return null;
  }

  const expected = Buffer.from(expectedTokenHash, "hex");
  const supplied = createHash("sha256").update(record.token).digest();
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
    return null;
  }
  return { email };
}
