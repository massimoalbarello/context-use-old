import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

export const FILESYSTEM_DEPRECATION_AUDIT_ALLOWANCES = [
  "legacy public aliases and their HTTP route paths",
  "UUID public routes",
  "local configuration and cache paths",
  "Unix sockets and agent-sync directories",
  "XFS data-volume discovery and mounting",
  "negative regression tests for removed APIs",
] as const;

const RULES = [
  { label: "retired private directory relation", pattern: "knowledge_" + "directories" },
  { label: "retired private path column", pattern: "current" + "_path" },
  { label: "retired path-independent prefix", pattern: "pathless_" + "[A-Za-z0-9_]*" },
  { label: "retired filesystem storage class", pattern: "Filesystem" + "Storage" },
  { label: "retired storage root variable", pattern: "STORAGE" + "_PATH" },
  { label: "released-schema rescue runtime", pattern: "released-" + "v084-[A-Za-z0-9_-]*" },
  {
    label: "historical migration-ledger contract",
    pattern: [
      "matches" + "CompletedLedger",
      "matches" + "ReleasedV0_1_84Ledger",
      "migration" + "LedgerDigest",
      "COMPLETED_" + "LEDGER_CONTRACT",
      "RELEASED_V0_1_84_" + "LEDGER_CONTRACT",
    ].join("|"),
  },
  {
    label: "retired cutover control plane",
    pattern: [
      "hypermedia_" + "cutover",
      "MIGRATOR_" + "MAX_VERSION",
      "retire_" + "cutover_runtime",
      "retire_hypermedia_" + "cutover_control_plane",
    ].join("|"),
  },
] as const;

function command(arguments_: string[]): { exitCode: number; output: string } {
  const result = Bun.spawnSync(arguments_, {
    cwd: repositoryRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    output: `${result.stdout.toString()}${result.stderr.toString()}`,
  };
}

function liveFiles(): string[] {
  const result = command([
    "git", "ls-files", "--", "apps", "packages", "deploy", ".github/workflows", "scripts",
    "Dockerfile", "compose.yml", "compose.test.yml",
  ]);
  if (result.exitCode !== 0) throw new Error(`Unable to enumerate audit scope:\n${result.output}`);
  return result.output.split("\n").filter((path) => {
    if (!path) return false;
    if (path === "scripts/filesystem-deprecation-audit.ts") return false;
    if (path.includes("/migrations/") || path.includes("/templates/")) return false;
    if (/\.(?:test|spec)\.[^.]+$/.test(path)) return false;
    return /(?:Dockerfile|\.(?:ts|tsx|js|mjs|cjs|sh|sql|ya?ml|json))$/.test(path);
  });
}

export function auditFilesystemDeprecation(): string[] {
  const files = liveFiles();
  const violations: string[] = [];
  for (const rule of RULES) {
    const pattern = new RegExp(rule.pattern);
    const matches: string[] = [];
    for (const path of files) {
      const lines = readFileSync(join(repositoryRoot, path), "utf8").split("\n");
      for (const [index, line] of lines.entries()) {
        if (pattern.test(line)) matches.push(`${path}:${index + 1}:${line}`);
      }
    }
    if (matches.length) violations.push(`${rule.label}:\n${matches.join("\n")}`);
  }
  return violations;
}

if (import.meta.main) {
  const violations = auditFilesystemDeprecation();
  if (violations.length) {
    console.error(`Filesystem deprecation closure audit failed:\n\n${violations.join("\n\n")}`);
    process.exitCode = 1;
  } else {
    console.info("Filesystem deprecation closure audit passed");
  }
}
