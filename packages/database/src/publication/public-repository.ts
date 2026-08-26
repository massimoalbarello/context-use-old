import type { PublicRouteInput } from "@context-use/shared";
import type { Pool } from "pg";
import type { PublicAsset, PublicPage, PublicRouteResolution, PublicRouteRow } from "./models.ts";
import { toPublicRoute } from "./rows.ts";

export class PublicRepository {
  constructor(private readonly publicPool: Pool) {}

  async pages(): Promise<PublicPage[]> {
    const result = await this.publicPool.query<PublicPage>(
      `SELECT public_id,canonical_path,markdown_path,public_title,public_summary,
         public_last_edited_at,representation_token
       FROM public_pages
       ORDER BY public_id`,
    );
    return result.rows.map((row) => ({
      public_id: row.public_id,
      canonical_path: row.canonical_path,
      markdown_path: row.markdown_path,
      public_title: row.public_title,
      public_summary: row.public_summary,
      public_last_edited_at: row.public_last_edited_at,
      representation_token: row.representation_token,
    }));
  }

  async assets(): Promise<PublicAsset[]> {
    const result = await this.publicPool.query<PublicAsset>(
      `SELECT public_id,canonical_path,public_filename,public_content_type,
         public_width,public_height,public_duration_seconds,representation_token
       FROM public_assets
       ORDER BY public_id`,
    );
    return result.rows.map((row) => ({
      public_id: row.public_id,
      canonical_path: row.canonical_path,
      public_filename: row.public_filename,
      public_content_type: row.public_content_type,
      public_width: row.public_width,
      public_height: row.public_height,
      public_duration_seconds: row.public_duration_seconds,
      representation_token: row.representation_token,
    }));
  }

  entrypoint(): Promise<PublicRouteResolution> {
    return this.resolve("/p/");
  }

  async resolve(route: PublicRouteInput): Promise<PublicRouteResolution> {
    const result = await this.publicPool.query<PublicRouteRow>(
      `SELECT state,route_kind,canonical_path,public_id,representation_token,
         public_title,public_summary,public_last_edited_at,public_filename,
         public_content_type,public_width,public_height,public_duration_seconds
       FROM resolve_public_route($1)`,
      [route],
    );
    if (result.rows.length !== 1) {
      throw new Error("Public route did not resolve to exactly one state");
    }
    return toPublicRoute(result.rows[0]!);
  }
}
