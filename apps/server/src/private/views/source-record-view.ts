import type { SourceRecord } from "@context-use/database";

export type DashboardSourceRecord = {
  id: string;
  current_version_id: string | null;
  version_number: number | null;
  integration: string;
  model: string;
  source_updated_at: Date | string;
  deleted_at: Date | string | null;
  rendered_html: string;
};

export function dashboardSourceRecord(
  record: SourceRecord,
  renderedHtml: string,
): DashboardSourceRecord {
  return {
    id: record.object_id,
    current_version_id: record.current_revision_id,
    version_number: record.revision_number,
    integration: record.integration,
    model: record.model,
    source_updated_at: record.source_updated_at,
    deleted_at: record.deleted_at,
    rendered_html: renderedHtml,
  };
}
