import { createRoute } from "@tanstack/react-router";
import { appRoute } from "../route.tsx";

export const historyRoute = createRoute({ getParentRoute: () => appRoute, path: "history" });
