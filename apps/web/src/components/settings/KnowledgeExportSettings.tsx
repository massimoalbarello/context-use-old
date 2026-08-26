import { formatExportBytes } from "../../features/settings/settings-format.ts";
import type { KnowledgeExportModel } from "../../features/settings/use-knowledge-export.ts";
import { ActionDialog } from "../ActionDialog.tsx";
import { SettingsProgress } from "./SettingsProgress.tsx";

export function KnowledgeExportSettings({ model }: { model: KnowledgeExportModel }) {
  const progress = model.status
    ? model.status.bytes_total > 0
      ? model.status.bytes_completed / model.status.bytes_total
      : null
    : null;

  return (
    <>
      <section>
        <h2>Full backup and migration</h2>
        <p>
          Export every page, retained revision, source record, asset, internal link, and publication
          record in a versioned Context Use bundle. Original UUIDs are retained, so{" "}
          <code>context-use://object/&lt;uuid&gt;</code> links remain valid after import.
        </p>
        <p>
          The bundle is an unencrypted logical backup, independent of the current SQL schema. Keep
          it somewhere private.
        </p>
        {model.error && (
          <p className="error" role="alert">
            {model.error}
          </p>
        )}
        {!model.status && !model.intent && (
          <button
            type="button"
            className="primary export-start-button"
            disabled={model.working}
            onClick={() => void model.prepare()}
          >
            {model.working ? "Preparing…" : "Export full bundle with passkey"}
          </button>
        )}
        {model.status && !["ready", "failed"].includes(model.status.status) && (
          <SettingsProgress
            value={progress}
            label={
              model.status.phase === "records"
                ? "Writing records"
                : model.status.phase === "objects"
                  ? "Streaming assets and content"
                  : "Capturing a consistent snapshot"
            }
          />
        )}
        {model.status?.status === "ready" && (
          <div className="archive-upload">
            <div className="archive-upload-copy">
              <strong>Full bundle ready</strong>
              <small>
                {model.status.filename} · {formatExportBytes(model.status.size_bytes ?? 0)}
              </small>
            </div>
            <a className="button primary" href={model.status.download_url}>
              Download full bundle
            </a>
            <button type="button" onClick={model.reset}>
              Prepare another
            </button>
          </div>
        )}
        {model.status?.status === "failed" && (
          <div>
            <p className="error" role="alert">
              {model.status.message || "The full bundle could not be prepared."}
            </p>
            <button type="button" onClick={model.reset}>
              Start over
            </button>
          </div>
        )}
      </section>
      {model.intent && !model.status && (
        <ActionDialog
          eyebrow="Full knowledge backup"
          title="Export the complete knowledge base?"
          description="This unencrypted logical bundle contains every retained record and immutable content blob with its original UUID. A fresh owner-passkey verification is required."
          confirmLabel="Verify and build bundle"
          workingLabel="Waiting for passkey…"
          working={model.working}
          error={model.error}
          onCancel={model.cancel}
          onConfirm={() => void model.authorize()}
        >
          <dl className="action-dialog-details">
            <div>
              <dt>Current pages</dt>
              <dd>about {model.intent.summary.page_count}</dd>
            </div>
            <div>
              <dt>Active assets</dt>
              <dd>about {model.intent.summary.asset_count}</dd>
            </div>
            <div>
              <dt>Content bytes</dt>
              <dd>at least {formatExportBytes(model.intent.summary.estimated_bytes)}</dd>
            </div>
          </dl>
        </ActionDialog>
      )}
    </>
  );
}
