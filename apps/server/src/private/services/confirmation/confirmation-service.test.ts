import { describe, expect, test } from "bun:test";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { ConfirmationService, type ConfirmationStore } from "./confirmation-service.ts";

const intentId = "11111111-1111-4111-8111-111111111111";

function store(overrides: Partial<ConfirmationStore> = {}): ConfirmationStore {
  return {
    passkeys: async () => [],
    issueChallenge: async () => undefined,
    publicationIntent: async () => null,
    confirmPublication: async () => undefined,
    pageDeletionIntent: async () => null,
    confirmPageDeletion: async () => undefined,
    ...overrides,
  };
}

function service(confirmations: ConfirmationStore) {
  return new ConfirmationService({
    confirmations,
    appOrigin: "https://context.example",
    rpId: "context.example",
  });
}

function browserInput(sessionId = "session-owner") {
  return {
    principal: { owner_user_id: "context-use-owner" as const, session_id: sessionId },
    confirmation: {
      intent_id: intentId,
      response: {} as AuthenticationResponseJSON,
    },
  };
}

describe("confirmation service", () => {
  test("does not inspect a passkey or mutate an intent owned by another session", async () => {
    let passkeyReads = 0;
    let confirmations = 0;
    const result = await service(
      store({
        passkeys: () => {
          passkeyReads += 1;
          return Promise.resolve([]);
        },
        publicationIntent: async () => ({
          id: intentId,
          action: "publish",
          target_kind: "page",
          target_id: "22222222-2222-4222-8222-222222222222",
          version_id: "33333333-3333-4333-8333-333333333333",
          owner_user_id: "context-use-owner",
          session_id: "another-session",
          challenge: "challenge",
          expires_at: new Date(Date.now() + 60_000),
        }),
        confirmPublication: () => {
          confirmations += 1;
          return Promise.resolve();
        },
      }),
    ).confirm({ kind: "publication", input: browserInput() });

    expect(result).toEqual({ state: "not_found", message: "Publication intent not found" });
    expect(passkeyReads).toBe(0);
    expect(confirmations).toBe(0);
  });

  test("does not issue a challenge when the owner has no passkey", async () => {
    let challenges = 0;
    const options = await service(
      store({
        issueChallenge: () => {
          challenges += 1;
          return Promise.resolve();
        },
      }),
    ).options({ kind: "publication", intentId });

    expect(options).toBeNull();
    expect(challenges).toBe(0);
  });
});
