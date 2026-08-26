import {
  type PublicEntrypointSettingsModel,
  publicEntrypointOptionLabel,
} from "../../features/settings/use-public-entrypoint-settings.ts";

export function PublicEntrypointSettings({ model }: { model: PublicEntrypointSettingsModel }) {
  return (
    <section>
      <h2>Public entry point</h2>
      <p>
        Choose which already-published page opens at the public home page. Publishing and editing
        remain separate decisions; this pointer never publishes private content.
      </p>
      {model.error && (
        <p className="error" role="alert">
          {model.error}
        </p>
      )}
      {model.publicEntrypoint && (
        <div className="public-entrypoint-setting">
          <label>
            Entry page
            <select
              value={model.publicEntrypointId}
              onChange={(event) => model.setPublicEntrypointId(event.target.value)}
            >
              <option value="">No public entry point</option>
              {model.publicEntrypoint.entrypoint.public_id &&
                !model.publicEntrypoint.candidates.some(
                  (page) => page.public_id === model.publicEntrypoint?.entrypoint.public_id,
                ) && (
                  <option value={model.publicEntrypoint.entrypoint.public_id}>
                    Previously selected page · currently private
                  </option>
                )}
              {model.publicEntrypoint.candidates.map((page) => (
                <option value={page.public_id} key={page.public_id}>
                  {publicEntrypointOptionLabel(page)}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="primary"
            disabled={
              model.working ||
              model.publicEntrypointId === (model.publicEntrypoint.entrypoint.public_id ?? "")
            }
            onClick={() => void model.save()}
          >
            {model.working ? "Saving…" : "Save entry point"}
          </button>
        </div>
      )}
    </section>
  );
}
