import { createRoute } from "@tanstack/react-router";
import { Settings } from "../../../components/Settings.tsx";
import { useDashboardWorkspace } from "../../../lib/workspace/dashboard-workspace.tsx";
import { appRoute } from "../route.tsx";

function SettingsRoute() {
  const workspace = useDashboardWorkspace();
  return (
    <Settings passkeys={workspace.session.passkeys} onPasskeysChanged={workspace.reloadSession} />
  );
}

export const settingsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "settings",
  component: SettingsRoute,
});
