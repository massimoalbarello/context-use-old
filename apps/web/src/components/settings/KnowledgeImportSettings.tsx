import type { ReactNode } from "react";
import { formatExportBytes } from "../../features/settings/settings-format.ts";
import type { KnowledgeImportModel } from "../../features/settings/use-knowledge-import.ts";
import { SettingsProgress } from "./SettingsProgress.tsx";

export function FullImportAvailability({
  available,
  error,
  children,
}: {
  available: boolean | null;
  error?: string;
  children?: ReactNode;
}) {
  if (error) {
    return (
      <p className="error" role="alert">
        {error}
      </p>
    );
  }
  if (available === null) {
    return <p role="status">Checking whether this instance can import a bundle…</p>;
  }
  if (!available) {
    return (
      <p>
        This instance already contains personal knowledge, assets, publication state, or customized
        settings. Full bundle import is only available during initialization.
      </p>
    );
  }
  return <>{children}</>;
}

export function KnowledgeImportSettings({ model }: { model: KnowledgeImportModel }) {
  const progress = model.job
    ? model.job.status === "uploading"
      ? model.job.bytes_total > 0
        ? model.job.bytes_completed / model.job.bytes_total
        : null
      : model.job.blobs_total > 0
        ? model.job.blobs_completed / model.job.blobs_total
        : null
    : null;

  return (
    <section>
      <h2>Import full bundle</h2>
      <p>
        Restore a full bundle onto a fresh Context Use instance. Local account credentials,
        passkeys, and service secrets remain those of this destination instance.
      </p>
      <p>
        <strong>Initialization only:</strong> import may replace the untouched default knowledge
        template. The first personal knowledge, asset, publication, automation, or settings change
        permanently closes this import window.
      </p>
      <FullImportAvailability available={model.available} error={model.availabilityError}>
        <div className="archive-import">
          {(!model.job || model.job.status === "uploading") && (
            <div className="archive-import-field">
              <span className="archive-import-label">Context Use bundle</span>
              <label
                className={`archive-picker${model.file ? " has-file" : ""}${model.working ? " is-disabled" : ""}`}
              >
                <input
                  className="archive-picker-input"
                  type="file"
                  accept=".cuse,application/vnd.context-use.knowledge-bundle"
                  disabled={model.working}
                  onChange={(event) => model.chooseFile(event.currentTarget.files?.[0] ?? null)}
                />
                <span className="archive-picker-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M7 3.75h7l3 3v13.5H7z" />
                    <path d="M14 3.75v3h3M10 9.25h4m-4 3h4m-4 3h4" />
                  </svg>
                </span>
                <span className="archive-picker-copy">
                  <strong>{model.file ? model.file.name : "Choose a full bundle"}</strong>
                  <small>
                    {model.file
                      ? formatExportBytes(model.file.size)
                      : "Select the original .cuse file"}
                  </small>
                </span>
                <span className="archive-picker-action">
                  {model.file ? "Replace" : "Browse files"}
                </span>
              </label>
              {model.job?.status === "uploading" && (
                <small className="archive-upload-note">
                  This upload is resumable. Re-select the same file after a reload or network
                  interruption; completed parts are skipped.
                </small>
              )}
              <button
                type="button"
                className="primary"
                disabled={!model.file || model.working}
                onClick={() => void model.upload()}
              >
                {model.working
                  ? "Uploading…"
                  : model.job?.status === "uploading"
                    ? "Resume upload"
                    : "Upload and validate"}
              </button>
            </div>
          )}
          {model.job &&
            !["awaiting_confirmation", "complete", "failed"].includes(model.job.status) && (
              <SettingsProgress
                value={progress}
                label={
                  model.job.status === "uploading"
                    ? "Uploading bundle"
                    : model.job.status === "validating"
                      ? "Validating every record and blob"
                      : model.job.phase === "database"
                        ? "Restoring database relationships"
                        : "Restoring assets and content"
                }
              />
            )}
          {model.job?.status === "awaiting_confirmation" && (
            <div className="archive-upload">
              <div className="archive-upload-copy">
                <strong>Bundle verified</strong>
                <small>
                  Every frame passed structural and integrity validation. Owner authorization is
                  required before restoring it.
                </small>
              </div>
              <button
                type="button"
                className="primary"
                disabled={model.working}
                onClick={() => void model.authorize()}
              >
                {model.working ? "Waiting for passkey…" : "Import with passkey"}
              </button>
            </div>
          )}
          {model.job?.status === "complete" && (
            <div className="archive-upload">
              <div className="archive-upload-copy">
                <strong>Knowledge import complete</strong>
                <small>
                  Original UUIDs, links, history, assets, and publication records were restored.
                </small>
              </div>
            </div>
          )}
          {model.job?.status === "failed" && (
            <div>
              <p className="error" role="alert">
                {model.job.message || "The knowledge bundle could not be imported."}
              </p>
              <button type="button" onClick={model.reset}>
                Choose another bundle
              </button>
            </div>
          )}
          {model.error && (
            <p className="error" role="alert">
              {model.error}
            </p>
          )}
        </div>
      </FullImportAvailability>
    </section>
  );
}
