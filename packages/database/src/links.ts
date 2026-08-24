const UUID_PATTERN = "([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})";
const FRAGMENT_PATTERN = "(#[a-z0-9][a-z0-9_-]*)?";
const DOCUMENT_LINK = new RegExp(`(!?)\\[[^\\]\\n]*\\]\\(context-use:\\/\\/document\\/${UUID_PATTERN}${FRAGMENT_PATTERN}\\)`, "gi");

// Keep the application-side guard aligned with replace_document_links. Raw
// source persistence must not fail merely because its derived graph exceeds
// this bounded indexing contract.
export const MAX_DOCUMENT_LINKS_PER_REVISION = 100_000;

function escapedAt(value: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

type MarkdownRange = { start: number; end: number };

function containingRange(ranges: MarkdownRange[], index: number): MarkdownRange | undefined {
  let low = 0;
  let high = ranges.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (ranges[middle]!.end <= index) low = middle + 1;
    else high = middle;
  }
  const range = ranges[low];
  return range && range.start <= index ? range : undefined;
}

function inlineCodeRanges(value: string, excluded: MarkdownRange[] = []): MarkdownRange[] {
  const ranges: MarkdownRange[] = [];
  let cursor = 0;
  let excludedCursor = 0;
  while (cursor < value.length) {
    while (excluded[excludedCursor] && excluded[excludedCursor]!.end <= cursor) {
      excludedCursor += 1;
    }
    const nextExcluded = excluded[excludedCursor];
    if (nextExcluded && nextExcluded.start <= cursor) {
      cursor = nextExcluded.end;
      continue;
    }
    if (value[cursor] !== "`" || escapedAt(value, cursor)) {
      cursor += 1;
      continue;
    }
    let runEnd = cursor + 1;
    while (value[runEnd] === "`") runEnd += 1;
    const marker = value.slice(cursor, runEnd);
    let closing = value.indexOf(marker, runEnd);
    while (closing >= 0 && (
      value[closing - 1] === "`"
      || value[closing + marker.length] === "`"
    )) {
      closing = value.indexOf(marker, closing + marker.length);
    }
    // An inline code span cannot cross a block-level excluded region.
    if (closing >= 0 && nextExcluded && nextExcluded.start < closing + marker.length) closing = -1;
    if (closing < 0) {
      cursor = runEnd;
      continue;
    }
    const codeEnd = closing + marker.length;
    ranges.push({ start: cursor, end: codeEnd });
    cursor = codeEnd;
  }
  return ranges;
}

function htmlCommentRanges(value: string, excluded: MarkdownRange[] = []): MarkdownRange[] {
  const ranges: MarkdownRange[] = [];
  let cursor = 0;
  while (cursor < value.length) {
    const start = value.indexOf("<!--", cursor);
    if (start < 0) break;
    const excludedRange = containingRange(excluded, start);
    if (escapedAt(value, start) || excludedRange) {
      cursor = excludedRange?.end ?? start + 4;
      continue;
    }
    const closing = value.indexOf("-->", start + 4);
    const end = closing < 0 ? value.length : closing + 3;
    ranges.push({ start, end });
    cursor = end;
  }
  return ranges;
}

function escapedLinkRanges(value: string): MarkdownRange[] {
  const ranges: MarkdownRange[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== "[" || !escapedAt(value, index)) continue;
    const candidate = value.slice(index);
    const wiki = /^\[\[[^\]\n]*\]\]/.exec(candidate)?.[0];
    const markdown = /^\[[^\]\n]*\]\([^\)\n]*\)(?:\{[^}\r\n]*\})?/.exec(candidate)?.[0];
    const match = wiki ?? markdown;
    if (match) ranges.push({ start: index, end: index + match.length });
  }
  return ranges;
}

function stripBlockquotePrefix(line: string): { depth: number; logical: string } {
  let remainder = line;
  let depth = 0;
  while (true) {
    const marker = /^ {0,3}>[ \t]?/.exec(remainder)?.[0];
    if (!marker) return { depth, logical: remainder };
    remainder = remainder.slice(marker.length);
    depth += 1;
  }
}

function fenceOpening(line: string): {
  character: "`" | "~";
  length: number;
  quoteDepth: number;
  closingMaxIndent: number;
} | null {
  const { depth, logical } = stripBlockquotePrefix(line);
  const direct = /^( {0,3})(`{3,}|~{3,})/.exec(logical);
  const nestedList = /^( {0,3})(?:[-+*]|\d{1,9}[.)])([ \t]+)(`{3,}|~{3,})/.exec(logical);
  const marker = direct?.[2] ?? nestedList?.[3];
  if (!marker) return null;
  const listIndent = nestedList ? nestedList[0]!.indexOf(marker) : 0;
  return {
    character: marker[0] as "`" | "~",
    length: marker.length,
    quoteDepth: depth,
    closingMaxIndent: nestedList ? listIndent + 3 : 3,
  };
}

function fenceClosing(
  line: string,
  fence: NonNullable<ReturnType<typeof fenceOpening>>,
): boolean {
  const { depth, logical } = stripBlockquotePrefix(line);
  return depth === fence.quoteDepth
    && new RegExp(`^[ \\t]{0,${fence.closingMaxIndent}}\\${fence.character}{${fence.length},}[ \\t]*$`)
      .test(logical);
}

function htmlBlockOpening(line: string): {
  closesWith: RegExp | null;
  endsAtBlankLine: boolean;
  quoteDepth: number;
  listContinuationIndent: number;
} | null;
function htmlBlockOpening(line: string, canStartType7: boolean): {
  closesWith: RegExp | null;
  endsAtBlankLine: boolean;
  quoteDepth: number;
  listContinuationIndent: number;
} | null;
function htmlBlockOpening(line: string, canStartType7 = false): {
  closesWith: RegExp | null;
  endsAtBlankLine: boolean;
  quoteDepth: number;
  listContinuationIndent: number;
} | null {
  // CommonMark HTML block types 1 and 3-7 can begin inside blockquote/list
  // containers. Type 2 comments are already excluded by htmlCommentRanges.
  // Unlike the other types, type 7 cannot interrupt a paragraph, so its
  // complete-tag matcher is enabled only when the block scanner proves that
  // this line starts a new block.
  const quoted = stripBlockquotePrefix(line);
  let logical = quoted.logical;
  let listContinuationIndent = 0;
  while (true) {
    const list = /^ {0,3}(?:[-+*]|\d{1,9}[.)])(?:[ \t]+|$)/.exec(logical)?.[0];
    if (!list) break;
    logical = logical.slice(list.length);
    listContinuationIndent += list.length;
  }
  const type1 = /^ {0,3}<(pre|script|style|textarea)(?=[ \t>]|$)/i.exec(logical);
  const type3 = /^ {0,3}<\?/.test(logical);
  const type4 = /^ {0,3}<![A-Z]/.test(logical);
  const type5 = /^ {0,3}<!\[CDATA\[/.test(logical);
  const type6 = new RegExp(
    "^ {0,3}</?(?:address|article|aside|base|basefont|blockquote|body|caption|center|"
      + "col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|"
      + "form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|"
      + "menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|"
      + "tbody|td|tfoot|th|thead|title|tr|track|ul)(?=[ \\t/>]|$)",
    "i",
  ).test(logical);
  const tagName = "[A-Za-z][A-Za-z0-9-]*";
  const attributeName = "[A-Za-z_:][A-Za-z0-9_.:-]*";
  const attributeValue = "(?:[^\\s\"'=<>`]+|'[^']*'|\"[^\"]*\")";
  const attribute = `[ \\t]+${attributeName}(?:[ \\t]*=[ \\t]*${attributeValue})?`;
  const type1Name = "(?:pre|script|style|textarea)(?=[ \\t/>]|$)";
  const type7 = canStartType7 && new RegExp(
    `^ {0,3}(?:<(?!${type1Name})${tagName}(?:${attribute})*[ \\t]*/?>`
      + `|</(?!${type1Name})${tagName}[ \\t]*>)[ \\t]*$`,
    "i",
  ).test(logical);
  if (!type1 && !type3 && !type4 && !type5 && !type6 && !type7) return null;
  const closesWith = type1
    ? new RegExp(`</${type1[1]!}[ \\t]*>`, "i")
    : type3
      ? /\?>/
      : type4
        ? />/
        : type5
          ? /\]\]>/
          : null;
  return {
    closesWith,
    endsAtBlankLine: type6 || type7,
    quoteDepth: quoted.depth,
    listContinuationIndent,
  };
}

function htmlBlockContinues(
  line: string,
  html: NonNullable<ReturnType<typeof htmlBlockOpening>>,
): boolean {
  // A raw HTML block opened inside a container cannot consume a later line
  // after that container ends. Root-level blocks have no such constraint.
  if (html.quoteDepth === 0 && html.listContinuationIndent === 0) return true;
  const quoted = stripBlockquotePrefix(line);
  if (quoted.depth !== html.quoteDepth) return false;
  if (html.listContinuationIndent === 0) return true;
  const indentation = /^[ \t]*/.exec(quoted.logical)?.[0].length ?? 0;
  return indentation >= html.listContinuationIndent;
}

function blockCodeRanges(value: string, excluded: MarkdownRange[] = []): MarkdownRange[] {
  const ranges: MarkdownRange[] = [];
  let lineStart = 0;
  let previousLogicalBlank = true;
  let paragraphOpen = false;
  let previousQuoteDepth = 0;
  let indentedCode = false;
  let fence: (NonNullable<ReturnType<typeof fenceOpening>> & { start: number }) | null = null;
  let html: (NonNullable<ReturnType<typeof htmlBlockOpening>> & { start: number }) | null = null;
  while (lineStart < value.length) {
    const newline = value.indexOf("\n", lineStart);
    const lineEnd = newline < 0 ? value.length : newline + 1;
    const line = value.slice(lineStart, newline < 0 ? value.length : newline).replace(/\r$/, "");
    const quoted = stripBlockquotePrefix(line);
    const logical = quoted.logical;
    if (html) {
      if (!htmlBlockContinues(line, html) || (html.endsAtBlankLine && logical.trim() === "")) {
        ranges.push({ start: html.start, end: lineStart });
        html = null;
      } else {
        if (html.closesWith?.test(line)) {
          ranges.push({ start: html.start, end: lineEnd });
          html = null;
        }
        lineStart = lineEnd;
        previousLogicalBlank = logical.trim().length === 0;
        paragraphOpen = false;
        previousQuoteDepth = quoted.depth;
        continue;
      }
    }
    if (fence) {
      if (fenceClosing(line, fence)) {
        ranges.push({ start: fence.start, end: lineEnd });
        fence = null;
      }
      lineStart = lineEnd;
      previousLogicalBlank = logical.trim().length === 0;
      paragraphOpen = false;
      previousQuoteDepth = quoted.depth;
      continue;
    }

    const excludedLine = containingRange(excluded, lineStart);
    const listStarts = /^ {0,3}(?:[-+*]|\d{1,9}[.)])(?:[ \t]+|$)/.test(logical);
    const containerStarts = quoted.depth > previousQuoteDepth || listStarts;
    const htmlOpening = excludedLine
      ? null
      : htmlBlockOpening(line, !paragraphOpen || containerStarts);
    if (htmlOpening) {
      html = { ...htmlOpening, start: lineStart };
      if (html.closesWith?.test(line)) {
        ranges.push({ start: lineStart, end: lineEnd });
        html = null;
      }
      indentedCode = false;
      lineStart = lineEnd;
      previousLogicalBlank = false;
      paragraphOpen = false;
      previousQuoteDepth = quoted.depth;
      continue;
    }

    const opening = excludedLine ? null : fenceOpening(line);
    if (opening) {
      fence = { ...opening, start: lineStart };
      indentedCode = false;
      lineStart = lineEnd;
      previousLogicalBlank = false;
      paragraphOpen = false;
      previousQuoteDepth = quoted.depth;
      continue;
    }

    const blank = logical.trim().length === 0;
    const indented = /^(?: {4}|\t)/.test(logical);
    if (indented && (indentedCode || previousLogicalBlank)) {
      ranges.push({ start: lineStart, end: lineEnd });
      indentedCode = true;
      paragraphOpen = false;
    } else if (!blank) {
      indentedCode = false;
      const blockMarker = /^(?: {0,3}#{1,6}(?:[ \t]+|$)| {0,3}(?:=+|-+)[ \t]*$| {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$)/
        .test(logical);
      paragraphOpen = !blockMarker;
    } else {
      paragraphOpen = false;
    }
    previousLogicalBlank = blank;
    previousQuoteDepth = quoted.depth;
    lineStart = lineEnd;
  }
  if (html) ranges.push({ start: html.start, end: value.length });
  if (fence) ranges.push({ start: fence.start, end: value.length });
  return ranges;
}

function mergeRanges(ranges: MarkdownRange[]): MarkdownRange[] {
  const merged: MarkdownRange[] = [];
  for (const range of ranges.sort((left, right) => left.start - right.start || left.end - right.end)) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

/** Transform only rendered prose, preserving code, comments and escaped link examples byte-exact. */
function mapMarkdownOutsideCode(
  value: string,
  transform: (plain: string) => string,
): string {
  const provisionalInline = inlineCodeRanges(value);
  const provisionalComments = htmlCommentRanges(value, provisionalInline);
  const provisionalBlocks = blockCodeRanges(value, provisionalComments);
  const inline = inlineCodeRanges(value, provisionalBlocks);
  const comments = htmlCommentRanges(value, mergeRanges([...provisionalBlocks, ...inline]));
  const blocks = blockCodeRanges(value, comments);
  const excluded = mergeRanges([...blocks, ...inline, ...comments, ...escapedLinkRanges(value)]);
  let output = "";
  let plainStart = 0;
  for (const range of excluded) {
    output += transform(value.slice(plainStart, range.start));
    output += value.slice(range.start, range.end);
    plainStart = range.end;
  }
  return output + transform(value.slice(plainStart));
}

export function extractDocumentLinks(markdown: string): string[] {
  return extractOutsideCode(markdown, DOCUMENT_LINK, 2);
}

function extractOutsideCode(markdown: string, pattern: RegExp, capture: number): string[] {
  const links = new Set<string>();
  mapMarkdownOutsideCode(markdown, (plain) => {
    for (const match of plain.matchAll(new RegExp(pattern.source, pattern.flags))) {
      const bracket = match.index + match[0].indexOf("[");
      if (escapedAt(plain, bracket)) continue;
      links.add(match[capture]!.toLowerCase());
    }
    return plain;
  });
  return [...links];
}
