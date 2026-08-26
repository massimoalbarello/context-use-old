import { createRoute, useNavigate } from "@tanstack/react-router";
import { NewPage } from "../../../../components/NewPage.tsx";
import { useDashboardWorkspace } from "../../../../lib/workspace/dashboard-workspace.tsx";
import { appRoute } from "../../route.tsx";

function NewObjectRoute() {
  const navigate = useNavigate();
  const workspace = useDashboardWorkspace();

  return (
    <NewPage
      onCancel={() => void navigate({ to: "/app" })}
      onCreated={(objectId) => {
        workspace.refreshNavigator();
        workspace.openObjectId({ objectId });
      }}
    />
  );
}

export const newObjectRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "objects/new",
  component: NewObjectRoute,
});
