import { createRoute } from "@tanstack/react-router";
import { appRoute } from "../route.tsx";

export const settingsRoute = createRoute({ getParentRoute: () => appRoute, path: "settings" });
