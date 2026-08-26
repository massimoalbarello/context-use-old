import { describe, expect, test } from "bun:test";
import { migrationPolicyViolations } from "./migration-policy.ts";

describe("schema-only migration policy", () => {
  test("rejects top-level data work and anonymous execution", () => {
    const sql = `
      INSERT INTO pages(id) VALUES ('one');
      WITH target AS (SELECT id FROM pages) UPDATE pages SET title='x';
      DO $$ BEGIN DELETE FROM pages; END $$;
      CALL repair_pages();
    `;

    expect(migrationPolicyViolations(sql)).toHaveLength(4);
  });

  test("allows grants and DML that defines stored runtime behavior", () => {
    const sql = `
      GRANT SELECT, INSERT, UPDATE, DELETE ON auth.session TO context_use_auth;
      CREATE FUNCTION archive_page(target uuid) RETURNS void
      LANGUAGE plpgsql AS $$
      BEGIN
        UPDATE pages SET archived_at=now() WHERE id=target;
      END;
      $$;
    `;

    expect(migrationPolicyViolations(sql)).toEqual([]);
  });

  test("ignores statement-looking text in comments, strings, identifiers, and nested comments", () => {
    const sql = `
      -- DELETE FROM pages;
      /* outer INSERT /* nested UPDATE */ still a comment */
      COMMENT ON TABLE pages IS 'CALL repair_pages();';
      CREATE TABLE "DELETE" (value text DEFAULT 'INSERT INTO pages');
    `;

    expect(migrationPolicyViolations(sql)).toEqual([]);
  });
});
