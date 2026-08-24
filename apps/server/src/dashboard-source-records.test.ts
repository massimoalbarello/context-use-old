import { describe, expect, test } from "bun:test";
import type { SourceRecordDocument } from "@context-use/database";
import { dashboardSourceRecord } from "./dashboard-source-records.ts";

const record: SourceRecordDocument = {
  document_id: "11111111-1111-4111-8111-111111111111",
  current_revision_id: "22222222-2222-4222-8222-222222222222",
  reference: "context-use://document/11111111-1111-4111-8111-111111111111",
  authority: "source",
  revision_number: 3,
  integration: "granola",
  connection_instance_id: 42,
  connection_id: "private-connection",
  model: "GranolaMeeting",
  source_record_id: "private-record",
  source_created_at: new Date("2026-08-23T09:00:00.000Z"),
  source_updated_at: new Date("2026-08-23T10:00:00.000Z"),
  deleted_at: null,
  created_at: new Date("2026-08-23T09:01:00.000Z"),
  updated_at: new Date("2026-08-23T10:01:00.000Z"),
  body_markdown: "# Product review\n\nThe exact source body.",
};

describe("dashboard source records", () => {
  test("projects a rendered read-only page without connector-private identifiers", () => {
    const response = dashboardSourceRecord(record, "<h1>Product review</h1>");
    expect(response).toEqual({
      id: record.document_id,
      current_version_id: record.current_revision_id,
      version_number: 3,
      integration: "granola",
      model: "GranolaMeeting",
      source_updated_at: record.source_updated_at,
      deleted_at: null,
      rendered_html: "<h1>Product review</h1>",
    });
    const encoded = JSON.stringify(response);
    expect(encoded).not.toContain("private-connection");
    expect(encoded).not.toContain("private-record");
    expect(encoded).not.toContain("body_markdown");
    expect(encoded).not.toContain("body_object_key");
  });
});
