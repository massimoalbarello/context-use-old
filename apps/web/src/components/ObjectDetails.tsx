import type { DashboardObjectSummary } from "@context-use/shared";
import { objectDisplaySummary, objectDisplayTitle } from "./ObjectNavigator.tsx";

function kindLabel(object: DashboardObjectSummary): string {
  if (object.object_kind === "record") return "Connected source record";
  if (object.object_kind === "asset") return "Asset";
  return "Page";
}

export function ObjectDetails({ object }: { object: DashboardObjectSummary }) {
  return <main className="content-page catalog-object-details">
    <header>
      <div>
        <span className="object-kicker">{kindLabel(object)}</span>
        <h1>{objectDisplayTitle(object)}</h1>
        <p className="knowledge-summary">{objectDisplaySummary(object)}</p>
      </div>
      <span className="status">{object.lifecycle}</span>
    </header>
    <section className="catalog-object-card">
      <dl>
        <div><dt>Representation</dt><dd>{object.representation}</dd></div>
        {object.content_type && <div><dt>Type</dt><dd>{object.content_type}</dd></div>}
        <div><dt>Last updated</dt><dd>{new Intl.DateTimeFormat(undefined, {
          dateStyle: "medium",
          timeStyle: "short",
        }).format(new Date(object.updated_at))}</dd></div>
      </dl>
      <div className="asset-reference">
        <span>Private reference</span>
        <code>context-use://object/{object.object_id}</code>
      </div>
      {object.object_kind === "record" && <p>
        This record is managed by its connected source. Follow links from authored knowledge to
        use it as context.
      </p>}
      {object.lifecycle !== "active" && <p>
        This retained identity is not part of active knowledge.
      </p>}
    </section>
  </main>;
}
