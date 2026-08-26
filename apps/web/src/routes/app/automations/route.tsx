import { createRoute } from "@tanstack/react-router";
import { Automations } from "../../../components/Automations.tsx";
import { useDashboardWorkspace } from "../../../lib/workspace/dashboard-workspace.tsx";
import { appRoute } from "../route.tsx";

function AutomationsRoute() {
  const workspace = useDashboardWorkspace();
  return <Automations onOpenObject={(objectId) => workspace.openObjectId({ objectId })} />;
}

export const automationsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "automations",
  component: AutomationsRoute,
});
