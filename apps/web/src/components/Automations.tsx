import type { DashboardDocumentSummary } from "@context-use/shared";
import { useEffect, useState } from "react";
import { api } from "../api.ts";
import { documentDisplaySummary, documentDisplayTitle } from "./DocumentNavigator.tsx";

export type DashboardAutomation = {
  id: string;
  key: string;
  name: string;
  enabled: boolean;
  updated_at: string;
  disabled_at: string | null;
  instructions: DashboardDocumentSummary | null;
  state: DashboardDocumentSummary | null;
};

type AutomationCatalog = { automations: DashboardAutomation[] };

function AutomationDocument({
  document,
  label,
  onOpenDocument,
}: {
  document: DashboardDocumentSummary | null;
  label: "Instructions" | "State";
  onOpenDocument: (documentId: string) => void;
}) {
  return <div className="automation-document">
    <span>{label}</span>
    {document ? <>
      <button type="button" onClick={() => onOpenDocument(document.document_id)}>
        <strong>{documentDisplayTitle(document)}</strong>
        <small>{documentDisplaySummary(document)}</small>
      </button>
      <code>context-use://document/{document.document_id}</code>
    </> : <p>{label === "State" ? "No state document" : "Instruction document unavailable"}</p>}
  </div>;
}

export function AutomationList({
  automations,
  onOpenDocument,
}: {
  automations: DashboardAutomation[];
  onOpenDocument: (documentId: string) => void;
}) {
  if (!automations.length) return <p className="automations-empty">No automations are registered.</p>;
  return <div className="automation-list">{automations.map((automation) => <article key={automation.id}>
    <header>
      <div><span className="automation-key">{automation.key}</span><h2>{automation.name}</h2></div>
      <span className={automation.enabled ? "automation-status enabled" : "automation-status"}>{automation.enabled ? "Enabled" : "Disabled"}</span>
    </header>
    <div className="automation-documents">
      <AutomationDocument document={automation.instructions} label="Instructions" onOpenDocument={onOpenDocument} />
      <AutomationDocument document={automation.state} label="State" onOpenDocument={onOpenDocument} />
    </div>
    <time dateTime={automation.updated_at}>Registry updated {new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(automation.updated_at))}</time>
  </article>)}</div>;
}

export function Automations({ onOpenDocument }: { onOpenDocument: (documentId: string) => void }) {
  const [automations, setAutomations] = useState<DashboardAutomation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    api<AutomationCatalog>("/api/dashboard/automations", { signal: controller.signal })
      .then((result) => setAutomations(result.automations))
      .catch((caught: unknown) => {
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        setError(caught instanceof Error ? caught.message : "Could not load automations");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, []);

  return <main className="content-page automations-page">
    <header><div><span className="eyebrow">Operational knowledge</span><h1>Automations</h1><p>Registered workflows and the hypermedia documents that define their behavior and checkpoint state.</p></div></header>
    {loading ? <p className="automations-empty">Loading automations…</p> : error ? <p className="automations-empty error" role="alert">{error}</p> : <AutomationList automations={automations} onOpenDocument={onOpenDocument} />}
  </main>;
}
