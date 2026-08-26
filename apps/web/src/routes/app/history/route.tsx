import { createRoute } from "@tanstack/react-router";
import { KnowledgeHistory } from "../../../components/KnowledgeHistory.tsx";
import { useDashboardWorkspace } from "../../../lib/workspace/dashboard-workspace.tsx";
import { appRoute } from "../route.tsx";

function HistoryRoute() {
  const workspace = useDashboardWorkspace();
  return <KnowledgeHistory onOpenObject={(objectId) => workspace.openObjectId({ objectId })} />;
}

export const historyRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "history",
  component: HistoryRoute,
});
