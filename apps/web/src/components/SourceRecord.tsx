import { useEffect, useState } from "react";
import { api } from "../api.ts";
import type { SourceRecordPage } from "../types.ts";
import { ActionDialog } from "./ActionDialog.tsx";

export function sourceRecordPageUrl(objectId: string): string {
  return `/api/dashboard/source-records/${objectId}`;
}

function sourceLabel(record: SourceRecordPage): string {
  const integration = record.integration.replaceAll("-", " ");
  const model = record.model.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  return `${integration} · ${model}`;
}

export function SourceRecordContents({
  record,
  busy = false,
  onArchive,
  onDelete,
}: {
  record: SourceRecordPage;
  busy?: boolean;
  onArchive?: () => void;
  onDelete?: () => void;
}) {
  return <main className="editor source-record-page">
    <header className="editor-header source-record-header">
      <div>
        <span className="object-kicker">Connected source · Content read-only</span>
        <p className="source-record-origin">{sourceLabel(record)}</p>
        <time className="page-last-edited" dateTime={new Date(record.source_updated_at).toISOString()}>
          Synced {new Intl.DateTimeFormat(undefined, {
            dateStyle: "medium",
            timeStyle: "short",
          }).format(new Date(record.source_updated_at))}
        </time>
      </div>
      <div className="button-row">
        <span className="status">{record.deleted_at ? "Archived" : `Synced${record.version_number ? ` · v${record.version_number}` : ""}`}</span>
        {!record.deleted_at && onArchive && <button disabled={busy} onClick={onArchive}>Archive</button>}
        {record.deleted_at && onDelete && <button className="danger" disabled={busy} onClick={onDelete}>Delete permanently</button>}
      </div>
    </header>
    {record.deleted_at && <div className="source-record-notice" role="status">
      This record is retired from active search and navigation. Its last retained content is shown below.
    </div>}
    {record.rendered_html
      ? <article className="rendered" dangerouslySetInnerHTML={{ __html: record.rendered_html }} />
      : <section className="source-record-empty">This source record has no retained Markdown body.</section>}
  </main>;
}

export function SourceRecord({
  objectId,
  onChanged = () => undefined,
  onDeleted = () => undefined,
}: {
  objectId: string;
  onChanged?: () => Promise<void> | void;
  onDeleted?: () => Promise<void> | void;
}) {
  const [record, setRecord] = useState<SourceRecordPage | null>(null);
  const [error, setError] = useState("");
  const [pendingAction, setPendingAction] = useState<"archive" | "delete" | null>(null);
  const [working, setWorking] = useState(false);
  const [actionError, setActionError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    setRecord(null);
    setError("");
    setPendingAction(null);
    setWorking(false);
    setActionError("");
    api<SourceRecordPage>(sourceRecordPageUrl(objectId), {
      signal: controller.signal,
    }).then(setRecord).catch((caught: unknown) => {
      if (caught instanceof DOMException && caught.name === "AbortError") return;
      setError(caught instanceof Error ? caught.message : "Could not load source record");
    });
    return () => controller.abort();
  }, [objectId]);

  if (!record) return <main className="editor-empty">{error || "Loading source record…"}</main>;

  const archive = async () => {
    setWorking(true);
    setActionError("");
    try {
      const updated = await api<SourceRecordPage>(`${sourceRecordPageUrl(record.id)}/archive`, {
        method: "POST",
        body: JSON.stringify({ expected_revision_id: record.current_version_id }),
      });
      setRecord(updated);
      setPendingAction(null);
      await onChanged();
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : "Archive failed");
    } finally {
      setWorking(false);
    }
  };

  const remove = async () => {
    setWorking(true);
    setActionError("");
    try {
      await api(sourceRecordPageUrl(record.id), {
        method: "DELETE",
        body: JSON.stringify({
          expected_revision_id: record.current_version_id,
          confirm: true,
        }),
      });
      setPendingAction(null);
      await onDeleted();
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : "Deletion failed");
    } finally {
      setWorking(false);
    }
  };

  return <>
    <SourceRecordContents
      record={record}
      busy={working}
      onArchive={() => { setActionError(""); setPendingAction("archive"); }}
      onDelete={() => { setActionError(""); setPendingAction("delete"); }}
    />
    {pendingAction === "archive" && <ActionDialog
      eyebrow="Connected source"
      title="Archive this source record?"
      description="This removes the record from active search and navigation while retaining its revisions. A later connector sync may restore a record that still exists upstream."
      confirmLabel="Archive record"
      workingLabel="Archiving…"
      working={working}
      error={actionError}
      onCancel={() => setPendingAction(null)}
      onConfirm={() => void archive()}
    />}
    {pendingAction === "delete" && <ActionDialog
      eyebrow="Permanent action"
      title="Delete this source record?"
      description="This permanently removes the archived record and every retained revision from the live database. It cannot be undone from the dashboard. If the upstream record still exists, a later connector sync may import it again."
      confirmLabel="Delete permanently"
      workingLabel="Deleting…"
      confirmTone="danger"
      working={working}
      error={actionError}
      onCancel={() => setPendingAction(null)}
      onConfirm={() => void remove()}
    />}
  </>;
}
