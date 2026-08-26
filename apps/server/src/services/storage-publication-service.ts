import { createHash } from "node:crypto";
import type {
  PublicationObjectClaim,
  PublicationWriteAuthorization,
} from "@context-use/database/publication";
import type { PublicationArtifactReceipt } from "@context-use/shared";
import { projectPublicMarkdown } from "../public-markdown.ts";
import type { PublicationClaims } from "../storage/broker-contracts.ts";
import { BlobAlreadyExistsError, type BlobStorageBackend, type StoredBlob } from "../storage.ts";

export class StoragePublicationService {
  constructor(
    private readonly dependencies: {
      storage: BlobStorageBackend;
      claims: PublicationClaims;
    },
  ) {}

  async materialize(allocationId: string): Promise<void> {
    const claim = await this.dependencies.claims.claimIntent({ intentId: allocationId });
    const written = await this.writeClaimedArtifact(claim);
    if (!written.receipt) {
      return;
    }
    await this.dependencies.claims.finalizeIntent({
      claimToken: written.claimToken,
      receipt: written.receipt,
    });
  }

  private async writeClaimedArtifact(
    claim: PublicationObjectClaim<PublicationWriteAuthorization>,
  ): Promise<{
    claimToken: string;
    receipt: PublicationArtifactReceipt | null;
  }> {
    const { storage } = this.dependencies;
    if (claim.finalized) {
      const size = exactNumber({ value: claim.body_size_bytes, maximum: 5_000_000_000 });
      if (!(await storage.verify(claim.body_object_key, size, claim.body_content_hash))) {
        throw new Error("Finalized publication artifact is unavailable or corrupt");
      }
      return { claimToken: claim.claim_token, receipt: null };
    }

    const authorization = claim.authorization;
    const page = authorization.target_kind === "page";
    let body: ReadableStream<Uint8Array> | null;
    let sizeBytes: number;
    let contentHash: string;
    let observedPublicIds: string[];
    if (page) {
      const source = await new Response(
        await verifiedSourceBody({ storage, authorization }),
      ).text();
      const projected = projectPublicMarkdown(source, authorization.target_projection);
      observedPublicIds = projected.observedPublicIds;
      if (
        !sameUuidSet({
          left: observedPublicIds,
          right: authorization.projected_target_public_ids,
        })
      ) {
        throw new Error("Public projection did not observe the exact frozen UUID set");
      }
      const bytes = Buffer.from(projected.bodyMarkdown, "utf8");
      sizeBytes = bytes.byteLength;
      contentHash = createHash("sha256").update(bytes).digest("hex");
      body = new Blob([bytes]).stream();
    } else {
      sizeBytes = exactNumber({
        value: authorization.source_body_size_bytes,
        maximum: 5_000_000_000,
      });
      contentHash = authorization.source_body_content_hash;
      observedPublicIds = authorization.projected_target_public_ids;
      const source = await verifiedSourceBody({ storage, authorization });
      body = new Response(source).body;
    }
    const maximum = exactNumber({
      value: authorization.max_body_size_bytes,
      maximum: 5_000_000_000,
    });
    if (sizeBytes > maximum) {
      throw new Error("Publication artifact exceeds its frozen size limit");
    }
    const stored: StoredBlob = {
      id: authorization.artifact_id,
      blobKey: authorization.body_object_key,
      filename: page ? `${authorization.artifact_id}.md` : authorization.public_filename!,
      contentType: page ? "text/markdown; charset=utf-8" : authorization.public_content_type!,
      sizeBytes,
      contentHash,
    };
    try {
      await storage.writeOnce(stored, body);
    } catch (error) {
      if (!(error instanceof BlobAlreadyExistsError)) {
        throw error;
      }
    }
    if (!(await storage.verify(stored.blobKey, sizeBytes, contentHash))) {
      throw new Error("Conditional publication artifact write did not retain the exact bytes");
    }

    const receipt: PublicationArtifactReceipt = page
      ? {
          intent_id: authorization.intent_id,
          target_kind: "page",
          body_size_bytes: sizeBytes,
          body_content_hash: contentHash,
          public_title: authorization.public_title,
          public_summary: authorization.public_summary,
          public_last_edited_at: authorization.public_last_edited_at,
          projected_target_public_ids: authorization.projected_target_public_ids,
          observed_public_uuid_tokens: observedPublicIds,
          projection_receipt_hash: authorization.projection_receipt_hash,
        }
      : {
          intent_id: authorization.intent_id,
          target_kind: "asset",
          body_size_bytes: sizeBytes,
          body_content_hash: contentHash,
          public_filename: authorization.public_filename,
          public_content_type: authorization.public_content_type,
          ...(authorization.public_width === null
            ? {}
            : { public_width: authorization.public_width }),
          ...(authorization.public_height === null
            ? {}
            : { public_height: authorization.public_height }),
          ...(authorization.public_duration_seconds === null
            ? {}
            : { public_duration_seconds: authorization.public_duration_seconds }),
        };
    return { claimToken: claim.claim_token, receipt };
  }
}

export async function materializePublicationArtifact(input: {
  storage: BlobStorageBackend;
  claims: PublicationClaims;
  allocationId: string;
}): Promise<void> {
  await new StoragePublicationService(input).materialize(input.allocationId);
}

export function exactNumber({
  value,
  maximum,
}: {
  value: number | string;
  maximum: number;
}): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0 || result > maximum) {
    throw new Error("Publication artifact size is not safely representable");
  }
  return result;
}

async function verifiedSourceBody({
  storage,
  authorization,
}: {
  storage: BlobStorageBackend;
  authorization: PublicationWriteAuthorization;
}): Promise<BodyInit> {
  const size = exactNumber({
    value: authorization.source_body_size_bytes,
    maximum: 5_000_000_000,
  });
  if (
    !(await storage.verify(
      authorization.source_body_object_key,
      size,
      authorization.source_body_content_hash,
    ))
  ) {
    throw new Error("Publication source bytes are unavailable or corrupt");
  }
  return storage.read(authorization.source_body_object_key);
}

function sameUuidSet({ left, right }: { left: string[]; right: string[] }): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}
