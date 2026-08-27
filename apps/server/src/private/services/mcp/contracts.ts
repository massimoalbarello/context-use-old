import type {
  AssetRepository,
  KnowledgePageRepository,
  PrivateObjectCatalogRepository,
} from "@context-use/database";

export type McpContext = {
  clientId: string;
  sessionId: string;
};

export type McpObjectRepositories = {
  pages: KnowledgePageRepository;
  assets: AssetRepository;
  objectCatalog: PrivateObjectCatalogRepository;
};

export type HypermediaReader = (input: { objectId: string; revisionId: string | null }) => Promise<{
  links_indexed: boolean;
  outbound_object_ids: string[];
  backlinks: Array<{
    source_object_id: string;
    source_revision_id: string;
    source_revision_number: number;
    source_authority: string;
    source_representation: string;
  }>;
  backlinks_has_more: boolean;
  backlinks_complete: boolean;
}>;

export type GuidancePolicy = {
  hasCurrentGuidance(receipt?: string): Promise<boolean>;
  required(retryTool: string): ReturnType<typeof import("./tool-content.ts").textContent>;
};
