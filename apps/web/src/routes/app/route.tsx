import { createRoute } from "@tanstack/react-router";
import { App } from "../../App.tsx";
import { rootRoute } from "../root.tsx";

export const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "app",
  component: App,
});
