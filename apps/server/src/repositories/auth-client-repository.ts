import type { Pool } from "pg";

export class AuthClientRepository {
  constructor(private readonly pool: Pool) {}

  async hasActiveMcpLineage({
    clientId,
    ownerUserId,
    sessionId,
    scope,
    resource,
  }: {
    clientId: string;
    ownerUserId: string;
    sessionId: string;
    scope: string;
    resource: string;
  }): Promise<boolean> {
    const lineage = await this.pool.query(
      `SELECT 1
       FROM "oauthClient" client
       JOIN "oauthConsent" consent
         ON consent."clientId"=client."clientId"
        AND consent."userId"=$2
       JOIN "session" owner_session
         ON owner_session.id=$3
        AND owner_session."userId"=$2
       WHERE client."clientId"=$1
         AND coalesce(client.disabled,false)=false
         AND consent.scopes @> $4::jsonb
         AND consent.resources @> $5::jsonb
       LIMIT 1`,
      [clientId, ownerUserId, sessionId, JSON.stringify([scope]), JSON.stringify([resource])],
    );
    return Boolean(lineage.rowCount);
  }

  async ownerPasskeys(ownerUserId: string) {
    const passkeys = await this.pool.query<{
      id: string;
      name: string | null;
      createdAt: Date;
      deviceType: string;
      backedUp: boolean;
    }>(
      `SELECT id,name,"createdAt","deviceType","backedUp"
       FROM passkey WHERE "userId"=$1 ORDER BY "createdAt",id`,
      [ownerUserId],
    );
    return passkeys.rows;
  }

  async connectedClients({
    ownerUserId,
    page,
    pageSize,
  }: {
    ownerUserId: string;
    page: number;
    pageSize: number;
  }) {
    const offset = (page - 1) * pageSize;
    const [clients, count] = await Promise.all([
      this.pool.query(
        `SELECT client."clientId" AS client_id,client.name,client.uri,
                client."softwareVersion" AS version,client."createdAt" AS created_at,
                consent."updatedAt" AS approved_at,tokens.last_connected_at
         FROM "oauthConsent" consent
         JOIN "oauthClient" client ON client."clientId"=consent."clientId"
         LEFT JOIN (
           SELECT "clientId","userId",max("createdAt") AS last_connected_at
           FROM "oauthAccessToken"
           GROUP BY "clientId","userId"
         ) tokens ON tokens."clientId"=client."clientId" AND tokens."userId"=consent."userId"
         WHERE consent."userId"=$1
         ORDER BY coalesce(tokens.last_connected_at,consent."updatedAt") DESC,client."clientId" DESC
         LIMIT $2 OFFSET $3`,
        [ownerUserId, pageSize, offset],
      ),
      this.pool.query<{ total: string }>(
        `SELECT count(*) AS total FROM "oauthConsent" WHERE "userId"=$1`,
        [ownerUserId],
      ),
    ]);
    const total = Number(count.rows[0]?.total ?? 0);
    return {
      items: clients.rows,
      page,
      page_size: pageSize,
      total,
      total_pages: Math.ceil(total / pageSize),
    };
  }

  async clientPreview(clientId: string) {
    const result = await this.pool.query(
      `SELECT "clientId" AS client_id,name,uri,"redirectUris" AS redirect_uris,
              "softwareId" AS software_id,"softwareVersion" AS software_version
       FROM "oauthClient" WHERE "clientId"=$1 AND coalesce(disabled,false)=false`,
      [clientId],
    );
    return result.rows[0] ?? null;
  }

  async revokeClient({ clientId, ownerUserId }: { clientId: string; ownerUserId: string }) {
    const removed = await this.pool.query(
      `DELETE FROM "oauthClient" oauth_client
       USING "oauthConsent" consent
       WHERE oauth_client."clientId"=$1
         AND consent."clientId"=oauth_client."clientId"
         AND consent."userId"=$2
       RETURNING oauth_client."clientId"`,
      [clientId, ownerUserId],
    );
    return Boolean(removed.rowCount);
  }
}
