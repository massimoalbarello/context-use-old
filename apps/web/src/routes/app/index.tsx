import { createRoute } from "@tanstack/react-router";
import { appRoute } from "./route.tsx";

export const appIndexRoute = createRoute({ getParentRoute: () => appRoute, path: "/" });
