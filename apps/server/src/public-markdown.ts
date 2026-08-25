import type { PublicationProjectionTarget } from "@context-use/database";

const UUID_SOURCE = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const UUID_GLOBAL = new RegExp(UUID_SOURCE, "gi");

function routable(target: PublicationProjectionTarget | undefined) {
  return target
    && (target.outcome === "self" || target.outcome === "active_public")
    && target.public_id
    && target.public_target_kind
    ? { publicId: target.public_id, kind: target.public_target_kind }
    : null;
}

/**
 * Project private object links into canonical UUID public routes.
 * Every non-public target and every otherwise-visible UUID is redacted.
 */
export function projectPublicMarkdown(
  markdown: string,
  projection: PublicationProjectionTarget[],
): { bodyMarkdown: string; observedPublicIds: string[] } {
  const targets = new Map(projection.map((target) => [
    target.target_object_id.toLowerCase(),
    target,
  ]));
  const placeholders: string[] = [];
  const observed = new Set<string>();
  const routePlaceholder = (route: string, publicId: string) => {
    observed.add(publicId.toLowerCase());
    const index = placeholders.push(route) - 1;
    return `__CONTEXT_USE_PUBLIC_ROUTE_${index}__`;
  };

  let projected = markdown
    .replace(/<!--.*?-->/gis, "")
    .replace(/<!--.*$/gis, "")
    .replace(/<script(?:\s[^>]*)?>.*?<\/script\s*>/gis, "")
    .replace(/<script(?:\s[^>]*)?>.*$/gis, "")
    .replace(/<style(?:\s[^>]*)?>.*?<\/style\s*>/gis, "")
    .replace(/<style(?:\s[^>]*)?>.*$/gis, "")
    .replace(/<[a-z!?/][^>]*(?:>|$)/gis, "");

  projected = projected.replace(
    new RegExp(`!\\[([^\\]]*)\\]\\(context-use://object/(${UUID_SOURCE})(?:#[a-z0-9][a-z0-9_-]*)?\\)(\\{[^}\\r\\n]*\\})?`, "gi"),
    (_whole, label: string, objectId: string, attributes: string | undefined) => {
      const target = routable(targets.get(objectId.toLowerCase()));
      if (!target || target.kind !== "asset") return label;
      const route = routePlaceholder(`/a/${target.publicId}`, target.publicId);
      return `![${label}](${route})${attributes ?? ""}`;
    },
  );

  projected = projected.replace(
    new RegExp(`(?<!!)\\[([^\\]]*)\\]\\(context-use://object/(${UUID_SOURCE})(#[a-z0-9][a-z0-9_-]*)?\\)`, "gi"),
    (_whole, label: string, objectId: string, fragment: string | undefined) => {
      const target = routable(targets.get(objectId.toLowerCase()));
      if (!target) return label;
      const route = target.kind === "page"
        ? `/p/${target.publicId}${fragment ?? ""}`
        : `/a/${target.publicId}`;
      return `[${label}](${routePlaceholder(route, target.publicId)})`;
    },
  );

  projected = projected
    .replace(new RegExp(`context-use://(?:document|page|directory|asset)/${UUID_SOURCE}`, "gi"), "[private reference]")
    .replace(new RegExp(`/app/(?:documents|pages|directories)/${UUID_SOURCE}`, "gi"), "[private reference]")
    .replace(new RegExp(`/api/(?:dashboard|mcp|public)/assets/${UUID_SOURCE}(?:/(?:content|status))?`, "gi"), "[private asset reference]")
    .replace(UUID_GLOBAL, "[private identifier]")
    .replace(/__CONTEXT_USE_PUBLIC_ROUTE_(\d+)__/g, (_whole, rawIndex: string) => {
      const route = placeholders[Number(rawIndex)];
      if (!route) throw new Error("Public projection route placeholder is invalid");
      return route;
    });

  return {
    bodyMarkdown: projected,
    observedPublicIds: [...observed].sort(),
  };
}
