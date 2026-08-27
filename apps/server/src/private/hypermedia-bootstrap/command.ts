import {
  AutomationRegistryRepository,
  createPool,
  defaultHypermediaBootstrapTemplate,
  HypermediaBootstrapRepository,
  KnowledgePageRepository,
  KnowledgeSettingsRepository,
} from "@context-use/database";
import { BrokeredMarkdownBlobStore } from "#private/repositories/storage/markdown-blob-repository.ts";
import { createPrivateStorageBroker } from "#storage/client/storage-broker-client.ts";
import type { HypermediaBootstrapConfig } from "./config.ts";
import { applyHypermediaBootstrap, synchronizeGlobalGuide } from "./service.ts";

export type HypermediaBootstrapResult =
  | {
      event: "hypermedia_bootstrap_completed";
      finalized_at: Date | string;
      pages: number;
    }
  | {
      event: "managed_global_guide_current" | "managed_global_guide_updated";
      object_id: string;
      revision_number: number;
    };

export async function runHypermediaBootstrapCommand(
  config: HypermediaBootstrapConfig,
): Promise<HypermediaBootstrapResult> {
  const pool = createPool(config.CORPUS_DATABASE_URL, {
    application_name: "context-use-hypermedia-bootstrap",
  });
  try {
    const storage = createPrivateStorageBroker({
      socketPath: config.STORAGE_SOCKET_PATH,
      token: config.STORAGE_PRIVATE_TOKEN,
    });
    const bodies = new BrokeredMarkdownBlobStore(storage);
    const bootstrap = new HypermediaBootstrapRepository(pool, bodies);
    const settings = new KnowledgeSettingsRepository(pool);
    const pages = new KnowledgePageRepository(pool, bodies);
    const allocations = await bootstrap.begin();
    if (!allocations.length) {
      const synchronization = await synchronizeGlobalGuide({
        repositories: { settings, pages },
        guide: defaultHypermediaBootstrapTemplate.pages.global_guide,
        templateName: defaultHypermediaBootstrapTemplate.name,
      });
      return {
        event: synchronization.updated
          ? "managed_global_guide_updated"
          : "managed_global_guide_current",
        object_id: synchronization.object_id,
        revision_number: synchronization.revision_number,
      };
    }
    const completedAt = await applyHypermediaBootstrap({
      repositories: {
        bootstrap,
        settings,
        registry: new AutomationRegistryRepository(pool),
      },
      template: defaultHypermediaBootstrapTemplate,
      allocations,
    });
    return {
      event: "hypermedia_bootstrap_completed",
      finalized_at: completedAt,
      pages: allocations.length,
    };
  } finally {
    await pool.end();
  }
}
