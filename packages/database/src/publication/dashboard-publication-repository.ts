import { randomUUID } from "node:crypto";
import type { PublicationIntentInput } from "@context-use/shared";
import type { Pool } from "pg";
import type {
  DashboardPublicationStatus,
  PublicationIntent,
  PublicationPrincipal,
} from "./models.ts";
import { requireRow } from "./rows.ts";

export type BeginPublicationInput = {
  intent: PublicationIntentInput;
  principal: PublicationPrincipal;
  intentId?: string;
};

export type CancelPublicationInput = {
  intentId: string;
  principal: PublicationPrincipal;
};

export type GetPublicationStatusInput = {
  targetKind: "page" | "asset";
  targetObjectId: string;
};

export class PublicationRepository {
  constructor(private readonly dashboardPool: Pool) {}

  /** Reuse intentId after a lost response to replay the same immutable plan. */
  async begin({
    intent,
    principal,
    intentId = randomUUID(),
  }: BeginPublicationInput): Promise<PublicationIntent> {
    const result = await this.dashboardPool.query<PublicationIntent>(
      `SELECT id,action,target_kind,target_document_id AS target_object_id,expected_revision_id,
         candidate_public_id,expires_at
       FROM begin_publication_intent($1,$2,$3,$4,$5,$6,$7)`,
      [
        intentId,
        intent.action,
        intent.target_kind,
        intent.target_object_id,
        "expected_revision_id" in intent ? intent.expected_revision_id : null,
        principal.ownerUserId,
        principal.sessionId,
      ],
    );
    return requireRow({ row: result.rows[0], description: "Publication intent" });
  }

  async cancel({ intentId, principal }: CancelPublicationInput): Promise<void> {
    await this.dashboardPool.query("SELECT cancel_publication_intent($1,$2,$3)", [
      intentId,
      principal.ownerUserId,
      principal.sessionId,
    ]);
  }

  async status({
    targetKind,
    targetObjectId,
  }: GetPublicationStatusInput): Promise<DashboardPublicationStatus> {
    const result = await this.dashboardPool.query<DashboardPublicationStatus>(
      `SELECT public_id,published_revision_id,published_revision_number,active
       FROM get_dashboard_publication_status($1,$2)`,
      [targetKind, targetObjectId],
    );
    return requireRow({
      row: result.rows[0],
      description: "Dashboard publication status",
    });
  }
}
