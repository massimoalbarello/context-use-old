import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  LEGACY_MIGRATION_MAX,
  migrationPolicyViolations,
} from "../packages/database/src/migration-policy.ts";

const migrationsDirectory = join(import.meta.dir, "../packages/database/migrations");
const migrationName = /^(\d{3})_[a-z0-9_]+\.sql$/;

async function checkMigrations(): Promise<void> {
  const files = (await readdir(migrationsDirectory)).filter((file) => file.endsWith(".sql")).sort();
  const errors: string[] = [];
  const seenNumbers = new Set<number>();

  for (const file of files) {
    const match = migrationName.exec(file);
    if (!match) {
      errors.push(`${file}: migration names must match NNN_lowercase_name.sql`);
      continue;
    }

    const number = Number(match[1]);
    if (seenNumbers.has(number)) {
      errors.push(`${file}: migration number ${number} is duplicated`);
    }
    seenNumbers.add(number);

    if (number <= LEGACY_MIGRATION_MAX) {
      continue;
    }

    const sql = await readFile(join(migrationsDirectory, file), "utf8");
    for (const violation of migrationPolicyViolations(sql)) {
      errors.push(
        `${file}:${violation.line}: migrations cannot execute data work: ${violation.statement}`,
      );
    }
  }

  const ordered = [...seenNumbers];
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index] !== ordered[index - 1]! + 1) {
      errors.push(
        `migration sequence has a gap between ${ordered[index - 1]} and ${ordered[index]}`,
      );
    }
  }

  if (errors.length) {
    throw new Error(`Migration policy failed:\n${errors.join("\n")}`);
  }
}

await checkMigrations();
