import { runHypermediaBootstrapCommand } from "./command.ts";
import { loadHypermediaBootstrapConfig } from "./config.ts";

try {
  const result = await runHypermediaBootstrapCommand(loadHypermediaBootstrapConfig(process.env));
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(
    JSON.stringify({
      event: "hypermedia_bootstrap_failed",
      error_name: error instanceof Error ? error.name : typeof error,
      message: error instanceof Error ? error.message : "Unknown failure",
    }),
  );
  process.exitCode = 1;
}
