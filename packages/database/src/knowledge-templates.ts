import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createPageSchema,
  DirectoryPath,
  PagePath,
  summarizeTemplateResult,
} from "@context-use/shared";
import type {
  Actor,
  ArchivePageInput,
  CreateDirectoryInput,
  CreatePageInput,
  TemplateAction,
  TemplateResult,
  UpdateDirectoryInput,
  UpdatePageInput,
} from "@context-use/shared";
import { embeddedDefaultKnowledgeTemplate } from "./default-knowledge-template.ts";
import { DirectoryRepository } from "./directories.ts";
import { PageRepository } from "./pages.ts";

const TEMPLATES_ROOT = new URL("../templates/", import.meta.url);
const TEMPLATE_ACTOR_PREFIX = "context-use-template/";
const LEGACY_BOOTSTRAP_ACTOR = "context-use-bootstrap";
const TEMPLATE_PAGES_DIRECTORY = "_pages";
const TEMPLATE_RETIREMENTS_FILE = "retired.json";

type TemplatePage = {
  id: string;
  current_path: string;
  version_number: number;
  title: string;
  summary: string;
  body_markdown: string;
  published_version_id: unknown | null;
  archived_at: unknown | null;
};

type TemplatePageVersion = {
  actor_subject: string;
};

type TemplateDirectory = {
  id: string;
  current_path: string;
  version_number: number;
  title: string;
  summary: string;
};

type TemplateDirectoryPresentation = {
  title: string;
  summary: string;
};

type TemplatePageManagement = "managed" | "create-only";

type TemplatePageDefinition = {
  input: CreatePageInput;
  management: TemplatePageManagement;
};

type TemplateRetirements = {
  directories: string[];
  pages: string[];
};

type ResolvedKnowledgeTemplate = {
  guideDirectoryPaths: string[];
  guideBodies: ReadonlyMap<string, string>;
  directoryPresentations: Map<string, TemplateDirectoryPresentation>;
  pages: TemplatePageDefinition[];
  retirements: TemplateRetirements;
};

export type KnowledgeTemplatePageContract = {
  path: string;
  title: string;
  summary: string;
  body_markdown: string;
  management: TemplatePageManagement;
};

export type KnowledgeTemplateMigrationContract = {
  template: string;
  directories: Array<{ path: string; title: string; summary: string }>;
  root_guide: KnowledgeTemplatePageContract;
  pages: KnowledgeTemplatePageContract[];
};

export type TemplateRepositories = {
  directories: Pick<DirectoryRepository, "getByPath" | "create" | "update">;
  pages: Pick<PageRepository, "getByPath" | "create" | "update" | "archive" | "version">;
};

export type KnowledgeTemplateReconcileOptions = {
  /** Never force-overwrite these owner-authored operational documents. */
  preserveLocallyModifiedPaths?: ReadonlySet<string>;
  /** Their live contracts are managed by setting/registry identity, not path. */
  skipOperationalPaths?: ReadonlySet<string>;
};

const RESULT_INDICATORS = {
  create: { symbol: "+", color: 32 },
  change: { symbol: "~", color: 33 },
  conflict: { symbol: "!", color: 31 },
  success: { symbol: "✓", color: 32 },
} as const;

function assertTemplateName(name: string): void {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    throw new Error(`Invalid template name: ${name}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseDirectoryPresentations(
  source: string,
  guideDirectoryPaths: string[],
): Map<string, TemplateDirectoryPresentation> {
  const parsed: unknown = JSON.parse(source);
  if (!isRecord(parsed)) throw new Error("Template directories.json must contain an object");

  for (const path of guideDirectoryPaths) {
    if (!(path in parsed)) throw new Error(`Template directory metadata is missing: ${path || "/"}`);
  }

  const presentations = new Map<string, TemplateDirectoryPresentation>();
  for (const path of Object.keys(parsed)) {
    if (!DirectoryPath.safeParse(path).success) {
      throw new Error(`Invalid template directory path: ${path || "/"}`);
    }
    const presentation = parsed[path];
    if (!isRecord(presentation)) throw new Error(`Template directory metadata is missing: ${path || "/"}`);
    const { title, summary } = presentation;
    if (typeof title !== "string" || !title.trim() || title.length > 240 || /[\r\n]/.test(title)) {
      throw new Error(`Invalid template directory title: ${path || "/"}`);
    }
    if (typeof summary !== "string" || !summary.trim() || summary.length > 320 || /[\r\n]/.test(summary)) {
      throw new Error(`Invalid template directory summary: ${path || "/"}`);
    }
    presentations.set(path, { title: title.trim(), summary: summary.trim() });
  }
  if (!presentations.has("")) throw new Error("Template directory metadata is missing: /");
  for (const path of presentations.keys()) {
    if (!path) continue;
    const parentPath = path.includes("/") ? path.replace(/\/[^/]+$/, "") : "";
    if (!presentations.has(parentPath)) {
      throw new Error(`Template directory metadata has no parent: ${path}`);
    }
  }
  return presentations;
}

async function readDirectoryPresentations(
  rootPath: string,
  guideDirectoryPaths: string[],
): Promise<Map<string, TemplateDirectoryPresentation>> {
  return parseDirectoryPresentations(
    await readFile(join(rootPath, "directories.json"), "utf8"),
    guideDirectoryPaths,
  );
}

async function parseTemplatePages(
  source: string,
  availableBodyFiles: readonly string[],
  readBody: (bodyFile: string) => Promise<string> | string,
  directoryPaths: Set<string>,
  guideDirectoryPaths: string[],
  templateName: string,
): Promise<TemplatePageDefinition[]> {
  const parsed: unknown = JSON.parse(source);
  if (!isRecord(parsed)) throw new Error("Template pages.json must contain an object");
  const referencedBodyFiles = new Set<string>();
  const guidePaths = new Set(guideDirectoryPaths.map(guidePath));
  const definitions: TemplatePageDefinition[] = [];

  for (const [path, value] of Object.entries(parsed).sort(([left], [right]) => left.localeCompare(right))) {
    if (!PagePath.safeParse(path).success) throw new Error(`Invalid template page path: ${path}`);
    if (guidePaths.has(path)) throw new Error(`Template page collides with a guide: ${path}`);
    if (directoryPaths.has(path)) throw new Error(`Template page collides with a directory: ${path}`);
    const parentPath = path.includes("/") ? path.replace(/\/[^/]+$/, "") : "";
    if (!directoryPaths.has(parentPath)) throw new Error(`Template page parent is missing: ${path}`);
    if (!isRecord(value)) throw new Error(`Invalid template page metadata: ${path}`);
    const keys = Object.keys(value).sort();
    if (keys.join(",") !== "body_file,management,summary,title") {
      throw new Error(`Invalid template page metadata fields: ${path}`);
    }
    const { title, summary, body_file: bodyFile, management } = value;
    if (management !== "managed" && management !== "create-only") {
      throw new Error(`Invalid template page management: ${path}`);
    }
    if (typeof bodyFile !== "string"
      || !bodyFile.startsWith(`${TEMPLATE_PAGES_DIRECTORY}/`)
      || !/^_pages\/[a-z0-9][a-z0-9/_-]*\.md$/.test(bodyFile)
      || bodyFile.includes("//")) {
      throw new Error(`Invalid template page body file: ${path}`);
    }
    if (referencedBodyFiles.has(bodyFile)) {
      throw new Error(`Template page body file is referenced more than once: ${bodyFile}`);
    }
    referencedBodyFiles.add(bodyFile);
    const bodyMarkdown = await readBody(bodyFile);
    const input = createPageSchema.parse({
      path,
      title,
      summary,
      body_markdown: bodyMarkdown.trimEnd() + "\n",
      commit_message: `Apply ${templateName} knowledge template`,
    });
    definitions.push({ input, management });
  }
  for (const bodyFile of availableBodyFiles) {
    if (!referencedBodyFiles.has(bodyFile)) {
      throw new Error(`Template page body file is orphaned: ${bodyFile}`);
    }
  }
  return definitions;
}

async function readTemplatePages(
  rootPath: string,
  directoryPaths: Set<string>,
  guideDirectoryPaths: string[],
  templateName: string,
): Promise<TemplatePageDefinition[]> {
  return parseTemplatePages(
    await readFile(join(rootPath, "pages.json"), "utf8"),
    await discoverTemplatePageBodyFiles(rootPath),
    (bodyFile) => readFile(join(rootPath, bodyFile), "utf8"),
    directoryPaths,
    guideDirectoryPaths,
    templateName,
  );
}

async function discoverTemplatePageBodyFiles(rootPath: string): Promise<string[]> {
  const files: string[] = [];
  const pagesRoot = join(rootPath, TEMPLATE_PAGES_DIRECTORY);

  async function visit(relativePath: string): Promise<void> {
    const filesystemPath = relativePath ? join(pagesRoot, relativePath) : pagesRoot;
    let entries;
    try {
      entries = await readdir(filesystemPath, { withFileTypes: true });
    } catch (error) {
      if (!relativePath && isRecord(error) && error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const entryPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
      const bodyFile = `${TEMPLATE_PAGES_DIRECTORY}/${entryPath}`;
      if (entry.isDirectory()) {
        await visit(entryPath);
      } else if (entry.isFile()) {
        if (!/^_pages\/[a-z0-9][a-z0-9/_-]*\.md$/.test(bodyFile) || bodyFile.includes("//")) {
          throw new Error(`Invalid template page body file: ${bodyFile}`);
        }
        files.push(bodyFile);
      } else {
        throw new Error(`Unsupported template page body entry: ${bodyFile}`);
      }
    }
  }

  await visit("");
  return files;
}

function parseTemplateRetirements(
  source: string | null,
  currentDirectoryPaths: Set<string>,
  currentPagePaths: Set<string>,
): TemplateRetirements {
  if (source === null) return { directories: [], pages: [] };
  const parsed: unknown = JSON.parse(source);
  if (!isRecord(parsed) || Object.keys(parsed).sort().join(",") !== "directories,pages") {
    throw new Error("Template retired.json must contain only directories and pages arrays");
  }

  const readPaths = (
    kind: "directory" | "page",
    value: unknown,
    currentPaths: Set<string>,
  ): string[] => {
    if (!Array.isArray(value)) throw new Error(`Template retired ${kind} paths must be an array`);
    const paths: string[] = [];
    const seen = new Set<string>();
    for (const path of value) {
      const valid = typeof path === "string"
        && (kind === "directory" ? DirectoryPath : PagePath).safeParse(path).success;
      if (!valid || (kind === "directory" && path === "")) {
        throw new Error(`Invalid retired template ${kind} path: ${String(path) || "/"}`);
      }
      if (seen.has(path)) throw new Error(`Duplicate retired template ${kind} path: ${path}`);
      if (currentPaths.has(path)) throw new Error(`Template ${kind} is both current and retired: ${path}`);
      seen.add(path);
      paths.push(path);
    }
    return paths.sort((left, right) => left.localeCompare(right));
  };

  return {
    directories: readPaths("directory", parsed.directories, currentDirectoryPaths),
    pages: readPaths("page", parsed.pages, currentPagePaths),
  };
}

async function readTemplateRetirements(
  rootPath: string,
  currentDirectoryPaths: Set<string>,
  currentPagePaths: Set<string>,
): Promise<TemplateRetirements> {
  let source: string | null;
  try {
    source = await readFile(join(rootPath, TEMPLATE_RETIREMENTS_FILE), "utf8");
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") source = null;
    else throw error;
  }
  return parseTemplateRetirements(source, currentDirectoryPaths, currentPagePaths);
}

function guidePath(directoryPath: string): string {
  return directoryPath ? `${directoryPath}/agents` : "agents";
}

function guideSummary(directoryPath: string): string {
  return directoryPath
    ? `Instructions for maintaining knowledge in ${directoryPath}/.`
    : "The global instructions for maintaining this knowledge base.";
}

async function discoverGuideDirectories(rootPath: string): Promise<string[]> {
  const directories: string[] = [];

  async function visit(relativePath: string): Promise<void> {
    const filesystemPath = relativePath ? join(rootPath, relativePath) : rootPath;
    const entries = await readdir(filesystemPath, { withFileTypes: true });
    if (!entries.some((entry) => entry.isFile() && entry.name === "AGENTS.md")) {
      throw new Error(`Template directory ${relativePath || "/"} has no AGENTS.md`);
    }
    for (const entry of entries) {
      const isRootMetadata = !relativePath && entry.isFile() && entry.name === "directories.json";
      const isRootPageMetadata = !relativePath && entry.isFile() && entry.name === "pages.json";
      const isRootRetirementMetadata = !relativePath && entry.isFile() && entry.name === TEMPLATE_RETIREMENTS_FILE;
      if (entry.isFile() && entry.name !== "AGENTS.md" && !isRootMetadata && !isRootPageMetadata && !isRootRetirementMetadata) {
        throw new Error(`Unexpected template file: ${join(relativePath, entry.name)}`);
      }
      if (!entry.isFile() && !entry.isDirectory()) {
        throw new Error(`Unsupported template entry: ${join(relativePath, entry.name)}`);
      }
    }
    directories.push(relativePath);
    for (const entry of entries.filter(
      (entry) => entry.isDirectory() && !(relativePath === "" && entry.name === TEMPLATE_PAGES_DIRECTORY),
    ).sort((a, b) => a.name.localeCompare(b.name))) {
      await visit(relativePath ? `${relativePath}/${entry.name}` : entry.name);
    }
  }

  await visit("");
  return directories.sort((left, right) => {
    const depth = left.split("/").filter(Boolean).length - right.split("/").filter(Boolean).length;
    return depth || left.localeCompare(right);
  });
}

function normalizedTemplateMarkdown(markdown: string): string {
  return markdown.trimEnd() + "\n";
}

async function resolveEmbeddedDefaultTemplate(): Promise<ResolvedKnowledgeTemplate> {
  const guideDirectoryPaths = Object.keys(embeddedDefaultKnowledgeTemplate.guides);
  const guideBodies = new Map(Object.entries(embeddedDefaultKnowledgeTemplate.guides)
    .map(([path, body]) => [path, normalizedTemplateMarkdown(body)]));
  const directoryPresentations = parseDirectoryPresentations(
    embeddedDefaultKnowledgeTemplate.directoryMetadata,
    guideDirectoryPaths,
  );
  const bodyFiles = Object.keys(embeddedDefaultKnowledgeTemplate.pageBodies);
  const pages = await parseTemplatePages(
    embeddedDefaultKnowledgeTemplate.pageMetadata,
    bodyFiles,
    (bodyFile) => {
      const body = embeddedDefaultKnowledgeTemplate.pageBodies[
        bodyFile as keyof typeof embeddedDefaultKnowledgeTemplate.pageBodies
      ];
      if (body === undefined) throw new Error(`Template page body is missing: ${bodyFile}`);
      return body;
    },
    new Set(directoryPresentations.keys()),
    guideDirectoryPaths,
    embeddedDefaultKnowledgeTemplate.name,
  );
  const currentPagePaths = new Set([
    ...guideDirectoryPaths.map(guidePath),
    ...pages.map(({ input }) => input.path),
  ]);
  const retirements = parseTemplateRetirements(
    embeddedDefaultKnowledgeTemplate.retirements,
    new Set(directoryPresentations.keys()),
    currentPagePaths,
  );
  return { guideDirectoryPaths, guideBodies, directoryPresentations, pages, retirements };
}

async function resolveFilesystemTemplate(
  templateName: string,
  templatesRoot: URL,
): Promise<ResolvedKnowledgeTemplate> {
  const rootPath = new URL(`${templateName}/`, templatesRoot).pathname;
  const guideDirectoryPaths = await discoverGuideDirectories(rootPath);
  const guideBodies = new Map(await Promise.all(guideDirectoryPaths.map(async (path) => [
    path,
    normalizedTemplateMarkdown(await readFile(join(rootPath, path, "AGENTS.md"), "utf8")),
  ] as const)));
  const directoryPresentations = await readDirectoryPresentations(rootPath, guideDirectoryPaths);
  const pages = await readTemplatePages(
    rootPath,
    new Set(directoryPresentations.keys()),
    guideDirectoryPaths,
    templateName,
  );
  const currentPagePaths = new Set([
    ...guideDirectoryPaths.map(guidePath),
    ...pages.map(({ input }) => input.path),
  ]);
  const retirements = await readTemplateRetirements(
    rootPath,
    new Set(directoryPresentations.keys()),
    currentPagePaths,
  );
  return { guideDirectoryPaths, guideBodies, directoryPresentations, pages, retirements };
}

async function resolveKnowledgeTemplate(
  templateName: string,
  templatesRoot: URL,
): Promise<ResolvedKnowledgeTemplate> {
  return templateName === "default" && templatesRoot.href === TEMPLATES_ROOT.href
    ? resolveEmbeddedDefaultTemplate()
    : resolveFilesystemTemplate(templateName, templatesRoot);
}

function templateActor(name: string): Actor {
  return { kind: "dashboard", subject: `${TEMPLATE_ACTOR_PREFIX}${name}` };
}

function templateOwnsCurrentVersion(actorSubject: string, templateName: string): boolean {
  return actorSubject === `${TEMPLATE_ACTOR_PREFIX}${templateName}`
    || actorSubject === LEGACY_BOOTSTRAP_ACTOR;
}

function samePage(page: TemplatePage, input: CreatePageInput): boolean {
  return page.title === input.title
    && page.summary === input.summary
    && page.body_markdown === input.body_markdown;
}

function missingCreateOnlyStructure(page: TemplatePage, input: CreatePageInput): string[] {
  const existingLines = new Set(page.body_markdown.split(/\r?\n/).map((line) => line.trim()));
  const requiredMarkers = input.body_markdown.split(/\r?\n/).flatMap((line) => {
    const trimmed = line.trim();
    if (/^#{1,6}\s+\S/.test(trimmed)) return [trimmed];
    const field = trimmed.match(/^\*\*[^*\r\n]+:\*\*/)?.[0];
    return field ? [field] : [];
  });
  const missing = requiredMarkers.filter((marker) => marker.endsWith("**")
    ? ![...existingLines].some((line) => line.startsWith(marker))
    : !existingLines.has(marker));
  if (!page.body_markdown.trim()) missing.unshift("non-empty body");
  return [...new Set(missing)];
}

export function knowledgeTemplatePageContractMatches(
  page: { title: string; summary: string; body_markdown: string },
  contract: KnowledgeTemplatePageContract,
): boolean {
  if (contract.management === "managed") {
    return page.title === contract.title
      && page.summary === contract.summary
      && page.body_markdown === contract.body_markdown;
  }
  return missingCreateOnlyStructure(page as TemplatePage, {
    path: contract.path,
    title: contract.title,
    summary: contract.summary,
    body_markdown: contract.body_markdown,
    commit_message: "Validate knowledge template contract",
  }).length === 0;
}

export type KnowledgeTemplateBaseline = {
  template: string;
  root_directory: { title: string; summary: string };
  root_guide: {
    title: string;
    summary: string;
    body_markdown: string;
    commit_message: string;
    actor_subject: string;
  };
};

// Resolve the root metadata and guide body once so bootstrap and the retained
// template migration contract use the same canonical source files.
export async function knowledgeTemplateBaseline(
  templateName = "default",
  templatesRoot = TEMPLATES_ROOT,
): Promise<KnowledgeTemplateBaseline> {
  assertTemplateName(templateName);
  const template = await resolveKnowledgeTemplate(templateName, templatesRoot);
  const rootDirectory = template.directoryPresentations.get("")!;
  const bodyMarkdown = template.guideBodies.get("");
  if (bodyMarkdown === undefined) throw new Error("Template root guide is missing");
  return {
    template: templateName,
    root_directory: rootDirectory,
    root_guide: {
      title: "AGENTS.md",
      summary: guideSummary(""),
      body_markdown: bodyMarkdown,
      commit_message: `Apply ${templateName} knowledge template`,
      actor_subject: templateActor(templateName).subject,
    },
  };
}

/**
 * Resolve the shipped, validated presentation and operational page contracts
 * used during the one-time hypermedia corpus migration. This deliberately
 * reuses the template parser instead of hard-coding directory names or prompt
 * bodies in the migration service.
 */
export async function knowledgeTemplateMigrationContract(
  templateName = "default",
  templatesRoot = TEMPLATES_ROOT,
): Promise<KnowledgeTemplateMigrationContract> {
  assertTemplateName(templateName);
  const template = await resolveKnowledgeTemplate(templateName, templatesRoot);
  const rootDirectory = template.directoryPresentations.get("");
  const rootGuide = template.guideBodies.get("");
  if (!rootDirectory || rootGuide === undefined) {
    throw new Error("Template root contract is incomplete");
  }
  return {
    template: templateName,
    directories: [...template.directoryPresentations.entries()].map(([path, presentation]) => ({
      path,
      ...presentation,
    })),
    root_guide: {
      path: "agents",
      title: "AGENTS.md",
      summary: guideSummary(""),
      body_markdown: rootGuide,
      management: "managed",
    },
    pages: template.pages.map(({ input, management }) => ({
      path: input.path,
      title: input.title,
      summary: input.summary,
      body_markdown: input.body_markdown,
      management,
    })),
  };
}

export async function reconcileKnowledgeTemplate(
  repositories: TemplateRepositories,
  templateName = "default",
  apply = false,
  forceTemplate = false,
  templatesRoot = TEMPLATES_ROOT,
  options: KnowledgeTemplateReconcileOptions = {},
): Promise<TemplateResult> {
  assertTemplateName(templateName);
  const template = await resolveKnowledgeTemplate(templateName, templatesRoot);
  const { guideDirectoryPaths, directoryPresentations } = template;
  const directoryPaths = [...directoryPresentations.keys()].sort((left, right) => {
    const depth = left.split("/").filter(Boolean).length - right.split("/").filter(Boolean).length;
    return depth || left.localeCompare(right);
  });
  const templatePages = template.pages;
  const retirements = template.retirements;
  const actions: TemplateAction[] = [];
  const blockedDirectories = new Set<string>();

  for (const path of directoryPaths) {
    const presentation = directoryPresentations.get(path)!;
    const existing = await repositories.directories.getByPath(path) as TemplateDirectory | null;
    if (existing) {
      if (forceTemplate) {
        if (existing.title !== presentation.title || existing.summary !== presentation.summary) {
          actions.push({
            action: "update-directory",
            path,
            detail: "Overwrite local directory metadata with the template",
            replaces_local: true,
          });
          if (apply) {
            const input: UpdateDirectoryInput = {
              title: presentation.title,
              summary: presentation.summary,
              expected_version_number: existing.version_number,
            };
            await repositories.directories.update(existing.id, input);
          }
        }
        continue;
      }
      if (!existing.summary.trim()) {
        actions.push({
          action: "update-directory",
          path,
          detail: `Add template summary for ${existing.title}`,
        });
        if (apply) {
          const input: UpdateDirectoryInput = {
            title: existing.title,
            summary: presentation.summary,
            expected_version_number: existing.version_number,
          };
          await repositories.directories.update(existing.id, input);
        }
        if (existing.title !== presentation.title) {
          actions.push({
            action: "conflict",
            path,
            detail: "Directory title differs from the template; preserve local metadata",
          });
        }
        continue;
      }
      if (existing.title !== presentation.title || existing.summary !== presentation.summary) {
        actions.push({
          action: "conflict",
          path,
          detail: "Directory metadata differs from the template; preserve local metadata",
        });
      }
      continue;
    }
    if (!path) {
      blockedDirectories.add("");
      actions.push({ action: "conflict", path, detail: "Root knowledge directory is missing" });
      continue;
    }
    const parentPath = path.includes("/") ? path.replace(/\/[^/]+$/, "") : "";
    if (blockedDirectories.has(parentPath)) {
      blockedDirectories.add(path);
      actions.push({ action: "conflict", path, detail: "Parent template directory is unavailable" });
      continue;
    }
    if (await repositories.pages.getByPath(path)) {
      blockedDirectories.add(path);
      actions.push({ action: "conflict", path, detail: "Directory path is occupied by a page" });
      continue;
    }
    actions.push({
      action: "create-directory",
      path,
      detail: `Create ${presentation.title}`,
    });
    if (apply) {
      const input: CreateDirectoryInput = {
        path,
        title: presentation.title,
        summary: presentation.summary,
      };
      await repositories.directories.create(input);
    }
  }

  for (const directoryPath of guideDirectoryPaths) {
    if (blockedDirectories.has(directoryPath)) continue;
    const path = guidePath(directoryPath);
    if (options.skipOperationalPaths?.has(path)) continue;
    const bodyMarkdown = template.guideBodies.get(directoryPath);
    if (bodyMarkdown === undefined) {
      throw new Error(`Template directory ${directoryPath || "/"} has no AGENTS.md`);
    }
    const input: CreatePageInput = {
      path,
      title: "AGENTS.md",
      summary: guideSummary(directoryPath),
      body_markdown: bodyMarkdown,
      commit_message: `Apply ${templateName} knowledge template`,
    };
    const existing = await repositories.pages.getByPath(path, true) as TemplatePage | null;
    if (!existing) {
      actions.push({ action: "create-guide", path, detail: "Create directory instructions" });
      if (apply) await repositories.pages.create(input, templateActor(templateName));
      continue;
    }
    if (existing.archived_at) {
      actions.push({ action: "conflict", path, detail: "Guide was archived locally" });
      continue;
    }
    const currentVersion = await repositories.pages.version(existing.id, existing.version_number) as TemplatePageVersion | null;
    if (samePage(existing, input)) {
      if (currentVersion?.actor_subject === `${TEMPLATE_ACTOR_PREFIX}${templateName}`) {
        actions.push({ action: "unchanged", path, detail: "Already matches the template" });
        continue;
      }
      actions.push({ action: "adopt-guide", path, detail: "Adopt matching local guide" });
      if (apply) {
        const update: UpdatePageInput = { ...input, expected_version_number: existing.version_number };
        await repositories.pages.update(existing.id, update, templateActor(templateName));
      }
      continue;
    }
    if (!currentVersion || !templateOwnsCurrentVersion(currentVersion.actor_subject, templateName)) {
      actions.push({ action: "conflict", path, detail: "Preserve locally modified guide" });
      continue;
    }
    actions.push({ action: "update-guide", path, detail: "Update untouched template guide" });
    if (apply) {
      const update: UpdatePageInput = { ...input, expected_version_number: existing.version_number };
      await repositories.pages.update(existing.id, update, templateActor(templateName));
    }
  }

  for (const definition of templatePages) {
    const { input, management } = definition;
    if (options.skipOperationalPaths?.has(input.path)) continue;
    const parentPath = input.path.includes("/") ? input.path.replace(/\/[^/]+$/, "") : "";
    if (blockedDirectories.has(parentPath)) {
      actions.push({ action: "conflict", path: input.path, detail: "Parent template directory is unavailable" });
      continue;
    }
    if (await repositories.directories.getByPath(input.path)) {
      actions.push({ action: "conflict", path: input.path, detail: "Page path is occupied by a directory" });
      continue;
    }
    const existing = await repositories.pages.getByPath(input.path, true) as TemplatePage | null;
    if (!existing) {
      actions.push({ action: "create-page", path: input.path, detail: "Create template page" });
      if (apply) await repositories.pages.create(input, templateActor(templateName));
      continue;
    }
    if (existing.archived_at) {
      actions.push({ action: "conflict", path: input.path, detail: "Template page was archived locally" });
      continue;
    }
    if (management === "create-only") {
      const missingStructure = missingCreateOnlyStructure(existing, input);
      if (missingStructure.length) {
        actions.push({
          action: "conflict",
          path: input.path,
          detail: `Create-only template page is missing required structure: ${missingStructure.join(", ")}`,
        });
        continue;
      }
      actions.push({ action: "unchanged", path: input.path, detail: "Preserve create-only template page" });
      continue;
    }
    const currentVersion = await repositories.pages.version(existing.id, existing.version_number) as TemplatePageVersion | null;
    if (samePage(existing, input)) {
      if (currentVersion?.actor_subject === `${TEMPLATE_ACTOR_PREFIX}${templateName}`) {
        actions.push({ action: "unchanged", path: input.path, detail: "Already matches the template" });
        continue;
      }
      actions.push({ action: "adopt-page", path: input.path, detail: "Adopt matching local template page" });
      if (apply) {
        const update: UpdatePageInput = { ...input, expected_version_number: existing.version_number };
        await repositories.pages.update(existing.id, update, templateActor(templateName));
      }
      continue;
    }
    if (forceTemplate && !options.preserveLocallyModifiedPaths?.has(input.path)) {
      actions.push({
        action: "update-page",
        path: input.path,
        detail: "Overwrite locally modified template page",
        replaces_local: true,
      });
      if (apply) {
        const update: UpdatePageInput = { ...input, expected_version_number: existing.version_number };
        await repositories.pages.update(existing.id, update, templateActor(templateName));
      }
      continue;
    }
    if (!currentVersion || !templateOwnsCurrentVersion(currentVersion.actor_subject, templateName)) {
      actions.push({ action: "conflict", path: input.path, detail: "Preserve locally modified template page" });
      continue;
    }
    actions.push({ action: "update-page", path: input.path, detail: "Update untouched template page" });
    if (apply) {
      const update: UpdatePageInput = { ...input, expected_version_number: existing.version_number };
      await repositories.pages.update(existing.id, update, templateActor(templateName));
    }
  }

  if (!blockedDirectories.has("")) {
    for (const path of retirements.pages) {
      if (options.skipOperationalPaths?.has(path)) continue;
      const existing = await repositories.pages.getByPath(path, true) as TemplatePage | null;
      if (!existing) continue;
      if (existing.archived_at) {
        actions.push({ action: "unchanged", path, detail: "Retired template page is already archived" });
        continue;
      }
      if (existing.published_version_id) {
        actions.push({ action: "conflict", path, detail: "Retired template page is published; preserve it" });
        continue;
      }
      const currentVersion = await repositories.pages.version(existing.id, existing.version_number) as TemplatePageVersion | null;
      if (!currentVersion || !templateOwnsCurrentVersion(currentVersion.actor_subject, templateName)) {
        actions.push({ action: "conflict", path, detail: "Retired template page has local changes; preserve it" });
        continue;
      }
      actions.push({ action: "retire-page", path, detail: "Archive retired template page" });
      if (apply) {
        const input: ArchivePageInput = {
          commit_message: `Retire page removed from ${templateName} knowledge template`,
          expected_version_number: existing.version_number,
        };
        await repositories.pages.archive(existing.id, input, templateActor(templateName));
      }
    }
    for (const path of retirements.directories) {
      if (await repositories.directories.getByPath(path)) {
        actions.push({
          action: "conflict",
          path,
          detail: "Retired template directory remains; preserve it for manual review",
        });
      }
    }
  }

  return { template: templateName, applied: apply, actions };
}

function resultIndicator(
  kind: keyof typeof RESULT_INDICATORS,
  color: boolean,
): string {
  const { symbol, color: ansiColor } = RESULT_INDICATORS[kind];
  return color ? `\u001B[${ansiColor}m${symbol}\u001B[0m` : symbol;
}

export function formatTemplateResult(result: TemplateResult, color = false): string {
  const visible = result.actions.filter(({ action }) => action !== "unchanged");
  const lines = visible.map(({ action, path, detail }) => {
    const kind = action.startsWith("create-") ? "create"
      : action === "conflict" ? "conflict"
      : "change";
    return `${resultIndicator(kind, color)} ${action.padEnd(16)} ${path || "/"}  ${detail}`;
  });
  const { changes, conflicts } = summarizeTemplateResult(result);
  const summaryKind = conflicts ? "conflict" : "success";
  lines.push(`${resultIndicator(summaryKind, color)} ${result.applied ? "Applied" : "Planned"} ${changes} change${changes === 1 ? "" : "s"}; ${conflicts} conflict${conflicts === 1 ? "" : "s"}.`);
  return lines.join("\n");
}

export type { TemplateAction, TemplateResult } from "@context-use/shared";
