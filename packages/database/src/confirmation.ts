import type { Pool } from "pg";

export type ConfirmationIntentKind = "publication" | "knowledge_export" | "page_deletion";

export type ConfirmationPasskey = {
  id: string;
  name: string | null;
  publicKey: string;
  userId: string;
  credentialID: string;
  counter: number;
  transports: string | null;
  createdAt: Date | null;
};

export type VerifiedPasskey = {
  credentialId: string;
  expectedCounter: number;
  newCounter: number;
};

type PublicationConfirmationIntentBase = {
  id: string;
  action: "publish" | "unpublish";
  target_kind: "page" | "asset";
  target_id: string;
  version_id: string | null;
  public_path: string | null;
  owner_user_id: string;
  session_id: string;
  challenge: string | null;
  expires_at: Date | string;
};

export type LegacyPublicationConfirmationIntent = PublicationConfirmationIntentBase & {
  intent_store: "legacy";
};

export type PathlessPublicationConfirmationIntent = PublicationConfirmationIntentBase & {
  intent_store: "pathless";
  public_path: null;
};

export type PublicationConfirmationIntent =
  | LegacyPublicationConfirmationIntent
  | PathlessPublicationConfirmationIntent;

type PublicationConfirmationIntentRow = Partial<PublicationConfirmationIntentBase> & {
  reserved_store: "legacy" | "pathless" | null;
  intent_store: "legacy" | "pathless" | null;
};

export class ConfirmationRepository {
  constructor(private readonly pool: Pool) {}

  async issueChallenge(kind: ConfirmationIntentKind, intentId: string, challenge: string): Promise<void> {
    await this.pool.query(
      "SELECT issue_confirmation_challenge($1,$2,$3)",
      [kind, intentId, challenge],
    );
  }

  async passkeys(ownerUserId: string): Promise<ConfirmationPasskey[]> {
    const result = await this.pool.query<ConfirmationPasskey>(
      `SELECT id,name,"publicKey","userId","credentialID",counter,transports,"createdAt"
       FROM passkey WHERE "userId"=$1 ORDER BY "createdAt"`,
      [ownerUserId],
    );
    return result.rows;
  }

  async publicationIntent(id: string): Promise<PublicationConfirmationIntent | null> {
    const result = await this.pool.query<PublicationConfirmationIntentRow>(
      `WITH reservation AS (
         SELECT intent_store::text AS reserved_store
         FROM publication_intent_id_reservations
         WHERE intent_id=$1
       ), intent AS (
         SELECT 'legacy'::text AS intent_store,legacy.id,legacy.action,
           legacy.target_kind,legacy.target_id,legacy.version_id,
           legacy.public_path,legacy.owner_user_id,legacy.session_id,
           legacy.expires_at
         FROM publication_intents legacy
         WHERE legacy.id=$1
         UNION ALL
         SELECT 'pathless'::text AS intent_store,pathless.id,pathless.action,
           pathless.target_kind,pathless.target_document_id AS target_id,
           pathless.expected_revision_id AS version_id,NULL::text AS public_path,
           pathless.owner_user_id,pathless.session_id,pathless.expires_at
         FROM pathless_publication_intents pathless
         WHERE pathless.id=$1
       )
       SELECT reservation.reserved_store,intent.intent_store,intent.id,
         intent.action,intent.target_kind,
         intent.target_id,intent.version_id,intent.public_path,
         intent.owner_user_id,intent.session_id,ledger.challenge,intent.expires_at
       FROM reservation
       FULL JOIN intent ON true
       LEFT JOIN confirmation_challenges ledger
         ON ledger.intent_kind='publication' AND ledger.intent_id=intent.id
       `,
      [id],
    );
    if (!result.rows.length) return null;
    if (result.rows.length !== 1) {
      throw new Error("Publication intent UUID resolves to an ambiguous family");
    }
    const { reserved_store, ...intent } = result.rows[0]!;
    if (!intent.id) {
      if (reserved_store === "legacy" && intent.intent_store === null) return null;
      throw new Error("Publication intent UUID reservation has no live family");
    }
    if (!reserved_store || !intent.intent_store || reserved_store !== intent.intent_store) {
      throw new Error("Publication intent UUID family does not match its reservation");
    }
    return intent as PublicationConfirmationIntent;
  }

  async exportIntent(id: string) {
    const result = await this.pool.query(
      `SELECT intent.id,intent.owner_user_id,intent.session_id,ledger.challenge,
        intent.expires_at,intent.confirmed_at,intent.download_started_at
       FROM knowledge_export_intents intent
       LEFT JOIN confirmation_challenges ledger
         ON ledger.intent_kind='knowledge_export' AND ledger.intent_id=intent.id
       WHERE intent.id=$1`,
      [id],
    );
    return result.rows[0] ?? null;
  }

  async pageDeletionIntent(id: string) {
    const result = await this.pool.query(
      `SELECT intent.id,intent.page_id,intent.expected_version_id,
        intent.owner_user_id,intent.session_id,ledger.challenge,intent.expires_at
       FROM page_deletion_intents intent
       LEFT JOIN confirmation_challenges ledger
         ON ledger.intent_kind='page_deletion' AND ledger.intent_id=intent.id
       WHERE intent.id=$1`,
      [id],
    );
    return result.rows[0] ?? null;
  }

  async confirmPublication(
    intentId: string,
    principal: { ownerUserId: string; sessionId: string },
    passkey: VerifiedPasskey,
  ): Promise<void> {
    await this.pool.query(
      "SELECT confirm_publication_intent($1,$2,$3,$4,$5,$6)",
      [intentId, principal.ownerUserId, principal.sessionId, passkey.credentialId,
        passkey.expectedCounter, passkey.newCounter],
    );
  }

  async confirmExport(
    intentId: string,
    principal: { ownerUserId: string; sessionId: string },
    passkey: VerifiedPasskey,
  ): Promise<void> {
    await this.pool.query(
      "SELECT confirm_knowledge_export_intent($1,$2,$3,$4,$5,$6)",
      [intentId, principal.ownerUserId, principal.sessionId, passkey.credentialId,
        passkey.expectedCounter, passkey.newCounter],
    );
  }

  async confirmPageDeletion(
    intentId: string,
    principal: { ownerUserId: string; sessionId: string },
    passkey: VerifiedPasskey,
  ): Promise<void> {
    await this.pool.query(
      "SELECT confirm_page_deletion_intent($1,$2,$3,$4,$5,$6)",
      [intentId, principal.ownerUserId, principal.sessionId, passkey.credentialId,
        passkey.expectedCounter, passkey.newCounter],
    );
  }

  async claimExport(intentId: string, principal: { ownerUserId: string; sessionId: string }): Promise<void> {
    await this.pool.query(
      "SELECT claim_knowledge_export_download($1,$2,$3)",
      [intentId, principal.ownerUserId, principal.sessionId],
    );
  }

  async completeExportDownload(
    intentId: string,
    principal: { ownerUserId: string; sessionId: string },
  ): Promise<void> {
    await this.pool.query(
      "SELECT complete_knowledge_export_download($1,$2,$3)",
      [intentId, principal.ownerUserId, principal.sessionId],
    );
  }
}
