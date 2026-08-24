import { useEffect, useState } from "react";
import { api } from "../api.ts";
import type { SourceRecordPage } from "../types.ts";

export function sourceRecordPageUrl(documentId: string): string {
  return `/api/dashboard/source-records/${documentId}`;
}

function sourceLabel(record: SourceRecordPage): string {
  const integration = record.integration.replaceAll("-", " ");
  const model = record.model.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  return `${integration} · ${model}`;
}

export function SourceRecordContents({ record }: { record: SourceRecordPage }) {
  return <main className="editor source-record-page">
    <header className="editor-header source-record-header">
      <div>
        <span className="document-kicker">Connected source · Read-only</span>
        <p className="source-record-origin">{sourceLabel(record)}</p>
        <time className="page-last-edited" dateTime={new Date(record.source_updated_at).toISOString()}>
          Synced {new Intl.DateTimeFormat(undefined, {
            dateStyle: "medium",
            timeStyle: "short",
          }).format(new Date(record.source_updated_at))}
        </time>
      </div>
      <span className="status">{record.deleted_at ? "Deleted at source" : `Synced${record.version_number ? ` · v${record.version_number}` : ""}`}</span>
    </header>
    {record.deleted_at && <div className="source-record-notice" role="status">
      This record was deleted from its connected source. Its last retained content is shown below.
    </div>}
    {record.rendered_html
      ? <article className="rendered" dangerouslySetInnerHTML={{ __html: record.rendered_html }} />
      : <section className="source-record-empty">This source record has no retained Markdown body.</section>}
  </main>;
}

export function SourceRecord({ documentId }: { documentId: string }) {
  const [record, setRecord] = useState<SourceRecordPage | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    setRecord(null);
    setError("");
    api<SourceRecordPage>(sourceRecordPageUrl(documentId), {
      signal: controller.signal,
    }).then(setRecord).catch((caught: unknown) => {
      if (caught instanceof DOMException && caught.name === "AbortError") return;
      setError(caught instanceof Error ? caught.message : "Could not load source record");
    });
    return () => controller.abort();
  }, [documentId]);

  if (!record) return <main className="editor-empty">{error || "Loading source record…"}</main>;

  return <SourceRecordContents record={record} />;
}
