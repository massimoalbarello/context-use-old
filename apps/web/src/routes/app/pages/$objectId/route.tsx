import { createRoute, redirect } from "@tanstack/react-router";
import { appRoute } from "../../route.tsx";

export const legacyPageRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "pages/$objectId",
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/app/objects/$objectId",
      params: { objectId: params.objectId },
      replace: true,
    });
  },
});
