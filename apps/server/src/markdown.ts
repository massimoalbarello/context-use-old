import { randomUUID } from "node:crypto";
import { extractObjectLinks, normalizeLegacyObjectLinks } from "@context-use/database";
import { marked, type Token } from "marked";
import sanitizeHtml from "sanitize-html";
import { config } from "./config.ts";

export type AssetResolution = { available: true; href: string; contentType: string } | { available: false };
export type ObjectResolution =
  | { available: true; representation: "page" | "record"; href: string }
  | { available: true; representation: "asset"; href: string; contentType: string }
  | { available: false };
export type MarkdownResolvers = {
  object: (id: string) => Promise<ObjectResolution>;
  publicAssetPath?: (path: string) => Promise<AssetResolution>;
};

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function headingText(tokens: Token[]): string {
  return tokens.map((token) => {
    if (token.type === "image") return token.text;
    if ("tokens" in token && Array.isArray(token.tokens)) return headingText(token.tokens);
    return "text" in token && typeof token.text === "string" ? token.text : "";
  }).join("");
}

function headingSlugBase(value: string): string {
  const slug = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s_-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return slug || "section";
}

function appendFragment(href: string, fragment: string | undefined): string {
  return fragment ? `${href}#${fragment.toLowerCase()}` : href;
}

const appOrigin = new URL(config.APP_ORIGIN).origin;

function isExternalLink(href: string): boolean {
  if (/^mailto:/i.test(href)) return true;
  try {
    const url = new URL(href, config.APP_ORIGIN);
    return (url.protocol === "http:" || url.protocol === "https:") && url.origin !== appOrigin;
  } catch {
    return false;
  }
}

type AssetFormatting = {
  size: "small" | "medium" | "large" | "full";
  align: "left" | "center" | "right";
  shape: "auto" | "square" | "portrait" | "landscape";
  layout: "block" | "half" | "third";
};

const ASSET_FORMAT_VALUES = {
  size: new Set<AssetFormatting["size"]>(["small", "medium", "large", "full"]),
  align: new Set<AssetFormatting["align"]>(["left", "center", "right"]),
  shape: new Set<AssetFormatting["shape"]>(["auto", "square", "portrait", "landscape"]),
  layout: new Set<AssetFormatting["layout"]>(["block", "half", "third"]),
};

function parseAssetFormatting(raw: string): AssetFormatting | null {
  const formatting: AssetFormatting = { size: "medium", align: "center", shape: "auto", layout: "block" };
  const seen = new Set<string>();
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return null;
  for (const token of tokens) {
    const match = /^([a-z]+)=([a-z]+)$/.exec(token);
    if (!match) return null;
    const [, key, value] = match;
    if (!key || !value || seen.has(key) || !(key in ASSET_FORMAT_VALUES)) return null;
    const allowed = ASSET_FORMAT_VALUES[key as keyof typeof ASSET_FORMAT_VALUES] as ReadonlySet<string>;
    if (!allowed.has(value)) return null;
    seen.add(key);
    (formatting as unknown as Record<string, string>)[key] = value;
  }
  return formatting;
}

function formattedAssetHtml(
  label: string,
  href: string,
  formatting: AssetFormatting,
  kind: "image" | "video",
): string {
  const classes = [
    "cu-image",
    `cu-image--size-${formatting.size}`,
    `cu-image--align-${formatting.align}`,
    `cu-image--shape-${formatting.shape}`,
    `cu-image--layout-${formatting.layout}`,
  ].join(" ");
  const media = kind === "image"
    ? `<img src="${escapeHtml(href)}" alt="${escapeHtml(label)}" loading="lazy">`
    : videoHtml(label, href);
  return `<span class="${classes}">${media}</span>`;
}

type AssetRenderKind = "image" | "video" | "link";

function assetRenderKind(contentType: string): AssetRenderKind {
  const normalized = contentType.split(";", 1)[0]!.trim().toLowerCase();
  if (/^image\/(?:png|jpeg|gif|webp|avif)$/.test(normalized)) return "image";
  if (/^video\/(?:mp4|webm|quicktime)$/.test(normalized)) return "video";
  return "link";
}

function isAllowedAssetSource(src: string): boolean {
  if (!src) return false;
  try {
    const url = new URL(src, config.APP_ORIGIN);
    const appOrigin = new URL(config.APP_ORIGIN).origin;
    const assetOrigin = new URL(config.ASSET_ORIGIN).origin;
    if (/^\/api\/dashboard\/assets\/[0-9a-f-]{36}\/content$/i.test(url.pathname)) {
      return url.origin === appOrigin;
    }
    if (/^\/a\/[a-z0-9][a-z0-9\/_-]*$/i.test(url.pathname)) {
      return url.origin === assetOrigin;
    }
    return false;
  } catch {
    return false;
  }
}

function videoHtml(label: string, href: string): string {
  const accessibleLabel = label.trim() || "Embedded video";
  return `<video src="${escapeHtml(href)}" controls preload="metadata" aria-label="${escapeHtml(accessibleLabel)}">${escapeHtml(accessibleLabel)}</video>`;
}

function renderAssetReference(
  label: string,
  target: AssetResolution | undefined,
  rawFormatting: string | undefined,
  formattedAssets: Map<string, string>,
): string {
  if (!target?.available) return `<span class="private-reference">Private asset unavailable</span>`;
  const kind = assetRenderKind(target.contentType);
  if (kind === "image" || kind === "video") {
    const plainMedia = kind === "image" ? `![${label}](${target.href})` : videoHtml(label, target.href);
    if (rawFormatting === undefined) return plainMedia;
    const formatting = parseAssetFormatting(rawFormatting);
    if (!formatting) return `${plainMedia}{${rawFormatting}}`;
    if (!isAllowedAssetSource(target.href)) return `<span class="private-reference">Private asset unavailable</span>`;
    const placeholder = `CUMEDIA${randomUUID().replaceAll("-", "")}${formattedAssets.size}`;
    formattedAssets.set(placeholder, formattedAssetHtml(label, target.href, formatting, kind));
    return placeholder;
  }
  const linkLabel = label.trim() || (target.contentType.toLowerCase() === "application/pdf" ? "Open PDF" : "Open asset");
  return `<a href="${escapeHtml(target.href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(linkLabel)}</a>`;
}

function renderAssetLink(label: string, target: Extract<ObjectResolution, { available: true; representation: "asset" }>): string {
  const linkLabel = label.trim()
    || (target.contentType.toLowerCase() === "application/pdf" ? "Open PDF" : "Open asset");
  return `<a href="${escapeHtml(target.href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(linkLabel)}</a>`;
}

export async function renderMarkdown(markdown: string, resolvers: MarkdownResolvers): Promise<string> {
  // Immutable revisions can predate the canonical object scheme. Resolve
  // their recognized links through the same visibility-aware object boundary.
  const normalizedMarkdown = normalizeLegacyObjectLinks(markdown);
  const objects = new Map<string, ObjectResolution>();
  const publicAssets = new Map<string, AssetResolution>();
  const formattedAssets = new Map<string, string>();
  await Promise.all(extractObjectLinks(normalizedMarkdown).map(async (id) => (
    objects.set(id, await resolvers.object(id))
  )));
  const publicAssetPaths = [...normalizedMarkdown.matchAll(
    /context-use:\/\/public-asset\/([a-z0-9][a-z0-9/_-]*)/gi,
  )].map((match) => match[1]!.toLowerCase());
  await Promise.all([...new Set(publicAssetPaths)].map(async (path) => publicAssets.set(
    path,
    await (resolvers.publicAssetPath?.(path) ?? Promise.resolve({ available: false as const })),
  )));

  let source = normalizedMarkdown.replace(
    /!\[([^\]\n]*)\]\(context-use:\/\/object\/([0-9a-f-]{36})(?:#[a-z0-9][a-z0-9_-]*)?\)(?:\{([^}\n]+)\})?/gi,
    (_match, label: string, id: string, rawFormatting: string | undefined) => {
      const target = objects.get(id.toLowerCase());
      return target?.available && target.representation === "asset"
        ? renderAssetReference(label, target, rawFormatting, formattedAssets)
        : `<span class="private-reference">Private asset unavailable</span>`;
    },
  );
  source = source.replace(
    /(?<!!)\[([^\]\n]*)\]\(context-use:\/\/object\/([0-9a-f-]{36})(?:#([a-z0-9][a-z0-9_-]*))?\)/gi,
    (_match, label: string, id: string, fragment: string | undefined) => {
      const target = objects.get(id.toLowerCase());
      if (!target?.available) {
        return `<span class="private-reference">${escapeHtml(label || "Private object")}</span>`;
      }
      return target.representation === "asset"
        ? renderAssetLink(label, target)
        : `[${label}](${appendFragment(target.href, fragment)})`;
    },
  );
  source = source.replace(
    /!\[([^\]\n]*)\]\(context-use:\/\/public-asset\/([a-z0-9][a-z0-9/_-]*)\)(?:\{([^}\n]+)\})?/gi,
    (_match, label: string, path: string, rawFormatting: string | undefined) => renderAssetReference(
      label,
      publicAssets.get(path.toLowerCase()),
      rawFormatting,
      formattedAssets,
    ),
  );
  source = source.replace(
    /(?<!!)\[([^\]\n]*)\]\(context-use:\/\/public-asset\/([a-z0-9][a-z0-9/_-]*)\)/gi,
    (_match, label: string, path: string) => {
      const target = publicAssets.get(path.toLowerCase());
      return target?.available
        ? renderAssetLink(label, { ...target, representation: "asset" })
        : `<span class="private-reference">${escapeHtml(label || "Private asset")}</span>`;
    },
  );
  // Historical source remains immutable, but obsolete private identities are
  // inert. Canonical routes produced by successful object resolvers remain.
  source = source.replace(
    /context-use:\/\/(?:page|directory|asset)\/[0-9a-f-]{36}|\/app\/(?:pages|directories)\/[0-9a-f-]{36}/gi,
    '<span class="private-reference">Private reference</span>',
  );

  const headingCounts = new Map<string, number>();
  const renderer = new marked.Renderer();
  renderer.heading = function ({ tokens, depth }) {
    const base = headingSlugBase(headingText(tokens));
    const count = (headingCounts.get(base) ?? 0) + 1;
    headingCounts.set(base, count);
    const id = count === 1 ? base : `${base}-${count}`;
    return `<h${depth} id="${id}">${this.parser.parseInline(tokens)}</h${depth}>`;
  };
  const unsafe = await marked.parse(source, { gfm: true, breaks: false, async: true, renderer });
  const sanitized = sanitizeHtml(unsafe, {
    allowedTags: [
      "p", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote",
      "ul", "ol", "li", "strong", "em", "del", "code", "pre", "a", "span",
      "table", "thead", "tbody", "tr", "th", "td", "img", "video", "audio", "source",
    ],
    allowedAttributes: {
      a: ["href", "rel", "target", "class", "title"],
      h1: ["id"],
      h2: ["id"],
      h3: ["id"],
      h4: ["id"],
      h5: ["id"],
      h6: ["id"],
      span: ["class"],
      code: ["class"],
      img: ["src", "alt", "title", "loading"],
      video: ["src", "controls", "preload", "aria-label", "playsinline"],
      audio: ["src", "controls", "preload", "aria-label"],
      source: ["src", "type"],
      th: ["align"],
      td: ["align"],
    },
    allowedClasses: { a: ["external-link"], span: ["private-reference"] },
    allowedSchemes: ["http", "https", "mailto"],
    transformTags: {
      a: (_tag, attributes) => {
        const { class: _authoredClass, ...safeAttributes } = attributes;
        const external = isExternalLink(attributes.href ?? "");
        return {
          tagName: "a",
          attribs: external
            ? {
                ...safeAttributes,
                class: "external-link",
                rel: "noopener noreferrer",
                target: "_blank",
                title: "External link (opens in a new tab)",
              }
            : safeAttributes,
        };
      },
      img: (_tag, attributes) => ({
        tagName: "img",
        attribs: { ...attributes, loading: "lazy" },
      }),
      video: (_tag, attributes) => ({
        tagName: "video",
        attribs: { ...attributes, controls: "", preload: "metadata" },
      }),
      audio: (_tag, attributes) => ({
        tagName: "audio",
        attribs: { ...attributes, controls: "", preload: "metadata" },
      }),
    },
    exclusiveFilter: (frame) => {
      if (!(["img", "video", "audio", "source"] as string[]).includes(frame.tag)) return false;
      const src = frame.attribs.src ?? "";
      if (!src && (frame.tag === "video" || frame.tag === "audio")) return false;
      return !isAllowedAssetSource(src);
    },
  });
  return [...formattedAssets].reduce(
    (html, [placeholder, asset]) => html.replaceAll(placeholder, asset),
    sanitized,
  );
}

export function publicationWarnings(markdown: string, metadata: string[] = []): string[] {
  const warnings: string[] = [];
  const publicText = [...metadata, markdown].join("\n");
  const externalUrls = publicText.match(/https?:\/\/[^\s)>]+/g) ?? [];
  if (externalUrls.length) warnings.push(`${externalUrls.length} external URL(s) will become public`);
  if (/(?:BEGIN (?:RSA |EC )?PRIVATE KEY|api[_-]?key\s*[:=]|secret\s*[:=]|bearer\s+[a-z0-9._-]{16,})/i.test(publicText)) {
    warnings.push("Possible secret material detected; review the page carefully");
  }
  const privateReferences = extractObjectLinks(normalizeLegacyObjectLinks(markdown)).length;
  if (privateReferences) warnings.push(`${privateReferences} context-use reference(s) have independent visibility`);
  return warnings;
}
