import type {
  DashboardObjectCatalogPage,
  DashboardObjectKind,
  DashboardObjectSummary,
} from "@context-use/shared";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { api } from "../api.ts";

export type ObjectFilter = DashboardObjectKind | "public" | "archived";

const FILTER_OPTIONS: ReadonlyArray<{ value: ObjectFilter; label: string }> = [
  { value: "page", label: "Pages" },
  { value: "asset", label: "Assets" },
  { value: "record", label: "Records" },
  { value: "public", label: "Public pages" },
  { value: "archived", label: "Archived" },
];

export function sourceModelDisplayName(model: string): string {
  return model
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
}

export function objectDisplayTitle(object: DashboardObjectSummary): string {
  return object.title?.trim()
    || object.filename?.trim()
    || (object.object_kind === "record" && object.source_model
      ? sourceModelDisplayName(object.source_model)
      : "Untitled object");
}

export function objectDisplaySummary(object: DashboardObjectSummary): string {
  if (object.summary?.trim()) return object.summary;
  if (object.object_kind === "asset") {
    return object.content_type ? `Asset · ${object.content_type}` : "Asset";
  }
  return object.object_kind === "record"
    ? object.integration
      ? `Connected source · ${object.integration}`
      : "Connected source record"
    : "No summary yet";
}

function objectKindLabel(object: DashboardObjectSummary): string {
  if (object.operational_roles.includes("global_guide")) return "Guide";
  if (object.operational_roles.includes("automation_instructions")) return "Instructions";
  if (object.operational_roles.includes("automation_state")) return "Automation state";
  if (object.object_kind === "asset") return "Asset";
  if (object.object_kind === "record") return "Source";
  return "Page";
}

function ObjectIcon({ object }: { object: DashboardObjectSummary }) {
  if (object.object_kind === "asset") {
    return <svg viewBox="0 0 20 20" aria-hidden="true">
      <rect x="3" y="3" width="14" height="14" rx="2" />
      <circle cx="13.5" cy="6.5" r="1.25" />
      <path d="m4.8 14 3.4-3.7 2.6 2.5 2-2 2.4 2.3" />
    </svg>;
  }
  if (object.object_kind === "record") {
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

export function objectCatalogUrl(
  query: string,
  filters: readonly ObjectFilter[],
  cursor?: string,
): string {
  const parameters = new URLSearchParams({ limit: "40" });
  if (query.trim()) parameters.set("q", query.trim());
  if (filters.length) parameters.set("types", filters.join(","));
  if (cursor) parameters.set("cursor", cursor);
  return `/api/dashboard/objects?${parameters}`;
}

export function ObjectNavigator({
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
  onSelect: (object: DashboardObjectSummary) => void;
}) {
  const [filters, setFilters] = useState<ObjectFilter[]>([]);
  const [filterOpen, setFilterOpen] = useState(false);
  const [page, setPage] = useState<DashboardObjectCatalogPage>({
    objects: [],
    next_cursor: null,
    has_more: false,
  });
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const filterRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const infiniteLoaderRef = useRef<HTMLDivElement>(null);
  const filterKey = filters.join(",");
  const queryKey = `${query.trim()}\u0000${filterKey}`;
  const queryKeyRef = useRef(queryKey);
  queryKeyRef.current = queryKey;

  useEffect(() => {
    if (!filterOpen) return;
    const closeFilter = (event: PointerEvent) => {
      if (!filterRef.current?.contains(event.target as Node)) setFilterOpen(false);
    };
    const closeFilterWithKeyboard = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setFilterOpen(false);
    };
    document.addEventListener("pointerdown", closeFilter);
    document.addEventListener("keydown", closeFilterWithKeyboard);
    return () => {
      document.removeEventListener("pointerdown", closeFilter);
      document.removeEventListener("keydown", closeFilterWithKeyboard);
    };
  }, [filterOpen]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    const timer = window.setTimeout(() => {
      api<DashboardObjectCatalogPage>(objectCatalogUrl(query, filters), {
        signal: controller.signal,
      }).then(setPage).catch((caught: unknown) => {
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        setError(caught instanceof Error ? caught.message : "Could not load objects");
      }).finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    }, query.trim() ? 180 : 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [filterKey, query, refreshToken]);

  const loadMore = useCallback(async () => {
    if (!page.next_cursor || loadingMore) return;
    const requestedQueryKey = queryKey;
    setLoadingMore(true);
    setError("");
    try {
      const next = await api<DashboardObjectCatalogPage>(
        objectCatalogUrl(query, filters, page.next_cursor),
      );
      if (queryKeyRef.current !== requestedQueryKey) return;
      const seen = new Set(page.objects.map((object) => object.object_id));
      setPage({
        ...next,
        objects: [...page.objects, ...next.objects.filter(
          (object) => !seen.has(object.object_id),
        )],
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load more objects");
    } finally {
      setLoadingMore(false);
    }
  }, [filterKey, loadingMore, page, query, queryKey]);

  useEffect(() => {
    const root = listRef.current;
    const target = infiniteLoaderRef.current;
    if (!root || !target || !page.has_more || loading || loadingMore || error) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void loadMore();
    }, { root, rootMargin: "120px 0px" });
    observer.observe(target);
    return () => observer.disconnect();
  }, [error, loadMore, loading, loadingMore, page.has_more]);

  const moveFocus = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next: number | null = null;
    if (event.key === "ArrowDown") next = Math.min(index + 1, page.objects.length - 1);
    else if (event.key === "ArrowUp") next = Math.max(index - 1, 0);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = page.objects.length - 1;
    if (next === null) return;
    event.preventDefault();
    itemRefs.current[next]?.focus();
  };

  const toggleFilter = (value: ObjectFilter) => {
    setFilters((current) => {
      const next = new Set(current);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return FILTER_OPTIONS.map(({ value: option }) => option).filter((option) => next.has(option));
    });
  };

  const filterSummary = filters.length === 0
    ? "All types"
    : filters.length === 1
      ? FILTER_OPTIONS.find(({ value }) => value === filters[0])!.label
      : `${FILTER_OPTIONS.find(({ value }) => value === filters[0])!.label} +${filters.length - 1}`;

  return <section className="object-navigator" aria-label="Knowledge objects">
    <div className="object-toolbar">
    <div ref={filterRef} className="object-filter">
      <button
        type="button"
        className={`object-filter-toggle${filters.length ? " active" : ""}`}
        aria-label={`Filter object types: ${filters.length ? filters.map((filter) => FILTER_OPTIONS.find(({ value }) => value === filter)!.label).join(", ") : "all types"}`}
        aria-expanded={filterOpen}
        aria-haspopup="true"
        onClick={() => setFilterOpen((open) => !open)}
      ><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3.5 5h13M6 10h8M8.5 15h3" /></svg><span>Filter</span><strong>{filterSummary}</strong><i aria-hidden="true" /></button>
      {filterOpen && <div className="object-filter-menu" aria-label="Object type filter">
        <div className="object-filter-menu-heading"><span>Select one or more</span>{filters.length > 0 && <button type="button" onClick={() => setFilters([])}>Clear</button>}</div>
        {FILTER_OPTIONS.map(({ value, label }) => <label key={value}>
          <input
            type="checkbox"
            checked={filters.includes(value)}
            onChange={() => toggleFilter(value)}
          />
          <span aria-hidden="true">✓</span>
          <strong>{label}</strong>
        </label>)}
      </div>}
    </div>
    {onCreate && <button type="button" className="page-create" onClick={onCreate}>+ New page</button>}
    </div>
    <div className="object-list-heading">
      <strong>{query.trim() ? "Search results" : "Recently updated"}</strong>
      {!loading && <span>{page.objects.length}{page.has_more ? "+" : ""}</span>}
    </div>
    <div ref={listRef} className="object-list" aria-live="polite">
      {loading && <div className="object-list-state">Searching your knowledge…</div>}
      {!loading && error && !page.objects.length && <div className="object-list-state error">{error}</div>}
      {!loading && !error && !page.objects.length && <div className="object-list-state">
        {query.trim() ? "No matching objects" : filters.length ? "No objects match these filters" : "No active objects yet"}
      </div>}
      {!loading && page.objects.map((object, index) => <button
        type="button"
        className={`object-result${selectedId === object.object_id ? " selected" : ""}`}
        aria-current={selectedId === object.object_id ? "page" : undefined}
        key={object.object_id}
        ref={(element) => { itemRefs.current[index] = element; }}
        onClick={() => onSelect(object)}
        onKeyDown={(event) => moveFocus(event, index)}
      >
        <span className="object-result-icon"><ObjectIcon object={object} /></span>
        <span className="object-result-copy">
          <span className="object-result-title">{objectDisplayTitle(object)}</span>
          <span className="object-result-summary">{objectDisplaySummary(object)}</span>
          <span className="object-result-meta">
            <i>{objectKindLabel(object)}</i>
            {object.lifecycle !== "active" && <i>{object.lifecycle}</i>}
            <time dateTime={object.updated_at}>{new Intl.DateTimeFormat(undefined, {
              month: "short",
              day: "numeric",
            }).format(new Date(object.updated_at))}</time>
          </span>
        </span>
      </button>)}
      {page.has_more && <div
        ref={infiniteLoaderRef}
        className="object-infinite-loader"
        role="status"
      >{loadingMore ? "Loading more…" : null}</div>}
    </div>
    {error && page.objects.length > 0 && <p className="object-inline-error error">{error}</p>}
  </section>;
}
