import { pathToFileURL } from "node:url";
import {
  AutomationRegistryRepository,
  DirectoryRepository,
  KnowledgeSettingsRepository,
  PageRepository,
  createPool,
  formatTemplateResult,
  knowledgeTemplateMigrationContract,
  reconcileKnowledgeTemplate,
} from "@context-use/database";
import { BrokeredMarkdownObjectStore } from "./markdown-object-store.ts";
import { BrokeredStorage } from "./storage-client.ts";
import { protectedOperationalTemplatePaths } from "./knowledge-prepare.ts";
import { operationalTemplateSkipPaths } from "./operational-document-prepare.ts";

const action = process.argv[2];
if (action !== "plan" && action !== "apply") {
  throw new Error("Expected template action: plan or apply");
}
const templateName = process.argv[3] ?? "default";
if (process.env.NODE_ENV === "production" && templateName !== "default") {
  throw new Error("Production knowledge preparation only supports the default template");
}
const extraArguments = process.argv.slice(4);
const knownArguments = new Set(["--force-template"]);
if (extraArguments.some((argument) => !knownArguments.has(argument))) {
  throw new Error("Unknown template command option");
}

const development = process.env.NODE_ENV !== "production";
const socketPath = process.env.STORAGE_SOCKET_PATH
  ?? (development ? "/tmp/context-use-storage.sock" : undefined);
const token = process.env.STORAGE_DASHBOARD_TOKEN
  ?? (development ? "development-storage-dashboard-token" : undefined);
if (!socketPath || !token) throw new Error("Template management requires the storage broker capability");

const storage = new BrokeredStorage({
  socketPath,
  token,
});
const bodies = new BrokeredMarkdownObjectStore(storage);

const forceTemplate = extraArguments.includes("--force-template");
if (action === "apply") {
  throw new Error("Template apply must run through the isolated knowledge-prepare service");
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required to preview knowledge templates");
const pool = createPool(databaseUrl, { application_name: "context-use-knowledge-template-plan" });
try {
  const configuredRoot = process.env.CONTEXT_USE_DEVELOPMENT_TEMPLATE_ROOT;
  const templatesRoot = configuredRoot
    ? pathToFileURL(configuredRoot.endsWith("/") ? configuredRoot : `${configuredRoot}/`)
    : undefined;
  const pages = new PageRepository(pool, bodies);
  const contract = await knowledgeTemplateMigrationContract(templateName, templatesRoot);
  const skipOperationalPaths = await operationalTemplateSkipPaths({
    repositories: {
      settings: new KnowledgeSettingsRepository(pool),
      pages,
      registry: new AutomationRegistryRepository(pool),
    },
    template: contract,
  });
  const result = await reconcileKnowledgeTemplate({
    directories: new DirectoryRepository(pool),
    pages,
  }, templateName, false, forceTemplate, templatesRoot, {
    preserveLocallyModifiedPaths: protectedOperationalTemplatePaths(contract),
    skipOperationalPaths,
  });
  console.log(formatTemplateResult(result, !("NO_COLOR" in process.env)));
} finally {
  await pool.end();
}
