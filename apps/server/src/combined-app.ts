import { app as dashboardApp } from "./app.ts";
import { authApp } from "./auth-app.ts";
import { confirmationApp } from "./confirmation-app.ts";
import { mcpApp } from "./mcp-app.ts";
import { publicApp } from "./public-app.ts";
import { createCombinedApp } from "./services/combined-app-router.ts";

const internalHandlers = globalThis as typeof globalThis & {
  __contextUseAuthHandler?: (request: Request) => Promise<Response> | Response;
  __contextUseConfirmationHandler?: (request: Request) => Promise<Response> | Response;
};
internalHandlers.__contextUseAuthHandler = (request) => authApp.handle(request);
internalHandlers.__contextUseConfirmationHandler = (request) => confirmationApp.handle(request);

export const combinedApp = createCombinedApp({
  auth: authApp,
  dashboard: dashboardApp,
  mcp: mcpApp,
  publicWeb: publicApp,
});
