import type { Pool } from "pg";

/** Test-only reader for the legacy projection retained during schema contraction. */
export class LegacyPublicProjectionReader {
  constructor(private readonly pool: Pool) {}

  async settings() {
    const result = await this.pool.query<{ entrypoint_public_path: string | null }>(
      "SELECT entrypoint_public_path FROM published_site_settings",
    );
    return result.rows[0] ?? { entrypoint_public_path: null };
  }

  async assetByPublicPath(path: string) {
    const result = await this.pool.query(
      "SELECT public_path,filename,content_type,size_bytes FROM published_assets WHERE public_path=$1",
      [path],
    );
    return result.rows[0] ?? null;
  }

  async directoryIndex(path: string) {
    const result = await this.pool.query<{
      kind: "directory" | "page";
      path: string;
      title: string | null;
      summary: string | null;
      published_count: string;
      default_page_path: string | null;
      index_default_page_path: string | null;
      index_title: string;
      index_summary: string;
    }>(
      `WITH descendants AS (
         SELECT public_path,title,summary,
           CASE WHEN $1='' THEN public_path
                ELSE substr(public_path,length($1)+2)
           END AS relative_path
         FROM published_pages
         WHERE $1='' OR left(public_path,length($1)+1)=$1||'/'
       ), current_directory AS (
         SELECT title,summary FROM published_directories WHERE path=$1
       ), index_default AS (
         SELECT CASE
           WHEN $1<>'' AND count(*)=1 AND bool_and(strpos(relative_path,'/')=0)
           THEN min(public_path)
           ELSE NULL
         END AS default_page_path
         FROM descendants
       ), direct_pages AS (
         SELECT 'page'::text AS kind,public_path AS path,title,summary,
           1::bigint AS published_count,NULL::text AS default_page_path
         FROM descendants WHERE strpos(relative_path,'/')=0
       ), child_directories AS (
         SELECT
           CASE WHEN $1='' THEN split_part(relative_path,'/',1)
                ELSE $1||'/'||split_part(relative_path,'/',1)
           END AS path,
           count(*) AS published_count,
           CASE
             WHEN count(*)=1 AND bool_and(
               strpos(substr(relative_path,strpos(relative_path,'/')+1),'/')=0
             )
             THEN min(public_path)
             ELSE NULL
           END AS default_page_path
         FROM descendants
         WHERE strpos(relative_path,'/')>0
         GROUP BY 1
       ), described_child_directories AS (
         SELECT 'directory'::text AS kind,child.path,
           directory.title,directory.summary,child.published_count,
           child.default_page_path
         FROM child_directories child
         JOIN published_directories directory ON directory.path=child.path
       )
       SELECT kind,path,title,summary,published_count,default_page_path,
         (SELECT default_page_path FROM index_default) AS index_default_page_path,
         (SELECT title FROM current_directory) AS index_title,
         (SELECT summary FROM current_directory) AS index_summary
       FROM described_child_directories
       UNION ALL
       SELECT kind,path,title,summary,published_count,default_page_path,
         (SELECT default_page_path FROM index_default) AS index_default_page_path,
         (SELECT title FROM current_directory) AS index_title,
         (SELECT summary FROM current_directory) AS index_summary
       FROM direct_pages
       ORDER BY path,kind`,
      [path],
    );
    if (!result.rowCount) return null;
    return {
      path,
      title: result.rows[0]!.index_title,
      summary: result.rows[0]!.index_summary,
      default_page_path: result.rows[0]!.index_default_page_path,
      entries: result.rows.map((row) => ({
        kind: row.kind,
        path: row.path,
        title: row.title,
        summary: row.summary,
        published_count: Number(row.published_count),
        default_page_path: row.default_page_path,
      })),
    };
  }
}
