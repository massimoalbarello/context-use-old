import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { MigrationDescriptor } from "../migration-state.ts";

export type LoadedMigration = MigrationDescriptor & {
  sql: string;
};

export const MIGRATION_STREAM_ORDER = ["auth", "application"] as const;
export type MigrationStream = (typeof MIGRATION_STREAM_ORDER)[number];
export type MigrationStreams = Record<MigrationStream, LoadedMigration[]>;

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

export async function loadMigrationStreams({
  directory,
}: {
  directory: string;
}): Promise<MigrationStreams> {
  const catalogs = await Promise.all(
    MIGRATION_STREAM_ORDER.map((stream) =>
      loadMigrationCatalog({ directory: join(directory, stream) })
    ),
  );
  return { auth: catalogs[0]!, application: catalogs[1]! };
}

export function releaseMigrationCatalog(streams: MigrationStreams): MigrationDescriptor[] {
  return MIGRATION_STREAM_ORDER.flatMap((stream) =>
    streams[stream].map(({ version, checksum }) => ({
      version: `${stream}/${version}`,
      checksum,
    }))
  );
}
