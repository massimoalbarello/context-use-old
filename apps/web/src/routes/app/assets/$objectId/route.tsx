import { createRoute, redirect } from "@tanstack/react-router";
import { appRoute } from "../../route.tsx";

export const legacyAssetRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "assets/$objectId",
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/app/objects/$objectId",
      params: { objectId: params.objectId },
      replace: true,
    });
  },
});
