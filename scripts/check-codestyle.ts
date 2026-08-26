const repositoryRoot = new URL("..", import.meta.url).pathname;
const supportedFile = /\.(?:css|js|json|jsonc|jsx|ts|tsx)$/;
const ignoredFiles = new Set([
  "apps/cli/src/command-tree.gen.ts",
  "apps/web/src/routeTree.gen.ts",
  "bun.lock",
]);

function gitFiles(args: string[]): string[] {
  const result = Bun.spawnSync({
    cmd: ["git", ...args],
    cwd: repositoryRoot,
    stderr: "inherit",
  });

  if (!result.success) {
    throw new Error(`git ${args.join(" ")} failed`);
  }

  return result.stdout
    .toString()
    .split("\n")
    .map((file) => file.trim())
    .filter(Boolean);
}

const changedFiles = gitFiles(["diff", "--name-only", "--diff-filter=ACMR", "origin/main", "--"]);
const untrackedFiles = gitFiles(["ls-files", "--others", "--exclude-standard"]);
const files = [...new Set([...changedFiles, ...untrackedFiles])]
  .filter((file) => supportedFile.test(file))
  .filter((file) => !ignoredFiles.has(file))
  .sort();

if (files.length === 0) {
  console.log("No changed files require Biome checks.");
  process.exit(0);
}

const write = process.argv.includes("--write");
const result = Bun.spawnSync({
  cmd: ["biome", "check", ...(write ? ["--write"] : []), ...files],
  cwd: repositoryRoot,
  stdout: "inherit",
  stderr: "inherit",
});

process.exit(result.exitCode);
