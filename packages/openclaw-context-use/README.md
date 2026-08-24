# Context-use memory for OpenClaw

This package is the thin OpenClaw binding for Context-use. It keeps the reusable boundary small:

- OpenClaw's bundled Active Memory hook performs read-only recall through Context-use MCP tools.
- This plugin claims OpenClaw's memory slot, disables local-memory flushes, and adds the durable-memory policy prompt.
- After a completed owner turn, it launches a curator through OpenClaw's own subagent runtime, explicitly reusing the parent turn's provider and model.
- Inbound assets receive opaque, turn-scoped handles. The curator can inspect them and stream their exact bytes only to a signed upload URL on the configured Context-use HTTPS origin.

The curator opens a knowledge session, reads the live global hypermedia-maintenance guide, and
reuses its receipt for stable-ID document and asset mutations. Direct user statements do not
receive synthetic Nango/source-record provenance.

## Install from this checkout

```sh
bun run openclaw:mount
```

`setup` is the whole integration step. It:

- prompts for the Context-use MCP URL when one is not already configured;
- runs OAuth for a newly configured MCP server;
- selects `context-use-memory` as OpenClaw's memory slot;
- configures bundled Active Memory for read-only Context-use recall;
- enables same-model capture and the attachment bridge; and
- restarts the Gateway.

No manual `openclaw.json` editing is required.

The command links this checkout and snapshots the previous memory setup before OpenClaw selects
its exclusive memory slot.

## Operate from this checkout

```sh
bun run openclaw:status          # show the effective mount
bun run openclaw:status --probe  # also verify the MCP connection
bun run openclaw:off             # restore previous setup, keep installed
bun run openclaw:mount           # mount it again
bun run openclaw:remove          # restore, uninstall, and restart
```

While mounted, the shorter plugin-owned `openclaw context-use ...` commands are also available.

`off` and `remove` do not delete knowledge stored in Context-use or remove the
OpenClaw MCP OAuth credential. A setup snapshot in the OpenClaw state directory restores the
previous memory slot, Active Memory entry, and tool allowlist instead of assuming defaults.

## Future npm distribution

The package is prepared for a future npm publication as `@context-use/openclaw-memory`. After it
is published, the equivalent commands will be:

```sh
npx @context-use/openclaw-memory mount
npx @context-use/openclaw-memory off
npx @context-use/openclaw-memory remove
```

## Manual configuration

Automation may still dry-run and apply the included patch directly:

```sh
openclaw config patch --file ./openclaw.patch.json5 --dry-run
openclaw config patch --file ./openclaw.patch.json5
```

The patch adds only `context_use_attachment` to the active tool profile, selects `context-use-memory` in `plugins.slots.memory`, permits the plugin to read the completed turn and reuse its exact model, and configures `active-memory` with Context-use read tools. The attachment tool is session-bound and cannot read arbitrary paths or upload outside the HTTPS origin inferred from the `context-use` MCP server. Set `allowedUploadOrigins` only when that origin cannot be inferred. The patch deliberately does not pin a memory model: recall inherits the active OpenClaw session model, while capture passes the parent provider/model explicitly.

## Roll back

Run `bun run openclaw:remove`. Context-use records written during a test should be archived
separately through its MCP tools when desired.
