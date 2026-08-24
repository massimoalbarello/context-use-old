import type {
  DashboardDocumentCatalogPage,
  DashboardDocumentKind,
  DashboardDocumentSummary,
} from "@context-use/shared";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { api } from "../api.ts";

type DocumentFilter = "all" | DashboardDocumentKind | "archived";

export function documentDisplayTitle(document: DashboardDocumentSummary): string {
  return document.title?.trim() || document.filename?.trim() || "Untitled document";
}

export function documentDisplaySummary(document: DashboardDocumentSummary): string {
  if (document.summary?.trim()) return document.summary;
  if (document.document_kind === "asset") {
    return document.content_type ? `Asset · ${document.content_type}` : "Document asset";
  }
  return document.document_kind === "record" ? "Connected source record" : "No summary yet";
}

function documentKindLabel(document: DashboardDocumentSummary): string {
  if (document.operational_roles.includes("global_guide")) return "Guide";
  if (document.operational_roles.includes("automation_instructions")) return "Instructions";
  if (document.operational_roles.includes("automation_state")) return "Automation state";
  if (document.document_kind === "asset") return "Asset";
  if (document.document_kind === "record") return "Source";
  return "Page";
}

function DocumentIcon({ document }: { document: DashboardDocumentSummary }) {
  if (document.document_kind === "asset") {
    return <svg viewBox="0 0 20 20" aria-hidden="true">
      <rect x="3" y="3" width="14" height="14" rx="2" />
      <circle cx="13.5" cy="6.5" r="1.25" />
      <path d="m4.8 14 3.4-3.7 2.6 2.5 2-2 2.4 2.3" />
    </svg>;
  }
  if (document.document_kind === "record") {
    return <svg viewBox="0 0 20 20" aria-hidden="true">
      <ellipse cx="10" cy="5" rx="6" ry="2.5" />
      <path d="M4 5v5c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5V5M4 10v5c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5v-5" />
    </svg>;
  }
  return <svg viewBox="0 0 20 20" aria-hidden="true">
    <path d="M5 2.75h6.5L15 6.25v11H5v-14.5Z" />
    <path d="M11.5 2.75v3.5H15M7.5 9h5M7.5 12h5" />
  </svg>;
}

export function documentCatalogUrl(
  query: string,
  filter: DocumentFilter,
  cursor?: string,
): string {
  const parameters = new URLSearchParams({ limit: "40" });
  if (query.trim()) parameters.set("q", query.trim());
  if (filter === "archived") parameters.set("lifecycle", "archived");
  else if (filter !== "all") parameters.set("kind", filter);
  if (cursor) parameters.set("cursor", cursor);
  return `/api/dashboard/documents?${parameters}`;
}

export function DocumentNavigator({
  query,
  selectedId,
  refreshToken,
  onCreate,
  onSelect,
}: {
  query: string;
  selectedId: string | null;
  refreshToken: number;
  onCreate?: () => void;
  onSelect: (document: DashboardDocumentSummary) => void;
}) {
  const [filter, setFilter] = useState<DocumentFilter>("all");
  const [page, setPage] = useState<DashboardDocumentCatalogPage>({
    documents: [],
    next_cursor: null,
    has_more: false,
  });
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const queryKey = `${query.trim()}\u0000${filter}`;
  const queryKeyRef = useRef(queryKey);
  queryKeyRef.current = queryKey;

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setLoading(true);
      setError("");
      api<DashboardDocumentCatalogPage>(documentCatalogUrl(query, filter), {
        signal: controller.signal,
      }).then(setPage).catch((caught: unknown) => {
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        setError(caught instanceof Error ? caught.message : "Could not load documents");
      }).finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    }, query.trim() ? 180 : 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [filter, query, refreshToken]);

  const loadMore = async () => {
    if (!page.next_cursor || loadingMore) return;
    const requestedQueryKey = queryKey;
    setLoadingMore(true);
    setError("");
    try {
      const next = await api<DashboardDocumentCatalogPage>(
        documentCatalogUrl(query, filter, page.next_cursor),
      );
      if (queryKeyRef.current !== requestedQueryKey) return;
      const seen = new Set(page.documents.map((document) => document.document_id));
      setPage({
        ...next,
        documents: [...page.documents, ...next.documents.filter(
          (document) => !seen.has(document.document_id),
        )],
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load more documents");
    } finally {
      setLoadingMore(false);
    }
  };

  const moveFocus = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next: number | null = null;
    if (event.key === "ArrowDown") next = Math.min(index + 1, page.documents.length - 1);
    else if (event.key === "ArrowUp") next = Math.max(index - 1, 0);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = page.documents.length - 1;
    if (next === null) return;
    event.preventDefault();
    itemRefs.current[next]?.focus();
  };

  return <section className="document-navigator" aria-label="Knowledge documents">
    <div className="document-filter" aria-label="Document type filter">
      {(["all", "knowledge", "asset", "record", "archived"] as const).map((value) => <button
        type="button"
        className={filter === value ? "active" : ""}
        aria-pressed={filter === value}
        key={value}
        onClick={() => setFilter(value)}
      >{value === "all" ? "All" : value === "knowledge" ? "Pages" : value === "asset" ? "Assets" : value === "record" ? "Records" : "Archived"}</button>)}
      {onCreate && <button type="button" className="document-create" onClick={onCreate}>+ New page</button>}
    </div>
    <div className="document-list-heading">
      <strong>{query.trim() ? "Search results" : "Recently updated"}</strong>
      {!loading && <span>{page.documents.length}{page.has_more ? "+" : ""}</span>}
    </div>
    <div className="document-list" aria-live="polite">
      {loading && <div className="document-list-state">Searching your knowledge…</div>}
      {!loading && error && !page.documents.length && <div className="document-list-state error">{error}</div>}
      {!loading && !error && !page.documents.length && <div className="document-list-state">
        {query.trim() ? "No matching documents" : filter === "archived" ? "No archived documents" : filter === "record" ? "No source records yet" : "No active documents yet"}
      </div>}
      {!loading && page.documents.map((document, index) => <button
        type="button"
        className={`document-result${selectedId === document.document_id ? " selected" : ""}`}
        aria-current={selectedId === document.document_id ? "page" : undefined}
        key={document.document_id}
        ref={(element) => { itemRefs.current[index] = element; }}
        onClick={() => onSelect(document)}
        onKeyDown={(event) => moveFocus(event, index)}
      >
        <span className="document-result-icon"><DocumentIcon document={document} /></span>
        <span className="document-result-copy">
          <span className="document-result-title">{documentDisplayTitle(document)}</span>
          <span className="document-result-summary">{documentDisplaySummary(document)}</span>
          <span className="document-result-meta">
            <i>{documentKindLabel(document)}</i>
            {document.lifecycle !== "active" && <i>{document.lifecycle}</i>}
            <time dateTime={document.updated_at}>{new Intl.DateTimeFormat(undefined, {
              month: "short",
              day: "numeric",
            }).format(new Date(document.updated_at))}</time>
          </span>
        </span>
      </button>)}
    </div>
    {page.has_more && <button
      type="button"
      className="document-load-more"
      disabled={loadingMore}
      onClick={() => void loadMore()}
    >{loadingMore ? "Loading…" : "Load more"}</button>}
    {error && page.documents.length > 0 && <p className="document-inline-error error">{error}</p>}
  </section>;
}
