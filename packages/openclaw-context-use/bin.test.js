import { expect, test } from "bun:test";
import path from "node:path";
import {
  mountContextUse,
  removeContextUse,
  unmountContextUse,
} from "./bin.js";
import { PLUGIN_ID } from "./setup.js";

function captureFixture(values, installed = true) {
  return async (args) => {
    if (args[0] === "plugins") {
      return installed
        ? {
            code: 0,
            stdout: JSON.stringify({ install: { source: "npm" } }),
            stderr: "",
          }
        : { code: 1, stdout: "", stderr: "not installed" };
    }
    const configPath = args[2];
    if (!Object.prototype.hasOwnProperty.call(values, configPath)) {
      return { code: 1, stdout: "", stderr: "not found" };
    }
    return {
      code: 0,
      stdout: JSON.stringify(values[configPath]),
      stderr: "",
    };
  };
}

test("mount snapshots before install, installs, enables, and sets up", async () => {
  const calls = [];
  let snapshot;
  await mountContextUse(
    {
      link: "./packages/openclaw-context-use",
      mcpUrl: "https://memory.example/mcp",
      skipLogin: true,
      restart: false,
    },
    {
      captureOpenClaw: captureFixture(
        { "plugins.slots.memory": "memory-lancedb" },
        false,
      ),
      readInstallSnapshot: async () => snapshot,
      writeInstallSnapshot: async (value) => {
        snapshot = value;
      },
      runOpenClaw: async (args) => calls.push(args),
    },
  );

  expect(snapshot.memorySlot).toEqual({
    exists: true,
    value: "memory-lancedb",
  });
  expect(calls).toEqual([
    [
      "plugins",
      "install",
      "--link",
      path.resolve("packages/openclaw-context-use"),
    ],
    ["plugins", "enable", PLUGIN_ID],
    [
      "context-use",
      "setup",
      "--mcp-url",
      "https://memory.example/mcp",
      "--skip-login",
      "--no-restart",
    ],
  ]);
});

test("mount is the remount command and does not overwrite its snapshot", async () => {
  const calls = [];
  const snapshot = { version: 1, memorySlot: { exists: false } };
  await mountContextUse(
    {},
    {
      captureOpenClaw: captureFixture({}, true),
      readInstallSnapshot: async () => snapshot,
      writeInstallSnapshot: async () => {
        throw new Error("snapshot should not be replaced");
      },
      runOpenClaw: async (args) => calls.push(args),
    },
  );
  expect(calls).toEqual([
    ["plugins", "enable", PLUGIN_ID],
    ["context-use", "setup"],
  ]);
});

test("off and remove work across the exclusive memory-slot boundary", async () => {
  const offCalls = [];
  expect(
    await unmountContextUse(
      { restart: false },
      {
        captureOpenClaw: captureFixture({
          "plugins.slots.memory": PLUGIN_ID,
        }),
        runOpenClaw: async (args) => offCalls.push(args),
      },
    ),
  ).toBe(true);
  expect(offCalls).toEqual([["context-use", "off", "--no-restart"]]);

  const removeCalls = [];
  expect(
    await removeContextUse(
      { restart: false },
      {
        captureOpenClaw: captureFixture({}, true),
        runOpenClaw: async (args) => removeCalls.push(args),
      },
    ),
  ).toBe(true);
  expect(removeCalls).toEqual([
    ["plugins", "enable", PLUGIN_ID],
    ["context-use", "remove", "--no-restart"],
  ]);
});
