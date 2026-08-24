#!/usr/bin/env node

import { spawn } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  installStatePath,
  readInstallSnapshot,
  runOpenClaw,
  writeInstallSnapshot,
} from "./cli.js";
import { PLUGIN_ID, createInstallSnapshot } from "./setup.js";

export const PACKAGE_SPEC = "@context-use/openclaw-memory";

export async function captureOpenClaw(args) {
  const binary = process.env.OPENCLAW_BIN || "openclaw";
  return await new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      stdio: ["inherit", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      resolve({ code, signal, stdout, stderr });
    });
  });
}

async function readConfigProperty(configPath, capture) {
  const result = await capture(["config", "get", configPath, "--json"]);
  if (result.code !== 0) return { exists: false };
  try {
    return { exists: true, value: JSON.parse(result.stdout) };
  } catch {
    throw new Error(`OpenClaw returned invalid JSON for ${configPath}.`);
  }
}

function assignConfigProperty(config, configPath, property) {
  if (!property.exists) return;
  const segments = configPath.split(".");
  let target = config;
  for (const segment of segments.slice(0, -1)) {
    target[segment] ??= {};
    target = target[segment];
  }
  target[segments.at(-1)] = property.value;
}

export async function readOpenClawSetupConfig(capture = captureOpenClaw) {
  const paths = [
    "tools.alsoAllow",
    "plugins.slots.memory",
    "plugins.entries.active-memory",
  ];
  const properties = await Promise.all(
    paths.map((configPath) => readConfigProperty(configPath, capture)),
  );
  const config = {};
  paths.forEach((configPath, index) =>
    assignConfigProperty(config, configPath, properties[index]),
  );
  return config;
}

export async function isPluginInstalled(capture = captureOpenClaw) {
  const result = await capture(["plugins", "inspect", PLUGIN_ID, "--json"]);
  if (result.code !== 0) return false;
  try {
    return Boolean(JSON.parse(result.stdout)?.install);
  } catch {
    return false;
  }
}

function setupArguments(options) {
  const args = ["context-use", "setup"];
  if (options.mcpUrl) args.push("--mcp-url", options.mcpUrl);
  if (options.login) args.push("--login");
  if (options.skipLogin) args.push("--skip-login");
  if (options.restart === false) args.push("--no-restart");
  return args;
}

export async function mountContextUse(options = {}, dependencies = {}) {
  const run = dependencies.runOpenClaw ?? runOpenClaw;
  const capture = dependencies.captureOpenClaw ?? captureOpenClaw;
  const readSnapshot =
    dependencies.readInstallSnapshot ?? readInstallSnapshot;
  const writeSnapshot =
    dependencies.writeInstallSnapshot ?? writeInstallSnapshot;

  if (!(await readSnapshot())) {
    const config = await readOpenClawSetupConfig(capture);
    await writeSnapshot(createInstallSnapshot(config));
  }

  if (!(await isPluginInstalled(capture))) {
    const source = options.link
      ? ["--link", path.resolve(options.link)]
      : [options.packageSpec ?? PACKAGE_SPEC];
    await run(["plugins", "install", ...source]);
  }

  // Third-party memory packages are not always assigned their exclusive slot
  // during the first install. Enabling after discovery makes slot selection
  // deterministic and also makes the plugin-owned setup CLI available.
  await run(["plugins", "enable", PLUGIN_ID]);
  await run(setupArguments(options));
}

export async function unmountContextUse(options = {}, dependencies = {}) {
  const run = dependencies.runOpenClaw ?? runOpenClaw;
  const capture = dependencies.captureOpenClaw ?? captureOpenClaw;
  const slot = await readConfigProperty("plugins.slots.memory", capture);
  if (!slot.exists || slot.value !== PLUGIN_ID) return false;
  await run([
    "context-use",
    "off",
    ...(options.restart === false ? ["--no-restart"] : []),
  ]);
  return true;
}

export async function removeContextUse(options = {}, dependencies = {}) {
  const run = dependencies.runOpenClaw ?? runOpenClaw;
  const capture = dependencies.captureOpenClaw ?? captureOpenClaw;
  if (!(await isPluginInstalled(capture))) return false;
  // `off` restores the previous memory slot, which disables a memory-kind
  // plugin. Select it briefly so its own reversible uninstall command can run.
  await run(["plugins", "enable", PLUGIN_ID]);
  await run([
    "context-use",
    "remove",
    ...(options.restart === false ? ["--no-restart"] : []),
  ]);
  return true;
}

function usage() {
  return `Context-use memory for OpenClaw

Usage:
  context-use-openclaw mount [--link <path>] [--mcp-url <url>] [--login|--skip-login] [--no-restart]
  context-use-openclaw off [--no-restart]
  context-use-openclaw remove [--no-restart]
  context-use-openclaw status [--json] [--probe]

The mount command installs the plugin when needed and is also the remount command.
State snapshot: ${installStatePath()}`;
}

function parseMountOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (
      argument === "--link" ||
      argument === "--mcp-url" ||
      argument === "--package"
    ) {
      const value = args[index + 1];
      if (!value) throw new Error(`${argument} requires a value.`);
      if (argument === "--link") options.link = value;
      if (argument === "--mcp-url") options.mcpUrl = value;
      if (argument === "--package") options.packageSpec = value;
      index += 1;
    } else if (argument === "--login") options.login = true;
    else if (argument === "--skip-login") options.skipLogin = true;
    else if (argument === "--no-restart") options.restart = false;
    else throw new Error(`Unknown mount option: ${argument}`);
  }
  if (options.login && options.skipLogin) {
    throw new Error("Use either --login or --skip-login, not both.");
  }
  if (options.link && options.packageSpec) {
    throw new Error("Use either --link or --package, not both.");
  }
  return options;
}

function parseRestartOption(args) {
  if (args.length === 0) return {};
  if (args.length === 1 && args[0] === "--no-restart") {
    return { restart: false };
  }
  throw new Error(`Unknown option: ${args.join(" ")}`);
}

export async function main(args = process.argv.slice(2)) {
  const [command, ...rest] = args;
  if (
    !command ||
    command === "help" ||
    command === "--help" ||
    command === "-h"
  ) {
    console.log(usage());
    return;
  }
  if (["mount", "on", "setup"].includes(command)) {
    await mountContextUse(parseMountOptions(rest));
    return;
  }
  if (["off", "disable"].includes(command)) {
    const changed = await unmountContextUse(parseRestartOption(rest));
    if (!changed) console.log("Context-use memory is already unmounted.");
    return;
  }
  if (["remove", "uninstall"].includes(command)) {
    const changed = await removeContextUse(parseRestartOption(rest));
    if (!changed) console.log("Context-use memory is not installed.");
    return;
  }
  if (command === "status") {
    if (rest.some((argument) => !["--json", "--probe"].includes(argument))) {
      throw new Error(`Unknown status option: ${rest.join(" ")}`);
    }
    const slot = await readConfigProperty(
      "plugins.slots.memory",
      captureOpenClaw,
    );
    if (slot.exists && slot.value === PLUGIN_ID) {
      await runOpenClaw(["context-use", "status", ...rest]);
      return;
    }
    if (rest.includes("--probe")) {
      throw new Error("Context-use memory is not mounted; mount it before probing MCP.");
    }
    if (await isPluginInstalled()) {
      await runOpenClaw([
        "plugins",
        "inspect",
        PLUGIN_ID,
        ...(rest.includes("--json") ? ["--json"] : []),
      ]);
      return;
    }
    console.log(
      rest.includes("--json")
        ? JSON.stringify({ configured: false, installed: false }, null, 2)
        : "Context-use memory is not installed.",
    );
    return;
  }
  throw new Error(`Unknown command: ${command}\n\n${usage()}`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
