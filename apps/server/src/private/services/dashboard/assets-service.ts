import { type AssetRepository, mapConcurrently } from "@context-use/database";
import type { PublicationRepository } from "@context-use/database/publication";
import type { PrivateStorageBroker } from "#storage/client/contracts.ts";
import { AssetIntegrityError } from "#storage/object-storage.ts";

type DashboardAsset = NonNullable<Awaited<ReturnType<AssetRepository["getForStorage"]>>>;

export type AssetUploadResult =
  | { state: "uploaded" }
  | { state: "not_found" }
  | { state: "integrity_error"; message: string };

export type AssetDeleteResult = { state: "deleted" } | { state: "in_use" };

export class DashboardAssetsService {
  constructor(
    private readonly dependencies: {
      assets: AssetRepository;
      publications: PublicationRepository;
      storage: Pick<PrivateStorageBroker, "delete" | "verify" | "write">;
      assetOrigin: string;
    },
  ) {}

  async list() {
    return mapConcurrently(await this.dependencies.assets.list(), 8, async (asset) => {
      const status = await this.dependencies.publications.status({
        targetKind: "asset",
        targetObjectId: asset.object_id,
      });
      return {
        id: asset.object_id,
        filename: asset.filename,
        content_type: asset.content_type,
        size_bytes: Number(asset.size_bytes),
        content_hash: asset.content_hash,
        created_at: asset.created_at,
        public_id: status.public_id,
        published: status.active,
      };
    });
  }

  getContent(assetId: string): Promise<DashboardAsset | null> {
    return this.dependencies.assets.getForStorage(assetId);
  }

  async upload({
    assetId,
    body,
    suppliedSize,
    suppliedType,
  }: {
    assetId: string;
    body: ReadableStream<Uint8Array> | null;
    suppliedSize: string | null;
    suppliedType: string | null;
  }): Promise<AssetUploadResult> {
    const asset = await this.getContent(assetId);
    if (!asset) {
      return { state: "not_found" };
    }
    const expectedSize = Number(asset.size_bytes);
    if (
      suppliedSize !== null &&
      (!/^\d+$/.test(suppliedSize) || Number(suppliedSize) !== expectedSize)
    ) {
      return { state: "integrity_error", message: "Asset size mismatch" };
    }
    if (suppliedType?.toLowerCase() !== asset.content_type.toLowerCase()) {
      return { state: "integrity_error", message: "Asset content type mismatch" };
    }
    if (!body && expectedSize !== 0) {
      return { state: "integrity_error", message: "Asset size mismatch" };
    }
    try {
      await this.dependencies.storage.write(
        {
          id: asset.object_id,
          blobKey: asset.blob_key,
          filename: asset.filename,
          contentType: asset.content_type,
          sizeBytes: expectedSize,
          contentHash: asset.content_hash,
        },
        body,
      );
    } catch (error) {
      if (error instanceof AssetIntegrityError) {
        return { state: "integrity_error", message: error.message };
      }
      throw error;
    }
    return { state: "uploaded" };
  }

  async status(assetId: string) {
    const asset = await this.getContent(assetId);
    if (!asset) {
      return null;
    }
    const publication = await this.dependencies.publications.status({
      targetKind: "asset",
      targetObjectId: asset.object_id,
    });
    return {
      content_available: await this.dependencies.storage.verify(
        asset.blob_key,
        Number(asset.size_bytes),
        asset.content_hash,
      ),
      public_url:
        publication.active && publication.public_id
          ? `${this.dependencies.assetOrigin}/a/${publication.public_id}`
          : null,
      published: publication.active,
    };
  }

  async delete(assetId: string): Promise<AssetDeleteResult> {
    const blobKey = await this.dependencies.assets.delete(assetId);
    if (!blobKey) {
      return { state: "in_use" };
    }
    await this.dependencies.storage.delete(blobKey);
    return { state: "deleted" };
  }
}
