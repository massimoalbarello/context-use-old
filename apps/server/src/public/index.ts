import { composePublicApp } from "./composition.ts";
import { loadPublicConfig } from "./config.ts";

const config = loadPublicConfig(process.env);
const runtime = composePublicApp(config);

Bun.serve({
  port: config.PORT,
  fetch: runtime.app.handle,
});

console.info(`context-use public application listening on ${config.PORT}`);
