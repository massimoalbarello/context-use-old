import { useState } from "react";
import { api } from "../api.ts";
import type { KnowledgePage } from "../types.ts";

export function NewPage({
  onCancel,
  onCreated,
}: {
  onCancel: () => void;
  onCreated: (objectId: string) => void;
}) {
  const [draft, setDraft] = useState({ title: "", summary: "", body_markdown: "" });
  const [commit, setCommit] = useState("");
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState("");

  const create = async () => {
    setWorking(true);
    setMessage("");
    try {
      const page = await api<KnowledgePage>("/api/dashboard/objects", {
        method: "POST",
        body: JSON.stringify({ ...draft, commit_message: commit }),
      });
      onCreated(page.id);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Page creation failed");
    } finally {
      setWorking(false);
    }
  };

  return <main className="editor new-page-editor">
    <header className="editor-header">
      <div>
        <span className="object-kicker">New page</span>
        <h1>Create a standalone page</h1>
        <p className="knowledge-summary">Give it a clear title and summary. Link it to related objects with stable object references.</p>
      </div>
    </header>
    <section className="edit-grid">
      <div className="edit-top">
        <div className="editor-fields single-column">
          <label>Title<input autoFocus maxLength={240} value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></label>
          <label className="summary-field">Summary<input maxLength={320} required value={draft.summary} onChange={(event) => setDraft({ ...draft, summary: event.target.value })} /></label>
        </div>
      </div>
      <textarea className="markdown-editor" value={draft.body_markdown} onChange={(event) => setDraft({ ...draft, body_markdown: event.target.value })} spellCheck placeholder="Write Markdown. Link another object with [label](context-use://object/<uuid>)." />
      <footer className="save-bar">
        <input placeholder="Describe this page change (required)" value={commit} onChange={(event) => setCommit(event.target.value)} />
        <div className="button-row">
          <button disabled={working} onClick={onCancel}>Cancel</button>
          <button className="primary" disabled={working || !draft.title.trim() || !draft.summary.trim() || commit.trim().length < 3} onClick={() => void create()}>{working ? "Creating…" : "Create page"}</button>
        </div>
      </footer>
    </section>
    {message && <div className="toast">{message}</div>}
  </main>;
}
