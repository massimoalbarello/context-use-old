import { createRoute } from "@tanstack/react-router";
import { appRoute } from "../route.tsx";

export const automationsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "automations",
});
