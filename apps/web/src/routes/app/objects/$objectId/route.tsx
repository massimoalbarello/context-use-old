import { createRoute } from "@tanstack/react-router";
import { appRoute } from "../../route.tsx";

export const objectRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "objects/$objectId",
});
