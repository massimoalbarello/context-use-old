import { expect, test } from "bun:test";
import { registerContextUseCli } from "./cli.js";
import { PLUGIN_ID } from "./setup.js";

class FakeCommand {
  constructor(name = "root") {
    this.name = name;
    this.children = new Map();
  }

  command(spec) {
    const child = new FakeCommand(spec.split(" ", 1)[0]);
    this.children.set(child.name, child);
    return child;
  }

  description() {
    return this;
  }

  alias() {
    return this;
  }

  option() {
    return this;
  }

  action(handler) {
    this.handler = handler;
    return this;
  }
}

function fixture() {
  const config = {
    mcp: {
      servers: {
        "context-use": {
          url: "https://memory.example/mcp",
          transport: "streamable-http",
          auth: "oauth",
        },
      },
    },
    plugins: { slots: { memory: "memory-core" } },
  };
  const program = new FakeCommand();
  const calls = [];
  let snapshot;
  const api = {
    runtime: {
      config: {
        current: () => config,
        mutateConfigFile: async ({ mutate }) => {
          await mutate(config);
        },
      },
    },
    registerCli(registrar) {
      registrar({ program });
    },
  };
  registerContextUseCli(api, {
    runOpenClaw: async (args) => calls.push(args),
    readInstallSnapshot: async () => snapshot,
    writeInstallSnapshot: async (value) => {
      snapshot = value;
    },
    removeInstallSnapshot: async () => {
      snapshot = undefined;
    },
  });
  return { calls, config, program };
}

test("setup and remove are complete single CLI actions", async () => {
  const { calls, config, program } = fixture();
  const contextUse = program.children.get("context-use");

  await contextUse.children.get("setup").handler({
    restart: false,
    skipLogin: true,
  });
  expect(config.plugins.slots.memory).toBe(PLUGIN_ID);
  expect(config.plugins.entries[PLUGIN_ID].config.captureEnabled).toBe(true);

  await contextUse.children.get("off").handler({ restart: false });
  expect(config.plugins.slots.memory).toBe("memory-core");
  expect(calls).toEqual([]);

  await contextUse.children.get("setup").handler({
    restart: false,
    skipLogin: true,
  });

  await contextUse.children.get("remove").handler({ restart: false });
  expect(config.plugins.slots.memory).toBe("memory-core");
  expect(calls).toEqual([
    ["plugins", "uninstall", PLUGIN_ID, "--force"],
  ]);
});
