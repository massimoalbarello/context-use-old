import type { PublicPageContent } from "./public-content.ts";
import { INTRO_PATH, publicSiteName } from "./public-discovery.ts";

const PRIVATE_UUID = "[private identifier]";

type PublicLlmsOptions = {
  siteOrigin: string;
  assetOrigin: string;
  entrypointPublicPath?: string | null;
};

function normalizedOrigin(value: string): string {
  return new URL(value).origin;
}

function normalizedInlineText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function escapedLinkLabel(value: string): string {
  return normalizedInlineText(value)
    .replaceAll("\\", "\\\\")
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]");
}

function normalizedMarkdown(value: string): string {
  return value.replace(/\r\n?/g, "\n").trim();
}

function publicPageUrl(origin: string, path: string): string {
  return `${origin}/p/${path}`;
}

function publicMarkdownPageUrl(origin: string, path: string): string {
  return `${publicPageUrl(origin, path)}.md`;
}

function entrypointFirst(left: PublicPageContent, right: PublicPageContent, entrypoint: string | null | undefined): number {
  if (left.public_id === entrypoint && right.public_id !== entrypoint) return -1;
  if (right.public_id === entrypoint && left.public_id !== entrypoint) return 1;
  return left.public_id < right.public_id ? -1 : left.public_id > right.public_id ? 1 : 0;
}

function orderedPages(pages: PublicPageContent[], entrypoint?: string | null): PublicPageContent[] {
  return [...pages].sort((left, right) => entrypointFirst(left, right, entrypoint));
}

function descriptionFor(pages: PublicPageContent[], entrypoint?: string | null): string {
  const introduction = pages.find(({ public_id }) => public_id === entrypoint);
  return normalizedInlineText(introduction?.summary ?? "")
    || "Only explicitly published knowledge is included.";
}

function dateIso(value: string | Date): string | null {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function latestEdit(pages: PublicPageContent[]): string | null {
  return pages.reduce<string | null>((latest, page) => {
    const edited = dateIso(page.last_edited_at);
    return edited !== null && (latest === null || edited > latest) ? edited : latest;
  }, null);
}

function redactPrivateReferences(markdown: string): string {
  return markdown
    .replace(
      /context-use:\/\/(?:page|directory|asset)\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
      "[private reference]",
    )
    .replace(
      /\/app\/(?:pages|directories)\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
      "[private reference]",
    )
    .replace(
      /\/api\/(?:dashboard|mcp|public)\/assets\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:\/(?:content|status))?/gi,
      "[private asset reference]",
    )
    .replace(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
      PRIVATE_UUID,
    );
}

function absolutePublicMarkdown(
  markdown: string,
  siteOrigin: string,
  assetOrigin: string,
): string {
  let result = normalizedMarkdown(markdown).replace(
    /context-use:\/\/public-asset\/([a-z0-9][a-z0-9/_-]*)/gi,
    (_match, path: string) => `${assetOrigin}/a/${path.toLowerCase()}`,
  );
  result = result.replace(
    /(\]\()\/((?:p|i)(?:\/[a-z0-9][a-z0-9/_-]*)?(?:#[a-z0-9][a-z0-9_-]*)?)(\))/gi,
    (_match, prefix: string, path: string, suffix: string) => `${prefix}${siteOrigin}/${path}${suffix}`,
  );
  return redactPrivateReferences(result);
}

export function renderLlmsTxt(pages: PublicPageContent[], options: PublicLlmsOptions): string {
  const siteOrigin = normalizedOrigin(options.siteOrigin);
  const entrypoint = options.entrypointPublicPath === undefined ? INTRO_PATH : options.entrypointPublicPath;
  const ordered = orderedPages(pages, entrypoint);
  const introduction = ordered.find(({ public_id }) => public_id === entrypoint);
  const lines = [
    `# ${publicSiteName(siteOrigin, introduction)}`,
    "",
    `> ${descriptionFor(ordered, entrypoint)}`,
    "",
    "Only explicitly published knowledge is included.",
    "",
    "## Discovery",
    "",
    `- [Public entrypoint](${siteOrigin}/p/): Open the configured starting page.`,
    `- [XML sitemap](${siteOrigin}/sitemap.xml): Canonical HTML URLs for every published page.`,
    "",
    "## Complete public context",
    "",
    `- [Full public context](${siteOrigin}/llms-full.txt): Complete text of every published page.`,
  ];
  if (ordered.length) {
    lines.push("", "## Public pages", "");
    for (const page of ordered) {
      lines.push(
        `- [${escapedLinkLabel(page.title)}](${publicMarkdownPageUrl(siteOrigin, page.public_id)}): ${normalizedInlineText(page.summary)}`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

export function renderPublicPageMarkdown(page: PublicPageContent, options: PublicLlmsOptions): string {
  const siteOrigin = normalizedOrigin(options.siteOrigin);
  const assetOrigin = normalizedOrigin(options.assetOrigin);
  const canonicalUrl = publicPageUrl(siteOrigin, page.public_id);
  const lines = [
    `# ${normalizedInlineText(page.title)}`,
    "",
    `> ${normalizedInlineText(page.summary)}`,
    "",
    `- Canonical URL: [${canonicalUrl}](${canonicalUrl})`,
    `- Site index: [${siteOrigin}/llms.txt](${siteOrigin}/llms.txt)`,
    `- Public entrypoint: [${siteOrigin}/p/](${siteOrigin}/p/)`,
  ];
  const edited = dateIso(page.last_edited_at);
  if (edited !== null) lines.push(`- Last edited: ${edited}`);
  const body = absolutePublicMarkdown(page.body_markdown, siteOrigin, assetOrigin);
  if (body) lines.push("", body);
  return `${lines.join("\n")}\n`;
}

export function renderLlmsFullTxt(pages: PublicPageContent[], options: PublicLlmsOptions): string {
  const siteOrigin = normalizedOrigin(options.siteOrigin);
  const assetOrigin = normalizedOrigin(options.assetOrigin);
  const entrypoint = options.entrypointPublicPath === undefined ? INTRO_PATH : options.entrypointPublicPath;
  const ordered = orderedPages(pages, entrypoint);
  const introduction = ordered.find(({ public_id }) => public_id === entrypoint);
  const lines = [
    `# ${publicSiteName(siteOrigin, introduction)} — full public context`,
    "",
    `> ${descriptionFor(ordered, entrypoint)}`,
    "",
    "This index contains every explicitly published page.",
    "",
    `- Concise index: [${siteOrigin}/llms.txt](${siteOrigin}/llms.txt)`,
    `- Public entrypoint: [${siteOrigin}/p/](${siteOrigin}/p/)`,
    `- Published pages: ${ordered.length}`,
  ];
  const lastEdited = latestEdit(ordered);
  if (lastEdited !== null) lines.push(`- Last updated: ${lastEdited}`);

  for (const page of ordered) {
    const canonicalUrl = publicPageUrl(siteOrigin, page.public_id);
    lines.push(
      "",
      "---",
      "",
      `## ${normalizedInlineText(page.title)}`,
      "",
      `- Canonical URL: [${canonicalUrl}](${canonicalUrl})`,
      `- Public ID: \`${page.public_id}\``,
      `- Summary: ${normalizedInlineText(page.summary)}`,
    );
    const edited = dateIso(page.last_edited_at);
    if (edited !== null) lines.push(`- Last edited: ${edited}`);
    const body = absolutePublicMarkdown(page.body_markdown, siteOrigin, assetOrigin);
    if (body) lines.push("", body);
  }

  return `${lines.join("\n")}\n`;
}
