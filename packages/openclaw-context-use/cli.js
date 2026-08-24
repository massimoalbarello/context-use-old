import { spawn } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import {
  MCP_SERVER_NAME,
  PLUGIN_ID,
  applyContextUseSetup,
  createInstallSnapshot,
  inspectContextUseSetup,
  resolveConfiguredMcpServer,
  resolveConfiguredMcpUrl,
  restorePreviousMemorySetup,
  validateMcpUrl,
} from "./setup.js";

function stateDirectory() {
  return process.env.OPENCLAW_STATE_DIR || path.join(os.homedir(), ".openclaw");
}

export function installStatePath() {
  return path.join(stateDirectory(), "context-use-memory.install.json");
}

export async function readInstallSnapshot(filePath = installStatePath()) {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8"));
    return parsed?.version === 1 ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export async function writeInstallSnapshot(
  snapshot,
  filePath = installStatePath(),
) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(snapshot, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(temporaryPath, filePath);
}

export async function removeInstallSnapshot(filePath = installStatePath()) {
  await rm(filePath, { force: true });
}

export async function runOpenClaw(args) {
  const binary = process.env.OPENCLAW_BIN || "openclaw";
  await new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      stdio: "inherit",
      env: process.env,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else {
        reject(
          new Error(
            `${binary} ${args.join(" ")} failed${signal ? ` (${signal})` : ` with exit code ${code}`}`,
          ),
        );
      }
    });
  });
}

async function promptForMcpUrl() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      "No context-use MCP server is configured. Re-run with --mcp-url https://<workspace>.context-use.com/mcp.",
    );
  }
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const value = await readline.question("Context-use MCP URL: ");
    if (!value.trim()) throw new Error("Context-use MCP URL is required.");
    return validateMcpUrl(value.trim());
  } finally {
    readline.close();
  }
}

function formatStatus(status) {
  const marker = (value) => (value ? "yes" : "no");
  return [
    `Context-use memory configured: ${marker(status.configured)}`,
    `Memory slot: ${status.memorySlot ?? "(default)"}`,
    `Automatic capture: ${marker(status.captureEnabled)}`,
    `Active recall: ${marker(status.activeRecallConfigured)}`,
    `Attachment bridge: ${marker(status.attachmentToolAllowed)}`,
    `MCP server: ${status.mcpConfigured ? status.mcpUrl ?? status.mcpTransport : "not configured"}`,
  ].join("\n");
}

export function registerContextUseCli(api, dependencies = {}) {
  const run = dependencies.runOpenClaw ?? runOpenClaw;
  const readSnapshot = dependencies.readInstallSnapshot ?? readInstallSnapshot;
  const writeSnapshot =
    dependencies.writeInstallSnapshot ?? writeInstallSnapshot;
  const removeSnapshot =
    dependencies.removeInstallSnapshot ?? removeInstallSnapshot;

  api.registerCli(
    ({ program }) => {
      const root = program
        .command("context-use")
        .description("Install, configure, and remove Context-use memory");

      root
        .command("setup")
        .alias("on")
        .description("Make Context-use the active OpenClaw memory")
        .option("--mcp-url <url>", "Context-use streamable HTTP MCP URL")
        .option("--login", "Re-run Context-use OAuth login")
        .option("--skip-login", "Do not start OAuth for a newly configured MCP server")
        .option("--no-restart", "Do not restart the Gateway after setup")
        .action(async (options) => {
          const current = api.runtime.config.current();
          const existingMcpServer = resolveConfiguredMcpServer(current);
          const existingMcpUrl = resolveConfiguredMcpUrl(current);
          const requestedMcpUrl = options.mcpUrl
            ? validateMcpUrl(options.mcpUrl)
            : undefined;
          const mcpUrl =
            requestedMcpUrl ??
            existingMcpUrl ??
            (existingMcpServer ? undefined : await promptForMcpUrl());
          const isNewMcpServer = !existingMcpServer || requestedMcpUrl !== undefined;

          if (!(await readSnapshot())) {
            await writeSnapshot(createInstallSnapshot(current));
          }

          await api.runtime.config.mutateConfigFile({
            afterWrite: {
              mode: "none",
              reason: "Context-use setup completes OAuth before restarting OpenClaw.",
            },
            mutate: (draft) =>
              applyContextUseSetup(draft, mcpUrl ? { mcpUrl } : {}),
          });

          if (!options.skipLogin && (isNewMcpServer || options.login)) {
            await run(["mcp", "login", MCP_SERVER_NAME]);
          }
          if (options.restart !== false) await run(["gateway", "restart"]);

          console.log("Context-use is now the active OpenClaw memory.");
        });

      root
        .command("status")
        .description("Show Context-use memory configuration")
        .option("--json", "Print machine-readable JSON")
        .option("--probe", "Probe the Context-use MCP server")
        .action(async (options) => {
          const status = inspectContextUseSetup(api.runtime.config.current());
          console.log(options.json ? JSON.stringify(status, null, 2) : formatStatus(status));
          if (options.probe) {
            await run(["mcp", "doctor", MCP_SERVER_NAME, "--probe"]);
          }
        });

      root
        .command("off")
        .alias("disable")
        .description("Stop using Context-use memory without uninstalling it")
        .option("--no-restart", "Do not restart the Gateway")
        .action(async (options) => {
          const snapshot = await readSnapshot();
          await api.runtime.config.mutateConfigFile({
            writeOptions: { allowConfigSizeDrop: true },
            afterWrite: {
              mode: "none",
              reason: "Context-use memory was disabled by the operator.",
            },
            mutate: (draft) => restorePreviousMemorySetup(draft, snapshot),
          });
          if (options.restart !== false) await run(["gateway", "restart"]);
          console.log("Context-use memory is off. The plugin remains installed.");
        });

      root
        .command("remove")
        .alias("uninstall")
        .description("Restore the previous memory setup and uninstall Context-use")
        .option("--no-restart", "Do not restart the Gateway")
        .action(async (options) => {
          const snapshot = await readSnapshot();
          // Uninstall while the mounted configuration is still present. On a
          // small fresh profile, removing the plugin entry after first
          // restoring everything else can trip OpenClaw's >50% size-drop
          // safeguard. This process already has the plugin code loaded, so it
          // can restore the prior setup immediately after core uninstall.
          await run(["plugins", "uninstall", PLUGIN_ID, "--force"]);
          await api.runtime.config.mutateConfigFile({
            writeOptions: { allowConfigSizeDrop: true },
            afterWrite: {
              mode: "none",
              reason: "Context-use will be uninstalled before OpenClaw restarts.",
            },
            mutate: (draft) => restorePreviousMemorySetup(draft, snapshot),
          });
          await removeSnapshot();
          if (options.restart !== false) await run(["gateway", "restart"]);
          console.log("Context-use memory was removed. Context-use knowledge was not deleted.");
        });
    },
    {
      descriptors: [
        {
          name: "context-use",
          description: "Install, configure, and remove Context-use memory",
          hasSubcommands: true,
        },
      ],
    },
  );
}
