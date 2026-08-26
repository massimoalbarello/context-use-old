import type { PasskeySettingsModel } from "../../features/settings/use-passkey-settings.ts";
import type { PasskeySummary } from "../../types.ts";
import { ActionDialog } from "../ActionDialog.tsx";
import "./PasskeySettings.css";

export function PasskeySettings({
  model,
  passkeys,
}: {
  model: PasskeySettingsModel;
  passkeys: PasskeySummary[];
}) {
  return (
    <>
      <section>
        <h2>Passkeys</h2>
        <p>
          Passkeys sign in as the installation owner and can confirm sensitive actions. Adding or
          removing one requires fresh verification with an existing passkey, and at least one must
          always remain.
        </p>
        <div className="security-list">
          {passkeys.map((passkey) => (
            <article key={passkey.id}>
              <div>
                <strong>{passkey.name || "Unnamed passkey"}</strong>
                <span>
                  Added {new Date(passkey.created_at).toLocaleString()} ·{" "}
                  {passkey.device_type === "singleDevice"
                    ? "Device-bound passkey"
                    : "Multi-device passkey"}
                  {passkey.backed_up ? " · Backed up" : ""}
                </span>
              </div>
              <button
                type="button"
                className="danger"
                disabled={passkeys.length <= 1 || Boolean(model.removalPreparingId)}
                onClick={() => void model.prepareRemoval(passkey)}
              >
                {model.removalPreparingId === passkey.id ? "Preparing…" : "Remove"}
              </button>
            </article>
          ))}
        </div>
        {model.removalError && !model.removalIntent && (
          <p className="error">{model.removalError}</p>
        )}
        <div className="passkey-add">
          <label>
            Passkey name
            <input
              maxLength={80}
              placeholder="e.g. YubiKey 5C or Work laptop"
              value={model.passkeyName}
              onChange={(event) => model.setPasskeyName(event.target.value)}
            />
          </label>
          <fieldset className="passkey-kind" aria-label="Passkey type">
            <label>
              <input
                type="radio"
                name="passkey-kind"
                checked={model.addMode === "hardware"}
                onChange={() => model.setAddMode("hardware")}
              />
              <span>
                <strong>Hardware security key</strong>
                <small>
                  Requests a USB, NFC, or other cross-platform authenticator instead of Touch ID.
                </small>
              </span>
            </label>
            <label>
              <input
                type="radio"
                name="passkey-kind"
                checked={model.addMode === "device"}
                onChange={() => model.setAddMode("device")}
              />
              <span>
                <strong>Another device</strong>
                <small>Creates a five-minute, one-time setup link to open on that device.</small>
              </span>
            </label>
          </fieldset>
          {model.enrollmentError && !model.enrollmentIntent && (
            <p className="error">{model.enrollmentError}</p>
          )}
          <button
            type="button"
            className="primary"
            disabled={model.enrollmentPreparing || model.enrollmentWorking}
            onClick={() => void model.prepareEnrollment()}
          >
            {model.enrollmentPreparing ? "Preparing…" : "Add passkey"}
          </button>
          {model.enrollmentLink && (
            <div className="passkey-link">
              <strong>One-time setup link</strong>
              <p>
                Open this on the device you are adding. It expires five minutes after authorization.
              </p>
              <div>
                <input
                  readOnly
                  value={model.enrollmentLink}
                  onFocus={(event) => event.currentTarget.select()}
                />
                <button type="button" onClick={() => void model.copyEnrollmentLink()}>
                  Copy
                </button>
              </div>
            </div>
          )}
        </div>
      </section>
      {model.enrollmentIntent && (
        <ActionDialog
          eyebrow="Passkey enrollment"
          title={`Authorize ${model.enrollmentIntent.intent.name}?`}
          description={
            model.enrollmentIntent.intent.authenticator_attachment === "cross-platform"
              ? "First verify an existing passkey. Your browser will then ask for the new hardware security key; Touch ID is not requested for that registration."
              : "Verify an existing passkey to create a five-minute, single-use setup link for the other device."
          }
          confirmLabel="Verify and continue"
          workingLabel="Waiting for passkey…"
          working={model.enrollmentWorking}
          error={model.enrollmentError}
          onCancel={model.cancelEnrollment}
          onConfirm={() => void model.authorizeEnrollment()}
        />
      )}
      {model.removalIntent && (
        <ActionDialog
          eyebrow="Remove passkey"
          title={`Remove ${model.removalIntent.intent.passkey_name || "this passkey"}?`}
          description="A fresh passkey verification is required. Removing it revokes every dashboard session, including this one, and you will need to sign in again with a remaining passkey."
          confirmLabel="Verify and remove"
          workingLabel="Waiting for passkey…"
          working={model.removalWorking}
          error={model.removalError}
          onCancel={model.cancelRemoval}
          onConfirm={() => void model.removePasskey()}
        />
      )}
    </>
  );
}
