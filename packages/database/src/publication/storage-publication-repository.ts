import { randomUUID } from "node:crypto";
import type { PublicationArtifactReceipt } from "@context-use/shared";
import type { Pool } from "pg";
import type {
  AssetPublicationWriteAuthorization,
  PagePublicationWriteAuthorization,
  PublicationObjectClaim,
  PublicationWriteAuthorization,
  StorageRoute,
  StoredPublicationProjectionTarget,
} from "./models.ts";
import { requireRow } from "./rows.ts";

type StoredClaim<Authorization> = {
  claim_token: string;
  finalized: boolean;
  artifact_id: string;
  body_object_key: string;
  body_size_bytes: number | string | null;
  body_content_hash: string | null;
  authorization: Authorization | null;
};

export type ClaimPublicationIntentInput = {
  intentId: string;
  requestedClaimToken?: string;
};

export type FinalizePublicationIntentInput = {
  claimToken: string;
  receipt: PublicationArtifactReceipt;
};

export class StoragePublicationRepository {
  constructor(private readonly storagePool: Pool) {}

  private toClaim<Authorization>(
    row: StoredClaim<Authorization> | undefined,
  ): PublicationObjectClaim<Authorization> {
    const claim = requireRow({ row, description: "Publication object claim" });
    if (claim.finalized) {
      if (claim.body_size_bytes === null || claim.body_content_hash === null) {
        throw new Error("Finalized publication claim is missing its byte receipt");
      }
      return {
        claim_token: claim.claim_token,
        finalized: true,
        artifact_id: claim.artifact_id,
        body_object_key: claim.body_object_key,
        body_size_bytes: claim.body_size_bytes,
        body_content_hash: claim.body_content_hash,
      };
    }
    if (!claim.authorization) {
      throw new Error("Pending publication claim is missing its authorization");
    }
    return {
      claim_token: claim.claim_token,
      finalized: false,
      artifact_id: claim.artifact_id,
      body_object_key: claim.body_object_key,
      authorization: claim.authorization,
    };
  }

  async claimIntent({
    intentId,
    requestedClaimToken = randomUUID(),
  }: ClaimPublicationIntentInput): Promise<PublicationObjectClaim<PublicationWriteAuthorization>> {
    const result = await this.storagePool.query<StoredClaim<unknown>>(
      `SELECT claim_token,finalized,artifact_id,body_object_key,
         body_size_bytes,body_content_hash,"authorization"
       FROM claim_publication_artifact($1,$2)`,
      [intentId, requestedClaimToken],
    );
    const row = requireRow({ row: result.rows[0], description: "Publication object claim" });
    const storedAuthorization = row.authorization as
      | (Omit<PagePublicationWriteAuthorization, "target_projection"> & {
          target_projection: StoredPublicationProjectionTarget[];
        })
      | AssetPublicationWriteAuthorization
      | null;
    if (storedAuthorization?.target_kind === "page") {
      const { target_projection, ...authorization } = storedAuthorization;
      return this.toClaim<PagePublicationWriteAuthorization>({
        ...row,
        authorization: {
          ...authorization,
          target_projection: target_projection.map(({ target_document_id, ...target }) => ({
            ...target,
            target_object_id: target_document_id,
          })),
        },
      });
    }
    return this.toClaim<PublicationWriteAuthorization>({
      ...row,
      authorization: storedAuthorization,
    });
  }

  async finalizeIntent({ claimToken, receipt }: FinalizePublicationIntentInput): Promise<void> {
    const page = receipt.target_kind === "page";
    await this.storagePool.query(
      `SELECT finalize_publication_artifact_claim(
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16
       )`,
      [
        claimToken,
        receipt.intent_id,
        receipt.target_kind,
        receipt.body_size_bytes,
        receipt.body_content_hash,
        page ? receipt.public_title : null,
        page ? receipt.public_summary : null,
        page ? receipt.public_last_edited_at : null,
        page ? null : receipt.public_filename,
        page ? null : receipt.public_content_type,
        page ? null : (receipt.public_width ?? null),
        page ? null : (receipt.public_height ?? null),
        page ? null : (receipt.public_duration_seconds ?? null),
        page ? receipt.projected_target_public_ids : [],
        page ? receipt.observed_public_uuid_tokens : [],
        page ? receipt.projection_receipt_hash : null,
      ],
    );
  }

  async resolve(representationToken: string): Promise<StorageRoute | null> {
    const result = await this.storagePool.query<StorageRoute>(
      `SELECT resource_kind,representation_token,body_object_key,
         body_size_bytes,body_content_hash
       FROM resolve_storage_route($1)`,
      [representationToken],
    );
    if (result.rows.length > 1) {
      throw new Error("Canonical representation token resolves ambiguously");
    }
    return result.rows[0] ?? null;
  }
}
