import { createRoute } from "@tanstack/react-router";
import { appRoute } from "../../route.tsx";

export const newObjectRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "objects/new",
});
