import { startAuthentication } from "@simplewebauthn/browser";
import { api } from "./api.ts";

export type PublicationAction = "publish" | "unpublish";

export function pathlessPublicationIntentBody({
  action,
  targetKind,
  targetId,
  versionId,
}: {
  action: PublicationAction;
  targetKind: "page" | "asset";
  targetId: string;
  versionId: string | null;
}) {
  if (action === "publish" && targetKind === "page" && !versionId) {
    throw new Error("Page publication requires an exact revision");
  }
  return {
    action,
    target_kind: targetKind,
    target_document_id: targetId,
    ...(action === "publish" && targetKind === "page"
      ? { expected_revision_id: versionId }
      : {}),
  };
}

export async function confirmPublicationChange({
  action,
  targetKind,
  targetId,
  versionId,
}: {
  action: PublicationAction;
  targetKind: "page" | "asset";
  targetId: string;
  versionId: string | null;
}): Promise<void> {
  const intentBody = pathlessPublicationIntentBody({ action, targetKind, targetId, versionId });
  const intentId = crypto.randomUUID();
  try {
    const created = await api<{
      intent: { id: string };
      authentication_options: Parameters<typeof startAuthentication>[0]["optionsJSON"];
    }>("/api/dashboard/pathless-publication-intents", {
      method: "POST",
      headers: { "x-publication-intent-id": intentId },
      body: JSON.stringify(intentBody),
    });
    const response = await startAuthentication({ optionsJSON: created.authentication_options });
    await api("/api/dashboard/publications/confirm", {
      method: "POST",
      body: JSON.stringify({ intent_id: created.intent.id, response }),
    });
  } catch (error) {
    await api(`/api/dashboard/pathless-publication-intents/${intentId}`, {
      method: "DELETE",
    }).catch(() => undefined);
    throw error;
  }
}
