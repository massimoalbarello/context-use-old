import {
  mapMarkdownOutsideCode,
  normalizeInternalDocumentLinks,
  wikiLinkCandidatePaths,
} from "@context-use/database";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const FRAGMENT = "#[a-z0-9][a-z0-9_-]*";
const WIKI_LINK = new RegExp(
  `(?<!!)\\[\\[([a-z0-9][a-z0-9/_-]*)((${FRAGMENT}))?(?:\\|([^\\]\\n]+))?\\]\\]`,
  "gi",
);
const DIRECTORY_LINK = new RegExp(
  `(?<!!)\\[([^\\]\\n]*)\\]\\(context-use:\\/\\/directory\\/(${UUID})((${FRAGMENT}))?\\)`,
  "gi",
);
const PUBLIC_ASSET_IMAGE = new RegExp(
  `!\\[([^\\]\\n]*)\\]\\(context-use:\\/\\/public-asset\\/([a-z0-9][a-z0-9/_-]*)\\)(\\{[^}\\r\\n]*\\})?`,
  "gi",
);
const PUBLIC_ASSET_LINK = new RegExp(
  `(?<!!)\\[([^\\]\\n]*)\\]\\(context-use:\\/\\/public-asset\\/([a-z0-9][a-z0-9/_-]*)\\)`,
  "gi",
);
const DOCUMENT_LINK = new RegExp(
  `(!?)\\[([^\\]\\n]*)\\]\\(context-use:\\/\\/document\\/(${UUID})((${FRAGMENT}))?\\)(\\{[^}\\r\\n]*\\})?`,
  "gi",
);

export type CorpusMigrationPageTarget = {
  documentId: string;
  path: string;
};

export type CorpusMigrationDirectoryTarget = {
  documentId: string;
  path: string;
  operational?: boolean;
};

export type CorpusMigrationPublicAssetTarget = {
  documentId: string;
  publicPath: string;
};

export type CorpusMigrationLinkIndex = {
  pages: CorpusMigrationPageTarget[];
  directories: CorpusMigrationDirectoryTarget[];
  publicAssets: CorpusMigrationPublicAssetTarget[];
  documentIds: string[];
};

export type CorpusMigrationKnowledgeBody = {
  path: string;
  bodyMarkdown: string;
};

type UniqueTarget = { documentId: string } | null;

function escapedAt(value: string, index: number): boolean {
  let count = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor -= 1) count += 1;
  return count % 2 === 1;
}

function replaceUnescapedLinks(
  value: string,
  pattern: RegExp,
  replacement: (match: RegExpMatchArray) => string,
): string {
  let output = "";
  let cursor = 0;
  for (const match of value.matchAll(new RegExp(pattern.source, pattern.flags))) {
    const start = match.index;
    const bracket = start + match[0].indexOf("[");
    if (escapedAt(value, bracket)) continue;
    output += value.slice(cursor, start) + replacement(match);
    cursor = start + match[0].length;
  }
  return output + value.slice(cursor);
}

function uniqueTargets<T>(
  values: T[],
  key: (value: T) => string,
  documentId: (value: T) => string,
): Map<string, UniqueTarget> {
  const result = new Map<string, UniqueTarget>();
  for (const value of values) {
    const normalizedKey = key(value).toLowerCase();
    const normalizedId = documentId(value).toLowerCase();
    const existing = result.get(normalizedKey);
    if (existing === undefined) {
      result.set(normalizedKey, { documentId: normalizedId });
    } else if (existing?.documentId !== normalizedId) {
      // An impossible-looking duplicate is still unsafe migration input. Keep
      // the visible label but never choose one identity arbitrarily.
      result.set(normalizedKey, null);
    }
  }
  return result;
}

function readableLabel(label: string | undefined, fallback: string): string {
  return label?.trim() || fallback.split("/").at(-1) || fallback;
}

function resolvedCandidate(
  candidates: string[],
  targets: Map<string, UniqueTarget>,
): UniqueTarget | undefined {
  for (const candidate of candidates) {
    if (targets.has(candidate)) return targets.get(candidate);
  }
  return undefined;
}

/** Build one reusable scanner for legacy references that keep empty directories meaningful. */
export function createDirectoryReferenceScanner(
  index: CorpusMigrationLinkIndex,
): (body: CorpusMigrationKnowledgeBody) => Set<string> {
  const pagesByPath = uniqueTargets(index.pages, ({ path }) => path, ({ documentId }) => documentId);
  const eligibleDirectories = index.directories
    .filter(({ path, operational }) => path !== "" && !operational);
  const directoriesByPath = uniqueTargets(
    eligibleDirectories,
    ({ path }) => path,
    ({ documentId }) => documentId,
  );
  const directoriesById = uniqueTargets(
    eligibleDirectories,
    ({ documentId }) => documentId,
    ({ documentId }) => documentId,
  );
  return (body) => {
    const referenced = new Set<string>();
    mapMarkdownOutsideCode(body.bodyMarkdown, (plain) => {
      const normalized = normalizeInternalDocumentLinks(plain);
      for (const match of normalized.matchAll(new RegExp(DIRECTORY_LINK.source, "gi"))) {
        const bracket = match.index + match[0].indexOf("[");
        if (escapedAt(normalized, bracket)) continue;
        const target = directoriesById.get(match[2]!.toLowerCase());
        if (target) referenced.add(target.documentId);
      }
      for (const match of normalized.matchAll(new RegExp(WIKI_LINK.source, "gi"))) {
        if (escapedAt(normalized, match.index)) continue;
        const path = match[1]!.toLowerCase();
        const candidates = wikiLinkCandidatePaths(path, body.path.toLowerCase());
        // A page is the existing resolver's first choice. An ambiguous page path
        // is not permission to reinterpret the link as a directory.
        const page = resolvedCandidate(candidates, pagesByPath);
        if (page !== undefined) continue;
        const directory = resolvedCandidate(candidates, directoriesByPath);
        if (directory) referenced.add(directory.documentId);
      }
      return plain;
    });
    return referenced;
  };
}

/** Find legacy references that make an otherwise empty directory meaningful. */
export function referencedDirectoryDocumentIds(
  bodies: CorpusMigrationKnowledgeBody[],
  index: CorpusMigrationLinkIndex,
): Set<string> {
  const scan = createDirectoryReferenceScanner(index);
  const referenced = new Set<string>();
  for (const body of bodies) {
    for (const id of scan(body)) referenced.add(id);
  }
  return referenced;
}

function documentLink(
  label: string,
  documentId: string,
  fragment = "",
  image = false,
  attributes = "",
): string {
  return `${image ? "!" : ""}[${label}](context-use://document/${documentId}${fragment})${attributes}`;
}

/**
 * Convert the path-dependent references in one active current knowledge body.
 * The rest of the Markdown is byte-for-byte unchanged. Raw source records and
 * immutable historical revisions must never be passed to this function.
 */
export function rewriteCurrentKnowledgeMarkdown(
  markdown: string,
  sourcePath: string,
  index: CorpusMigrationLinkIndex,
): string {
  const pagesByPath = uniqueTargets(index.pages, ({ path }) => path, ({ documentId }) => documentId);
  const directoriesByPath = uniqueTargets(
    index.directories.filter(({ path, operational }) => path !== "" && !operational),
    ({ path }) => path,
    ({ documentId }) => documentId,
  );
  const directoriesById = uniqueTargets(
    index.directories.filter(({ path, operational }) => path !== "" && !operational),
    ({ documentId }) => documentId,
    ({ documentId }) => documentId,
  );
  const publicAssetsByPath = uniqueTargets(
    index.publicAssets,
    ({ publicPath }) => publicPath,
    ({ documentId }) => documentId,
  );
  const readableDocumentIds = new Set(index.documentIds.map((id) => id.toLowerCase()));

  return mapMarkdownOutsideCode(markdown, (plain) => {
    let rewritten = normalizeInternalDocumentLinks(plain);
    rewritten = replaceUnescapedLinks(
      rewritten,
      DOCUMENT_LINK,
      (match) => (
        readableDocumentIds.has(match[3]!.toLowerCase())
          ? match[0]
          : readableLabel(match[2], match[1] ? "Asset" : "Document")
      ),
    );
    rewritten = replaceUnescapedLinks(
      rewritten,
      WIKI_LINK,
      (match) => {
        const rawPath = match[1]!;
        const fragment = match[3];
        const explicitLabel = match[4];
        const path = rawPath.toLowerCase();
        const label = readableLabel(explicitLabel, rawPath);
        for (const candidate of wikiLinkCandidatePaths(path, sourcePath.toLowerCase())) {
          const page = pagesByPath.get(candidate);
          if (page === null) return label;
          if (page) return documentLink(label, page.documentId, fragment ?? "");
        }
        for (const candidate of wikiLinkCandidatePaths(path, sourcePath.toLowerCase())) {
          const directory = directoriesByPath.get(candidate);
          if (directory === null) return label;
          if (directory) return documentLink(label, directory.documentId, fragment ?? "");
        }
        return label;
      },
    );
    rewritten = replaceUnescapedLinks(
      rewritten,
      DIRECTORY_LINK,
      (match) => {
        const label = match[1]!;
        const id = match[2]!;
        const fragment = match[4];
        const target = directoriesById.get(id.toLowerCase());
        return target
          ? documentLink(readableLabel(label, "Directory"), target.documentId, fragment ?? "")
          : readableLabel(label, "Directory");
      },
    );
    rewritten = replaceUnescapedLinks(
      rewritten,
      PUBLIC_ASSET_IMAGE,
      (match) => {
        const label = match[1]!;
        const path = match[2]!;
        const attributes = match[3];
        const target = publicAssetsByPath.get(path.toLowerCase());
        return target
          ? documentLink(label, target.documentId, "", true, attributes ?? "")
          : readableLabel(label, "Asset");
      },
    );
    rewritten = replaceUnescapedLinks(
      rewritten,
      PUBLIC_ASSET_LINK,
      (match) => {
        const label = match[1]!;
        const path = match[2]!;
        const target = publicAssetsByPath.get(path.toLowerCase());
        return target
          ? documentLink(readableLabel(label, path), target.documentId)
          : readableLabel(label, path);
      },
    );
    return rewritten;
  });
}

export type DirectoryHubLink = {
  documentId: string;
  label: string;
  summary?: string | null;
  sortKey: string;
};

function escapeMarkdownText(value: string): string {
  return value
    .replace(/\s*[\r\n]+\s*/g, " ")
    .replace(/[\\`*_[\]{}()<>#+.!|>-]/g, "\\$&");
}

function escapeMarkdownLinkLabel(value: string): string {
  // The deterministic link extractor intentionally stays small and treats a
  // backslash-escaped `]` as a delimiter. Numeric entities keep legacy label
  // brackets readable without letting them terminate the generated link.
  return escapeMarkdownText(value)
    .replaceAll("\\[", "&#91;")
    .replaceAll("\\]", "&#93;");
}

/** Build an ordinary atomic hub from already-authorized exact direct children. */
export function renderDirectoryHubMarkdown(input: {
  title: string;
  summary: string;
  links: DirectoryHubLink[];
}): string {
  const heading = escapeMarkdownText(input.title.trim());
  const sections = [`# ${heading}`, escapeMarkdownText(input.summary.trim())]
    .filter(Boolean);
  if (input.links.length) {
    const seen = new Set<string>();
    const links = [...input.links]
      .sort((left, right) => left.sortKey.localeCompare(right.sortKey, "en")
        || left.documentId.localeCompare(right.documentId, "en")
        || left.label.localeCompare(right.label, "en")
        || (left.summary ?? "").localeCompare(right.summary ?? "", "en"))
      .filter(({ documentId }) => {
        const normalized = documentId.toLowerCase();
        if (seen.has(normalized)) return false;
        seen.add(normalized);
        return true;
      })
      .map((link) => {
        const target = documentLink(
          escapeMarkdownLinkLabel(link.label.trim() || "Untitled"),
          link.documentId,
        );
        const summary = link.summary?.trim();
        return `- ${target}${summary ? ` — ${escapeMarkdownText(summary)}` : ""}`;
      });
    sections.push(`## Contents\n\n${links.join("\n")}`);
  }
  return `${sections.join("\n\n")}\n`;
}

export type LegacyDirectoryCandidate = {
  documentId: string;
  path: string;
  parentPath: string | null;
  title: string;
  summary: string;
  templateTitle?: string;
  templateSummary?: string;
  retainedDirectDocuments: number;
  legacyPublicReachable: boolean;
  hasExistingHub?: boolean;
  operational?: boolean;
};

export type DirectoryHubEligibility = {
  eligibleDocumentIds: Set<string>;
  retiredScaffoldingDocumentIds: Set<string>;
  operationalDocumentIds: Set<string>;
};

function exactDefaultPresentation(directory: LegacyDirectoryCandidate): boolean {
  return directory.templateTitle !== undefined
    && directory.templateSummary !== undefined
    && directory.title === directory.templateTitle
    && directory.summary === directory.templateSummary;
}

/**
 * Retain structure only when the corpus gives it meaning. Eligibility flows
 * upward from useful descendants, while the legacy root and all operational
 * automation directories deliberately remain non-documents.
 */
export function planDirectoryHubEligibility(
  directories: LegacyDirectoryCandidate[],
  inboundReferences: ReadonlySet<string>,
): DirectoryHubEligibility {
  const eligibleDocumentIds = new Set<string>();
  const retiredScaffoldingDocumentIds = new Set<string>();
  const operationalDocumentIds = new Set<string>();
  const hasEligibleChild = new Set<string>();
  const ordered = [...directories].sort((left, right) => {
    const depth = right.path.split("/").filter(Boolean).length
      - left.path.split("/").filter(Boolean).length;
    return depth || right.path.localeCompare(left.path, "en");
  });
  for (const directory of ordered) {
    const id = directory.documentId.toLowerCase();
    if (directory.operational) {
      operationalDocumentIds.add(id);
      continue;
    }
    if (directory.path === "") continue;
    const eligible = directory.retainedDirectDocuments > 0
      || directory.legacyPublicReachable
      || directory.hasExistingHub === true
      || inboundReferences.has(id)
      || hasEligibleChild.has(directory.path)
      || !exactDefaultPresentation(directory);
    if (eligible) {
      eligibleDocumentIds.add(id);
      if (directory.parentPath !== null) hasEligibleChild.add(directory.parentPath);
    } else {
      retiredScaffoldingDocumentIds.add(id);
    }
  }
  return { eligibleDocumentIds, retiredScaffoldingDocumentIds, operationalDocumentIds };
}

export type LegacyAutomationPage = {
  documentId: string;
  path: string;
  guide?: boolean;
};

export type LegacyAutomationDirectory = {
  path: string;
  title: string;
};

export type PlannedAutomationRegistration = {
  key: string;
  name: string;
  instructionsDocumentId: string;
  stateDocumentId: string | null;
};

export type LegacyAutomationPlan = {
  registrations: PlannedAutomationRegistration[];
  unrecognizedDocumentIds: string[];
};

/**
 * Recognize only the historical two-page harness convention. Everything else
 * remains ordinary searchable knowledge and is reported for owner review.
 */
export function planLegacyAutomationRegistry(
  pages: LegacyAutomationPage[],
  directories: LegacyAutomationDirectory[],
): LegacyAutomationPlan {
  const directoryTitles = new Map(directories.map(({ path, title }) => [path, title]));
  const activePages = new Map(pages.map((page) => [page.path, page]));
  const claimed = new Set<string>();
  const registrations: PlannedAutomationRegistration[] = [];
  for (const page of [...pages].sort((left, right) => left.path.localeCompare(right.path, "en"))) {
    const match = /^automations\/([a-z0-9]+(?:-[a-z0-9]+)*)\/instructions$/.exec(page.path);
    if (!match || page.guide) continue;
    const key = match[1]!;
    const directoryPath = `automations/${key}`;
    const name = directoryTitles.get(directoryPath);
    if (!name) continue;
    const state = activePages.get(`${directoryPath}/state`);
    registrations.push({
      key,
      name,
      instructionsDocumentId: page.documentId.toLowerCase(),
      stateDocumentId: state?.guide ? null : state?.documentId.toLowerCase() ?? null,
    });
    claimed.add(page.documentId.toLowerCase());
    if (state && !state.guide) claimed.add(state.documentId.toLowerCase());
  }
  return {
    registrations,
    unrecognizedDocumentIds: pages
      .filter(({ path, guide }) => path.startsWith("automations/") && !guide)
      .map(({ documentId }) => documentId.toLowerCase())
      .filter((documentId) => !claimed.has(documentId))
      .sort(),
  };
}
