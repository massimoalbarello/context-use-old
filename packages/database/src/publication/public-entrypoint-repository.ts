import type { PublicationEntrypointInput } from "@context-use/shared";
import type { Pool } from "pg";
import type { PublicationEntrypoint, PublicationEntrypointCandidate } from "./models.ts";
import { requireRow } from "./rows.ts";

export class PublicEntrypointRepository {
  constructor(private readonly dashboardPool: Pool) {}

  async get(): Promise<PublicationEntrypoint> {
    const result = await this.dashboardPool.query<PublicationEntrypoint>(
      `SELECT public_id,configured,active
       FROM get_publication_entrypoint()`,
    );
    const row = requireRow({ row: result.rows[0], description: "Publication entrypoint" });
    return { public_id: row.public_id, configured: row.configured, active: row.active };
  }

  async candidates(): Promise<PublicationEntrypointCandidate[]> {
    const result = await this.dashboardPool.query<PublicationEntrypointCandidate>(
      `SELECT public_id,public_title,public_summary,public_last_edited_at,
         representation_token
       FROM list_publication_entrypoint_candidates()
       ORDER BY public_title,public_id`,
    );
    return result.rows.map((row) => ({
      public_id: row.public_id,
      public_title: row.public_title,
      public_summary: row.public_summary,
      public_last_edited_at: row.public_last_edited_at,
      representation_token: row.representation_token,
    }));
  }

  async set(input: PublicationEntrypointInput): Promise<PublicationEntrypoint> {
    const result = await this.dashboardPool.query<PublicationEntrypoint>(
      `SELECT public_id,configured,active
       FROM set_publication_entrypoint($1)`,
      [input.public_id],
    );
    const row = requireRow({ row: result.rows[0], description: "Publication entrypoint" });
    return { public_id: row.public_id, configured: row.configured, active: row.active };
  }
}
