import type {
  DashboardObjectNeighborhood,
  DashboardObjectSummary,
} from "@context-use/shared";
import { useEffect, useState } from "react";
import { api } from "../api.ts";
import { objectDisplaySummary, objectDisplayTitle } from "./ObjectNavigator.tsx";

function NeighborButton({
  object,
  relation,
  onOpen,
}: {
  object: DashboardObjectSummary;
  relation: "outbound" | "backlink";
  onOpen: (object: DashboardObjectSummary) => void;
}) {
  return <button type="button" onClick={() => onOpen(object)}>
    <span>{objectDisplayTitle(object)}</span>
    <small>{objectDisplaySummary(object)}</small>
    <i aria-hidden="true">{relation === "outbound" ? "→" : "←"}</i>
  </button>;
}

export function ObjectNeighborhood({
  objectId,
  onOpen,
}: {
  objectId: string;
  onOpen: (object: DashboardObjectSummary) => void;
}) {
  const [neighborhood, setNeighborhood] = useState<DashboardObjectNeighborhood | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    setNeighborhood(null);
    setError("");
    api<DashboardObjectNeighborhood>(
      `/api/dashboard/objects/${objectId}/neighborhood?limit=100`,
      { signal: controller.signal },
    ).then(setNeighborhood).catch((caught: unknown) => {
      if (caught instanceof DOMException && caught.name === "AbortError") return;
      setError(caught instanceof Error ? caught.message : "Could not load object links");
    });
    return () => controller.abort();
  }, [objectId]);

  if (error) return <aside className="object-neighborhood compact error" role="status">{error}</aside>;
  if (!neighborhood) return <aside className="object-neighborhood compact" role="status">Loading links…</aside>;

  const outbound = neighborhood.outbound.neighbors
    .filter((neighbor): neighbor is typeof neighbor & { object: DashboardObjectSummary } => (
      neighbor.resolved && neighbor.object !== null
    ));
  const unresolved = neighborhood.outbound.neighbors.length - outbound.length;
  const backlinks = neighborhood.backlinks.objects;
  if (!outbound.length && !backlinks.length && !unresolved && neighborhood.outbound.index_complete) {
    return <aside className="object-neighborhood compact">This page does not link to any objects and has no backlinks yet.</aside>;
  }

  return <aside className="object-neighborhood" aria-label="Object connections">
    {(outbound.length > 0 || unresolved > 0) && <section>
      <header><h2>Links from this page</h2><span>{neighborhood.outbound.neighbors.length}{neighborhood.outbound.has_more ? "+" : ""}</span></header>
      {outbound.length > 0 && <div>{outbound.map((neighbor) => <NeighborButton
        key={neighbor.target_object_id}
        object={neighbor.object}
        relation="outbound"
        onOpen={onOpen}
      />)}</div>}
      {unresolved > 0 && <p>{unresolved} linked object{unresolved === 1 ? " is" : "s are"} unavailable.</p>}
      {neighborhood.outbound.has_more && <p>More outgoing links are available from this page.</p>}
    </section>}
    {backlinks.length > 0 && <section>
      <header><h2>Referenced by</h2><span>{backlinks.length}{neighborhood.backlinks.has_more ? "+" : ""}</span></header>
      <div>{backlinks.map((object) => <NeighborButton
        key={object.object_id}
        object={object}
        relation="backlink"
        onOpen={onOpen}
      />)}</div>
      {neighborhood.backlinks.has_more && <p>More backlinks are available for this object.</p>}
    </section>}
    {!neighborhood.outbound.index_complete && <p className="object-index-state">
      Links for this revision are still being indexed.
    </p>}
  </aside>;
}
