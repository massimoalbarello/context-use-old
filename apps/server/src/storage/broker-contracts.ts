import type { StoragePublicationRepository } from "@context-use/database/publication";
import type { BlobStorageBackend } from "../storage.ts";

export type StorageBrokerTokens = {
  dashboard: string;
  mcp: string;
  public: string;
};

export type PrivateAssetLookup = {
  getForStorage(id: string): Promise<{
    object_id: string;
    blob_key: string;
    filename: string;
    content_type: string;
    size_bytes: number | string;
    content_hash: string;
  } | null>;
  getDeletedForStorage(id: string): Promise<{
    object_id: string;
    blob_key: string;
  } | null>;
};

export type PublicationClaims = Pick<
  StoragePublicationRepository,
  "claimIntent" | "finalizeIntent"
> &
  Partial<Pick<StoragePublicationRepository, "resolve">>;

export type StorageBrokerDependencies = {
  storage: BlobStorageBackend;
  privateAssets: PrivateAssetLookup;
  publications?: PublicationClaims;
  tokens: StorageBrokerTokens;
};

export type StorageRouteContext = StorageBrokerDependencies & {
  activeWrites: Set<string>;
};
