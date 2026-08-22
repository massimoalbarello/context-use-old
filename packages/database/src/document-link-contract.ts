import { decodeHTML } from "entities";
import { parseDocument } from "htmlparser2";
import { lexer, type Token, type Tokens } from "marked";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const GENERIC_DOCUMENT_DESTINATION = new RegExp(
  `^context-use://document/(${UUID})(?:#[a-z0-9][a-z0-9_-]*)?$`,
  "i",
);
const PRIVATE_ROUTE_WITH_ID = new RegExp(
  `/(?:app|api)/[^\\s<>()\\[\\]"']*${UUID}`,
  "i",
);
const WIKI_REFERENCE = /!?\[\[[^\]\n]+\]\]/;
const INTERNAL_URI = /context-use:\/\//i;
const MAX_BODY_BYTES = 4_000_000;
const MAX_REFERENCE_DEFINITIONS = 512;
const MAX_STRUCTURAL_MARKERS = 50_000;
const MAX_CONTAINER_DEPTH = 256;
const MAX_CONTAINER_MARKERS = 4_096;
const MAX_FORMATTING_DELIMITERS = 100_000;
const MAX_HTML_NODES = 10_000;
const MAX_HTML_DEPTH = 256;

export class GenericDocumentLinkContractError extends Error {
  constructor() {
    super("Authored knowledge may use only context-use://document/<uuid> internal links");
    this.name = "GenericDocumentLinkContractError";
  }
}

function decodePercentEncodings(value: string): string {
  let decoded = value;
  for (let pass = 0; pass < 3; pass += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) return decoded;
      decoded = next;
    } catch {
      return decoded;
    }
  }
  return decoded;
}

function normalizeDestination(value: string): string {
  let normalized = decodePercentEncodings(decodeHTML(value)).replaceAll("\\", "/");
  normalized = normalized.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (/^context-use:/i.test(normalized)) return normalized;
  try {
    const parsed = new URL(normalized, "https://private.invalid/");
    if (parsed.origin === "https://private.invalid") return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    // The renderer will leave a malformed ordinary web destination inert.
  }
  return normalized;
}

function genericTarget(destination: string): string | null {
  return GENERIC_DOCUMENT_DESTINATION.exec(normalizeDestination(destination))?.[1]?.toLowerCase() ?? null;
}

function invalidInternalDestination(destination: string): boolean {
  const decoded = decodePercentEncodings(decodeHTML(destination))
    .replaceAll("\\", "/")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim();
  if (decoded === "" || decoded.startsWith("#")) return false;
  const normalized = normalizeDestination(destination);
  if (INTERNAL_URI.test(normalized) || /^context-use:/i.test(normalized)) return true;
  if (PRIVATE_ROUTE_WITH_ID.test(normalized)) return true;
  if (/^(?:https?:|mailto:|tel:|\/\/)/i.test(normalized)) return false;
  if (normalized === "/") return false;
  if (/^\/(?:p\/[a-z0-9_-]+(?:\.md)?|a\/[a-z0-9_-]+)(?:[?#][^\s]*)?$/i.test(normalized)
      && !invalidRenderedProse(normalized)) return false;
  return true;
}

function invalidRenderedProse(value: string): boolean {
  const normalized = decodePercentEncodings(decodeHTML(value))
    .replaceAll("\\", "/")
    .replace(/[\u0000-\u001f\u007f]/g, "");
  const withoutExternalWebUrls = normalized.replace(/https?:\/\/[^\s<>()\[\]"']+/gi, "");
  return INTERNAL_URI.test(withoutExternalWebUrls)
    || PRIVATE_ROUTE_WITH_ID.test(withoutExternalWebUrls)
    || WIKI_REFERENCE.test(normalized);
}

type HtmlNode = {
  type: string;
  name?: string;
  data?: string;
  attribs?: Record<string, string>;
  children?: HtmlNode[];
};

function scanHtml(html: string): boolean {
  const roots = parseDocument(html, { decodeEntities: true }).children as HtmlNode[];
  const pending = roots.slice().reverse().map((node) => ({ node, inertText: false, depth: 1 }));
  let visited = 0;
  while (pending.length) {
    const { node, inertText, depth } = pending.pop()!;
    visited += 1;
    if (visited > MAX_HTML_NODES || depth > MAX_HTML_DEPTH) return true;
    if (node.type === "comment") continue;
    const name = node.name?.toLowerCase();
    if (node.attribs) {
      for (const [attribute, value] of Object.entries(node.attribs)) {
        const normalizedAttribute = attribute.toLowerCase();
        if ((normalizedAttribute === "href" || normalizedAttribute === "src")
            && invalidInternalDestination(value)) return true;
        if ((normalizedAttribute === "alt" || normalizedAttribute === "title"
            || normalizedAttribute === "aria-label")
            && invalidRenderedProse(value)) return true;
      }
    }
    if (name === "script" || name === "style" || name === "textarea") continue;
    const childTextIsInert = inertText || name === "code" || name === "pre";
    if (node.type === "text" && !childTextIsInert
        && invalidRenderedProse(node.data ?? "")) return true;
    if (node.children) {
      for (let index = node.children.length - 1; index >= 0; index -= 1) {
        pending.push({ node: node.children[index]!, inertText: childTextIsInert, depth: depth + 1 });
      }
    }
  }
  return false;
}

function escapedExample(previous: Token | undefined, token: Tokens.Text): boolean {
  if (previous?.type !== "escape" || (previous as Tokens.Escape).text !== "[") return false;
  const rendered = `[${token.text}`;
  return /^\[[^\]\n]*\]\([^\n]*\)(?:\{[^}\n]*\})?$/u.test(rendered)
    || /^\[\[[^\]\n]+\]\]$/u.test(rendered);
}

type ParsedContract = { invalid: boolean; targets: string[] };

function parseContract(markdown: string): ParsedContract {
  // marked can spend quadratic time resolving a very large definition table.
  // Bound parser structure before lexing; the persisted body limit alone does
  // not protect this synchronous validation boundary.
  if (Buffer.byteLength(markdown, "utf8") > MAX_BODY_BYTES) {
    return { invalid: true, targets: [] };
  }
  // Count conservatively in one allocation-free pass instead of attempting
  // to duplicate CommonMark's escaped/multiline/container definition grammar.
  let definitionCandidateCount = 0;
  let structuralMarkerCount = 0;
  let lineContainerDepth = 0;
  let containerMarkerCount = 0;
  let formattingDelimiterCount = 0;
  for (let index = 0; index < markdown.length; index += 1) {
    const character = markdown[index];
    if (character === "\n" || character === "\r") lineContainerDepth = 0;
    if (character === "]" && markdown[index + 1] === ":") {
      definitionCandidateCount += 1;
      if (definitionCandidateCount > MAX_REFERENCE_DEFINITIONS) {
        return { invalid: true, targets: [] };
      }
    }
    if (character === ">") {
      lineContainerDepth += 1;
      containerMarkerCount += 1;
      if (lineContainerDepth > MAX_CONTAINER_DEPTH
          || containerMarkerCount > MAX_CONTAINER_MARKERS) {
        return { invalid: true, targets: [] };
      }
    }
    const nextIsWhitespace = markdown[index + 1] === " " || markdown[index + 1] === "\t";
    let listContainerCandidate = (character === "-" || character === "+" || character === "*")
      && nextIsWhitespace;
    if (!listContainerCandidate && character !== undefined && /[0-9]/u.test(character)
        && (index === 0 || !/[0-9]/u.test(markdown[index - 1]!))) {
      let end = index + 1;
      while (end < markdown.length && end - index < 10 && /[0-9]/u.test(markdown[end]!)) {
        end += 1;
      }
      listContainerCandidate = end - index <= 9
        && (markdown[end] === "." || markdown[end] === ")")
        && (markdown[end + 1] === " " || markdown[end + 1] === "\t");
    }
    if (listContainerCandidate) {
      lineContainerDepth += 1;
      containerMarkerCount += 1;
      if (lineContainerDepth > MAX_CONTAINER_DEPTH
          || containerMarkerCount > MAX_CONTAINER_MARKERS) {
        return { invalid: true, targets: [] };
      }
    }
    if (character === "[" || character === "]" || character === "("
        || character === ")" || character === "<") {
      structuralMarkerCount += 1;
      if (structuralMarkerCount > MAX_STRUCTURAL_MARKERS) {
        return { invalid: true, targets: [] };
      }
    }
    if (character === "*" || character === "_" || character === "~"
        || character === "`") {
      formattingDelimiterCount += 1;
      if (formattingDelimiterCount > MAX_FORMATTING_DELIMITERS) {
        return { invalid: true, targets: [] };
      }
    }
  }
  let tokens: Token[];
  try {
    tokens = lexer(markdown, { async: false });
  } catch {
    return { invalid: true, targets: [] };
  }
  const targets = new Set<string>();
  let invalid = false;

  const visit = (items: Token[]): void => {
    for (let index = 0; index < items.length; index += 1) {
      const token = items[index]!;
      if (token.type === "code" || token.type === "codespan"
          || token.type === "escape" || token.type === "def") continue;
      if (token.type === "link" || token.type === "image") {
        const link = token as Tokens.Link | Tokens.Image;
        const target = genericTarget(link.href);
        if (target) targets.add(target);
        else if (invalidInternalDestination(link.href)) invalid = true;
        if (/^!?\[\[/u.test(link.raw) || invalidRenderedProse(link.text)
            || (link.title !== null && link.title !== undefined
              && invalidRenderedProse(link.title))) invalid = true;
        continue;
      }
      if (token.type === "html") {
        if (scanHtml((token as Tokens.HTML | Tokens.Tag).text)) invalid = true;
        continue;
      }
      if (token.type === "text") {
        const text = token as Tokens.Text;
        if (text.tokens) visit(text.tokens);
        else if (!escapedExample(items[index - 1], text)
          && invalidRenderedProse(text.text)) invalid = true;
        continue;
      }
      if (token.type === "list") {
        for (const item of (token as Tokens.List).items) visit(item.tokens);
        continue;
      }
      if (token.type === "table") {
        const table = token as Tokens.Table;
        for (const cell of [...table.header, ...table.rows.flat()]) visit(cell.tokens);
        continue;
      }
      const nested = (token as Token & { tokens?: Token[] }).tokens;
      if (nested) visit(nested);
    }
  };
  try {
    visit(tokens);
  } catch {
    return { invalid: true, targets: [] };
  }

  return { invalid, targets: [...targets].sort() };
}

/**
 * Validate the rendered authored surface with the same CommonMark parser used
 * by the application. Code, comments and escaped examples remain inert; every
 * rendered internal link must use generic document identity.
 */
export function assertGenericDocumentLinksOnly(markdown: string): void {
  if (parseContract(markdown).invalid) throw new GenericDocumentLinkContractError();
}

export function genericDocumentTargets(markdown: string): string[] {
  const parsed = parseContract(markdown);
  if (parsed.invalid) throw new GenericDocumentLinkContractError();
  return parsed.targets;
}
