import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { migrationPolicyViolations } from "../packages/database/src/migration-policy.ts";

const migrationsDirectory = join(import.meta.dir, "../packages/database/migrations");
const migrationName = /^(\d{3})_[a-z0-9_]+\.sql$/;
const streams = ["auth", "application"] as const;
const snapshotExceptions = new Set([
  "auth/002_better_auth.sql",
  "application/001_application_schema.sql",
]);

async function checkMigrations(): Promise<void> {
  const errors: string[] = [];
  const entries = await readdir(migrationsDirectory, { withFileTypes: true });
  const unexpected = entries
    .filter(
      (entry) =>
        !entry.isDirectory() || !streams.includes(entry.name as (typeof streams)[number]),
    )
    .map(({ name }) => name);
  if (unexpected.length) {
    errors.push(`migration root contains unexpected entries: ${unexpected.join(", ")}`);
  }

  for (const stream of streams) {
    const files = (await readdir(join(migrationsDirectory, stream)))
      .filter((file) => file.endsWith(".sql"))
      .sort();
    const seenNumbers = new Set<number>();

    for (const file of files) {
      const migration = `${stream}/${file}`;
      const match = migrationName.exec(file);
      if (!match) {
        errors.push(`${migration}: migration names must match NNN_lowercase_name.sql`);
        continue;
      }

      const number = Number(match[1]);
      if (seenNumbers.has(number)) {
        errors.push(`${migration}: migration number ${number} is duplicated`);
      }
      seenNumbers.add(number);

      if (snapshotExceptions.has(migration)) continue;
      const sql = await readFile(join(migrationsDirectory, stream, file), "utf8");
      for (const violation of migrationPolicyViolations(sql)) {
        errors.push(
          `${migration}:${violation.line}: migrations cannot execute data work: ${violation.statement}`,
        );
      }
    }

    const ordered = [...seenNumbers];
    for (let index = 1; index < ordered.length; index += 1) {
      if (ordered[index] !== ordered[index - 1]! + 1) {
        errors.push(
          `${stream} migration sequence has a gap between ${ordered[index - 1]} and ${ordered[index]}`,
        );
      }
    }
    if (ordered[0] !== 1) {
      errors.push(`${stream} migration sequence must start at 001`);
    }
  }

  if (errors.length) {
    throw new Error(`Migration policy failed:\n${errors.join("\n")}`);
  }
}

await checkMigrations();
