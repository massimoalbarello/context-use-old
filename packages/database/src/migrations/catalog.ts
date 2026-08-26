import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { MigrationDescriptor } from "../migration-state.ts";

export type LoadedMigration = MigrationDescriptor & {
  sql: string;
};

export async function loadMigrationCatalog({
  directory,
}: {
  directory: string;
}): Promise<LoadedMigration[]> {
  const files = (await readdir(directory)).filter((file) => file.endsWith(".sql")).sort();

  return Promise.all(
    files.map(async (version) => {
      const sql = await readFile(join(directory, version), "utf8");
      return {
        version,
        sql,
        checksum: createHash("sha256").update(sql).digest("hex"),
      };
    }),
  );
}
