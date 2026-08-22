import { describe, expect, test } from "bun:test";
import type { Pool } from "pg";
import { DirectoryRepository } from "./directories.ts";

describe("directory mutation lock ordering", () => {
  function repository() {
    const calls: string[] = [];
    const query = async (sql: string) => {
      calls.push(sql);
      if (sql.includes("INSERT INTO knowledge_directories")) {
        return { rowCount: 1, rows: [{ id: crypto.randomUUID(), version_number: 1 }] };
      }
      if (sql.includes("UPDATE knowledge_directories")) {
        return { rowCount: 1, rows: [{ id: crypto.randomUUID(), version_number: 2 }] };
      }
      if (sql.includes("delete_empty_knowledge_directory")) {
        return { rowCount: 1, rows: [{ result: {
          status: "deleted", id: crypto.randomUUID(), current_path: "temporary",
        } }] };
      }
      return { rowCount: 0, rows: [] };
    };
    const pool = {
      async connect() {
        return { query, release() {} };
      },
    } as unknown as Pool;
    return { directories: new DirectoryRepository(pool), calls };
  }

  function expectTransitionBefore(calls: string[], mutation: string): void {
    const transition = calls.findIndex((sql) => sql.includes(
      "pg_advisory_xact_lock_shared",
    ));
    const mutationIndex = calls.findIndex((sql) => sql.includes(mutation));
    expect(transition).toBeGreaterThan(-1);
    expect(mutationIndex).toBeGreaterThan(transition);
  }

  test("create locks before inserting the directory", async () => {
    const { directories, calls } = repository();
    await directories.create({
      path: "temporary",
      title: "Temporary",
      summary: "A temporary directory.",
    });
    expectTransitionBefore(calls, "INSERT INTO knowledge_directories");
  });

  test("update locks before advancing directory metadata", async () => {
    const { directories, calls } = repository();
    await directories.update(crypto.randomUUID(), {
      title: "Updated",
      summary: "Updated directory metadata.",
      expected_version_number: 1,
    });
    expectTransitionBefore(calls, "UPDATE knowledge_directories");
  });

  test("delete locks before invoking the checked boundary", async () => {
    const { directories, calls } = repository();
    await directories.delete(crypto.randomUUID(), { expected_version_number: 1 });
    expectTransitionBefore(calls, "delete_empty_knowledge_directory");
  });
});
