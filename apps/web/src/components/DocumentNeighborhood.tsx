import type {
  DashboardDocumentNeighborhood,
  DashboardDocumentSummary,
} from "@context-use/shared";
import { useEffect, useState } from "react";
import { api } from "../api.ts";
import { documentDisplaySummary, documentDisplayTitle } from "./DocumentNavigator.tsx";

function NeighborButton({
  document,
  relation,
  onOpen,
}: {
  document: DashboardDocumentSummary;
  relation: "outbound" | "backlink";
  onOpen: (document: DashboardDocumentSummary) => void;
}) {
  return <button type="button" onClick={() => onOpen(document)}>
    <span>{documentDisplayTitle(document)}</span>
    <small>{documentDisplaySummary(document)}</small>
    <i aria-hidden="true">{relation === "outbound" ? "→" : "←"}</i>
  </button>;
}

export function DocumentNeighborhood({
  documentId,
  onOpen,
}: {
  documentId: string;
  onOpen: (document: DashboardDocumentSummary) => void;
}) {
  const [neighborhood, setNeighborhood] = useState<DashboardDocumentNeighborhood | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    setNeighborhood(null);
    setError("");
    api<DashboardDocumentNeighborhood>(
      `/api/dashboard/documents/${documentId}/neighborhood?limit=100`,
      { signal: controller.signal },
    ).then(setNeighborhood).catch((caught: unknown) => {
      if (caught instanceof DOMException && caught.name === "AbortError") return;
      setError(caught instanceof Error ? caught.message : "Could not load document links");
    });
    return () => controller.abort();
  }, [documentId]);

  if (error) return <aside className="document-neighborhood compact error" role="status">{error}</aside>;
  if (!neighborhood) return null;

  const outbound = neighborhood.outbound.neighbors
    .filter((neighbor): neighbor is typeof neighbor & { document: DashboardDocumentSummary } => (
      neighbor.resolved && neighbor.document !== null
    ));
  const unresolved = neighborhood.outbound.neighbors.length - outbound.length;
  const backlinks = neighborhood.backlinks.documents;
  if (!outbound.length && !backlinks.length && !unresolved && neighborhood.outbound.index_complete) {
    return null;
  }

  return <aside className="document-neighborhood" aria-label="Document connections">
    {(outbound.length > 0 || unresolved > 0) && <section>
      <header><h2>Links from this page</h2><span>{neighborhood.outbound.neighbors.length}{neighborhood.outbound.has_more ? "+" : ""}</span></header>
      {outbound.length > 0 && <div>{outbound.map((neighbor) => <NeighborButton
        key={neighbor.target_document_id}
        document={neighbor.document}
        relation="outbound"
        onOpen={onOpen}
      />)}</div>}
      {unresolved > 0 && <p>{unresolved} linked document{unresolved === 1 ? " is" : "s are"} unavailable.</p>}
      {neighborhood.outbound.has_more && <p>More outgoing links are available from this page.</p>}
    </section>}
    {backlinks.length > 0 && <section>
      <header><h2>Referenced by</h2><span>{backlinks.length}{neighborhood.backlinks.has_more ? "+" : ""}</span></header>
      <div>{backlinks.map((document) => <NeighborButton
        key={document.document_id}
        document={document}
        relation="backlink"
        onOpen={onOpen}
      />)}</div>
      {neighborhood.backlinks.has_more && <p>More backlinks are available for this document.</p>}
    </section>}
    {!neighborhood.outbound.index_complete && <p className="document-index-state">
      Links for this revision are still being indexed.
    </p>}
  </aside>;
}
