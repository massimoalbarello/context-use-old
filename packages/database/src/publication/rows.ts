import type { PublicRouteResolution, PublicRouteRow } from "./models.ts";

export function requireRow<T>({
  row,
  description,
}: {
  row: T | undefined;
  description: string;
}): T {
  if (!row) {
    throw new Error(`${description} was not returned`);
  }
  return row;
}

export function toPublicRoute(row: PublicRouteRow): PublicRouteResolution {
  if (row.state !== "active") {
    return { state: row.state, route_kind: row.route_kind };
  }
  if (row.route_kind === "asset") {
    if (
      !row.canonical_path ||
      !row.public_id ||
      !row.representation_token ||
      !row.public_filename ||
      !row.public_content_type
    ) {
      throw new Error("Active asset route is incomplete");
    }
    return {
      state: "active",
      route_kind: "asset",
      canonical_path: row.canonical_path,
      public_id: row.public_id,
      representation_token: row.representation_token,
      public_filename: row.public_filename,
      public_content_type: row.public_content_type,
      public_width: row.public_width,
      public_height: row.public_height,
      public_duration_seconds: row.public_duration_seconds,
    };
  }
  if (
    !row.canonical_path ||
    !row.public_id ||
    !row.representation_token ||
    !row.public_title ||
    !row.public_summary ||
    !row.public_last_edited_at
  ) {
    throw new Error("Active page route is incomplete");
  }
  return {
    state: "active",
    route_kind: row.route_kind,
    canonical_path: row.canonical_path,
    public_id: row.public_id,
    representation_token: row.representation_token,
    public_title: row.public_title,
    public_summary: row.public_summary,
    public_last_edited_at: row.public_last_edited_at,
  };
}
