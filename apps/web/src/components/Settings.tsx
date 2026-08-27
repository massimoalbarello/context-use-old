import { useState } from "react";
import { usePasskeySettings } from "../features/settings/use-passkey-settings.ts";
import { usePublicEntrypointSettings } from "../features/settings/use-public-entrypoint-settings.ts";
import type { PasskeySummary } from "../types.ts";
import { McpClients } from "./McpClients.tsx";
import { RunningRelease } from "./RunningRelease.tsx";
import { IntrinsicServices } from "./Services.tsx";
import { PasskeySettings } from "./settings/PasskeySettings.tsx";
import { PublicEntrypointSettings } from "./settings/PublicEntrypointSettings.tsx";

export { publicEntrypointOptionLabel } from "../features/settings/use-public-entrypoint-settings.ts";
export type { PasskeySummary } from "../types.ts";

export function Settings({
  passkeys,
  onPasskeysChanged,
}: {
  passkeys: PasskeySummary[];
  onPasskeysChanged: () => Promise<void>;
}) {
  const [message, setMessage] = useState("");
  const publicEntrypoint = usePublicEntrypointSettings({ onMessage: setMessage });
  const passkeySettings = usePasskeySettings({ onMessage: setMessage, onPasskeysChanged });

  return (
    <main className="content-page settings-page">
      <header>
        <div>
          <span className="eyebrow">Owner-only controls</span>
          <h1>Settings</h1>
        </div>
        <RunningRelease />
      </header>
      {message && <p>{message}</p>}
      <IntrinsicServices />
      <PublicEntrypointSettings model={publicEntrypoint} />
      <McpClients />
      <PasskeySettings model={passkeySettings} passkeys={passkeys} />
    </main>
  );
}
