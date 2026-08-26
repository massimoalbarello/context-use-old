import { createRoute, redirect } from "@tanstack/react-router";
import { appRoute } from "../route.tsx";

export const legacyMcpRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "mcp",
  beforeLoad: () => {
    throw redirect({ to: "/app/settings", replace: true });
  },
});
