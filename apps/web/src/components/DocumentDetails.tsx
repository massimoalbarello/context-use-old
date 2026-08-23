import type { DashboardDocumentSummary } from "@context-use/shared";
import { documentDisplaySummary, documentDisplayTitle } from "./DocumentNavigator.tsx";

function kindLabel(document: DashboardDocumentSummary): string {
  if (document.document_kind === "record") return "Connected source record";
  if (document.document_kind === "asset") return "Document asset";
  return "Knowledge document";
}

export function DocumentDetails({ document }: { document: DashboardDocumentSummary }) {
  return <main className="content-page catalog-document-details">
    <header>
      <div>
        <span className="document-kicker">{kindLabel(document)}</span>
        <h1>{documentDisplayTitle(document)}</h1>
        <p className="knowledge-summary">{documentDisplaySummary(document)}</p>
      </div>
      <span className="status">{document.lifecycle}</span>
    </header>
    <section className="catalog-document-card">
      <dl>
        <div><dt>Representation</dt><dd>{document.representation}</dd></div>
        {document.content_type && <div><dt>Type</dt><dd>{document.content_type}</dd></div>}
        <div><dt>Last updated</dt><dd>{new Intl.DateTimeFormat(undefined, {
          dateStyle: "medium",
          timeStyle: "short",
        }).format(new Date(document.updated_at))}</dd></div>
      </dl>
      <div className="asset-reference">
        <span>Private reference</span>
        <code>context-use://document/{document.document_id}</code>
      </div>
      {document.document_kind === "record" && <p>
        This record is managed by its connected source. Follow links from authored knowledge to
        use it as context.
      </p>}
      {document.lifecycle !== "active" && <p>
        This retained identity is not part of active knowledge.
      </p>}
    </section>
  </main>;
}
