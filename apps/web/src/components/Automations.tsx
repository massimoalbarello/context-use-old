import type { DashboardDocumentSummary } from "@context-use/shared";
import { useEffect, useState } from "react";
import { api } from "../api.ts";
import { documentDisplaySummary, documentDisplayTitle } from "./DocumentNavigator.tsx";

export type DashboardAutomation = {
  id: string;
  name: string;
  instructions: DashboardDocumentSummary | null;
};

type AutomationCatalog = { automations: DashboardAutomation[] };

export function AutomationList({
  automations,
  onOpenDocument,
}: {
  automations: DashboardAutomation[];
  onOpenDocument: (documentId: string) => void;
}) {
  if (!automations.length) return <p className="automations-empty">No automations are registered.</p>;
  return <div className="automation-list">{automations.map((automation) => <article key={automation.id}>
    <h2>{automation.name}</h2>
    {automation.instructions ? <button type="button" onClick={() => onOpenDocument(automation.instructions!.document_id)}>
      <span>View instructions</span>
      <strong>{documentDisplayTitle(automation.instructions)}</strong>
      <small>{documentDisplaySummary(automation.instructions)}</small>
    </button> : <p>Instruction page unavailable</p>}
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
    <header><div><span className="eyebrow">Operational knowledge</span><h1>Automations</h1><p>Open an automation to see the instructions that define its behavior.</p></div></header>
    {loading ? <p className="automations-empty">Loading automations…</p> : error ? <p className="automations-empty error" role="alert">{error}</p> : <AutomationList automations={automations} onOpenDocument={onOpenDocument} />}
  </main>;
}
