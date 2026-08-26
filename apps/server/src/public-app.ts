import { createPool } from "@context-use/database";
import { PublicRepository } from "@context-use/database/publication";
import { Elysia } from "elysia";
import { config } from "./config.ts";
import { routeError } from "./http.ts";
import { createPublicController } from "./routes/public/controller.ts";
import { securityHeaders } from "./security.ts";
import { PublicWebService } from "./services/public-web-service.ts";
import { BrokeredStorage } from "./storage-client.ts";

const pool = createPool(config.PUBLIC_DATABASE_URL, {
  application_name: "context-use-public-web",
});
const service = new PublicWebService({
  publicData: new PublicRepository(pool),
  storage: new BrokeredStorage({
    socketPath: config.STORAGE_SOCKET_PATH,
    token: config.STORAGE_PUBLIC_TOKEN,
    publicOnly: true,
  }),
  siteOrigin: config.APP_ORIGIN,
  assetOrigin: config.ASSET_ORIGIN,
});

export const publicApp = new Elysia({ strictPath: true })
  .onError(({ error, code }) =>
    code === "NOT_FOUND"
      ? new Response("Not found", { status: 404, headers: securityHeaders })
      : routeError(error),
  )
  .use(createPublicController(service));
