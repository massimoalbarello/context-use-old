import { describe, expect, test } from "bun:test";
import type {
  PublicationIntent,
  PublicationRepository,
  PublicEntrypointRepository,
} from "@context-use/database/publication";
import type { issueConfirmationOptions } from "../confirmation-client.ts";
import { DashboardPublicationService } from "./dashboard-publication-service.ts";

const principal = {
  userId: "context-use-owner",
  sessionId: "owner-session",
  email: "owner@example.com",
};

function serviceFor({ action, events }: { action: "publish" | "unpublish"; events: string[] }) {
  const intent: PublicationIntent =
    action === "publish"
      ? {
          id: "11111111-1111-4111-8111-111111111111",
          action,
          target_kind: "asset",
          target_object_id: "22222222-2222-4222-8222-222222222222",
          expected_revision_id: null,
          candidate_public_id: "33333333-3333-4333-8333-333333333333",
          expires_at: "2026-08-26T12:05:00.000Z",
        }
      : {
          id: "11111111-1111-4111-8111-111111111111",
          action,
          target_kind: "asset",
          target_object_id: "22222222-2222-4222-8222-222222222222",
          expected_revision_id: null,
          candidate_public_id: null,
          expires_at: "2026-08-26T12:05:00.000Z",
        };
  const publications = {
    begin() {
      events.push("begin");
      return Promise.resolve(intent);
    },
  } as unknown as PublicationRepository;
  const entrypoint = {} as PublicEntrypointRepository;
  const storage = {
    materializePublicationArtifact() {
      events.push("materialize");
      return Promise.resolve();
    },
  };
  const issueConfirmation = ((...[kind, intentId]: Parameters<typeof issueConfirmationOptions>) => {
    events.push(`confirm:${kind}:${intentId}`);
    return Promise.resolve({ challenge: "confirmation-options" });
  }) as typeof issueConfirmationOptions;

  return new DashboardPublicationService({
    publications,
    entrypoint,
    storage,
    issueConfirmation,
  });
}

describe("dashboard publication workflow", () => {
  test("materializes a publish before issuing its passkey confirmation", async () => {
    const events: string[] = [];
    const service = serviceFor({ action: "publish", events });

    await service.begin({
      input: {
        action: "publish",
        target_kind: "asset",
        target_object_id: "22222222-2222-4222-8222-222222222222",
      },
      principal,
    });

    expect(events).toEqual([
      "begin",
      "materialize",
      "confirm:publication:11111111-1111-4111-8111-111111111111",
    ]);
  });

  test("never materializes an unpublish intent", async () => {
    const events: string[] = [];
    const service = serviceFor({ action: "unpublish", events });

    await service.begin({
      input: {
        action: "unpublish",
        target_kind: "asset",
        target_object_id: "22222222-2222-4222-8222-222222222222",
      },
      principal,
    });

    expect(events).toEqual(["begin", "confirm:publication:11111111-1111-4111-8111-111111111111"]);
  });
});
