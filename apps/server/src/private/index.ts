import { composePrivateApp } from "./composition.ts";
import { loadPrivateConfig } from "./config.ts";

const config = loadPrivateConfig(process.env);
const runtime = composePrivateApp(config);

Bun.serve({
  port: config.PORT,
  maxRequestBodySize: 5_500_000_000,
  fetch: runtime.app.handle,
});

console.info(`context-use private application listening on ${config.PORT}`);
