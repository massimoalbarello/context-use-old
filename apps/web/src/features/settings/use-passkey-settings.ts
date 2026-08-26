import { startAuthentication } from "@simplewebauthn/browser";
import { useState } from "react";
import { api } from "../../api.ts";
import type { PasskeySummary } from "../../types.ts";

type EnrollmentIntent = {
  intent: {
    id: string;
    name: string;
    authenticator_attachment: "cross-platform" | null;
    expires_at: string;
  };
  authentication_options: Parameters<typeof startAuthentication>[0]["optionsJSON"];
};

type EnrollmentAuthorization = {
  enrollment_claim: string;
  setup_url: string;
  expires_at: string;
  name: string;
  authenticator_attachment: "cross-platform" | null;
};

type RemovalIntent = {
  intent: {
    id: string;
    passkey_id: string;
    passkey_name: string | null;
    expires_at: string;
  };
  authentication_options: Parameters<typeof startAuthentication>[0]["optionsJSON"];
};

type PasskeySettingsOptions = {
  onMessage(message: string): void;
  onPasskeysChanged(): Promise<void>;
};

export function usePasskeySettings({ onMessage, onPasskeysChanged }: PasskeySettingsOptions) {
  const [passkeyName, setPasskeyName] = useState("");
  const [addMode, setAddMode] = useState<"hardware" | "device">("hardware");
  const [enrollmentIntent, setEnrollmentIntent] = useState<EnrollmentIntent | null>(null);
  const [enrollmentLink, setEnrollmentLink] = useState("");
  const [enrollmentPreparing, setEnrollmentPreparing] = useState(false);
  const [enrollmentWorking, setEnrollmentWorking] = useState(false);
  const [enrollmentError, setEnrollmentError] = useState("");
  const [removalIntent, setRemovalIntent] = useState<RemovalIntent | null>(null);
  const [removalPreparingId, setRemovalPreparingId] = useState("");
  const [removalWorking, setRemovalWorking] = useState(false);
  const [removalError, setRemovalError] = useState("");

  const prepareEnrollment = async () => {
    const name = passkeyName.trim();
    if (!name) {
      setEnrollmentError("Give this passkey a name first.");
      return;
    }
    setEnrollmentPreparing(true);
    setEnrollmentError("");
    setEnrollmentLink("");
    onMessage("");
    try {
      setEnrollmentIntent(
        await api<EnrollmentIntent>("/api/dashboard/passkey-enrollment-intents", {
          method: "POST",
          body: JSON.stringify({
            name,
            authenticator_attachment: addMode === "hardware" ? "cross-platform" : null,
          }),
        }),
      );
    } catch (caught) {
      setEnrollmentError(
        caught instanceof Error ? caught.message : "Could not prepare passkey enrollment",
      );
    } finally {
      setEnrollmentPreparing(false);
    }
  };

  const authorizeEnrollment = async () => {
    if (!enrollmentIntent) {
      return;
    }
    setEnrollmentWorking(true);
    setEnrollmentError("");
    try {
      const response = await startAuthentication({
        optionsJSON: enrollmentIntent.authentication_options,
      });
      const authorization = await api<EnrollmentAuthorization>(
        `/api/dashboard/passkey-enrollment-intents/${encodeURIComponent(enrollmentIntent.intent.id)}/confirm`,
        { method: "POST", body: JSON.stringify({ response }) },
      );
      setEnrollmentIntent(null);
      if (authorization.authenticator_attachment === "cross-platform") {
        const { authClient } = await import("../../auth-client.ts");
        const result = await authClient.passkey.addPasskey({
          name: authorization.name,
          authenticatorAttachment: "cross-platform",
          context: JSON.stringify({ enrollment_claim: authorization.enrollment_claim }),
        });
        if (result.error) {
          throw new Error(result.error.message ?? "Hardware passkey setup failed");
        }
        setPasskeyName("");
        onMessage(`${authorization.name} was added.`);
        await onPasskeysChanged();
      } else {
        setEnrollmentLink(authorization.setup_url);
        onMessage("Passkey enrollment authorized. Open the one-time link on the other device.");
      }
    } catch (caught) {
      setEnrollmentError(caught instanceof Error ? caught.message : "Passkey enrollment failed");
    } finally {
      setEnrollmentWorking(false);
    }
  };

  const copyEnrollmentLink = async () => {
    try {
      await navigator.clipboard.writeText(enrollmentLink);
      onMessage("One-time passkey setup link copied.");
    } catch {
      onMessage("Could not copy automatically. Select and copy the link below.");
    }
  };

  const prepareRemoval = async (passkey: PasskeySummary) => {
    setRemovalPreparingId(passkey.id);
    setRemovalError("");
    onMessage("");
    try {
      setRemovalIntent(
        await api<RemovalIntent>(
          `/api/dashboard/passkeys/${encodeURIComponent(passkey.id)}/removal-intents`,
          { method: "POST", body: "{}" },
        ),
      );
    } catch (caught) {
      setRemovalError(
        caught instanceof Error ? caught.message : "Could not prepare passkey removal",
      );
    } finally {
      setRemovalPreparingId("");
    }
  };

  const removePasskey = async () => {
    if (!removalIntent) {
      return;
    }
    setRemovalWorking(true);
    setRemovalError("");
    try {
      const response = await startAuthentication({
        optionsJSON: removalIntent.authentication_options,
      });
      await api(
        `/api/dashboard/passkeys/${encodeURIComponent(removalIntent.intent.passkey_id)}/remove`,
        {
          method: "POST",
          body: JSON.stringify({ intent_id: removalIntent.intent.id, response }),
        },
      );
      window.location.assign("/app");
    } catch (caught) {
      setRemovalError(caught instanceof Error ? caught.message : "Passkey removal failed");
      setRemovalWorking(false);
    }
  };

  return {
    addMode,
    authorizeEnrollment,
    cancelEnrollment: () => {
      setEnrollmentError("");
      setEnrollmentIntent(null);
    },
    cancelRemoval: () => {
      setRemovalError("");
      setRemovalIntent(null);
    },
    copyEnrollmentLink,
    enrollmentError,
    enrollmentIntent,
    enrollmentLink,
    enrollmentPreparing,
    enrollmentWorking,
    passkeyName,
    prepareEnrollment,
    prepareRemoval,
    removalError,
    removalIntent,
    removalPreparingId,
    removalWorking,
    removePasskey,
    setAddMode,
    setPasskeyName,
  };
}

export type PasskeySettingsModel = ReturnType<typeof usePasskeySettings>;
