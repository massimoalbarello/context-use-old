import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Pool } from "pg";
import { ConfirmationRepository, KnowledgeBundleRepository } from "../src/index.ts";
import { disposableDatabaseUrl } from "../src/disposable-database.ts";

const databaseUrl = await disposableDatabaseUrl();
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("passkey-bound full knowledge bundle exports", () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const dashboardPool = new Pool({
    connectionString: databaseUrl,
    max: 1,
    options: "-c role=context_use_dashboard",
  });
  const confirmationPool = new Pool({
    connectionString: databaseUrl,
    max: 1,
    options: "-c role=context_use_confirmation",
  });
  const bundles = new KnowledgeBundleRepository(dashboardPool);
  const confirmations = new ConfirmationRepository(confirmationPool);
  const intentIds: string[] = [];
  const passkeyId = `bundle-export-${randomUUID()}`;
  let createdOwner = false;

  beforeAll(async () => {
    const owner = await pool.query(
      `INSERT INTO auth."user"(id,name,email,"emailVerified")
       VALUES ('context-use-owner','Owner','owner@example.com',true)
       ON CONFLICT (id) DO NOTHING`,
    );
    createdOwner = owner.rowCount === 1;
    await pool.query(
      `INSERT INTO auth.passkey(id,"publicKey","userId","credentialID",counter,"deviceType","backedUp")
       VALUES ($1,'public-key','context-use-owner',$2,0,'multiDevice',true)`,
      [passkeyId, passkeyId],
    );
  });

  afterAll(async () => {
    await pool.query("BEGIN");
    try {
      await pool.query("SET LOCAL session_replication_role=replica");
      for (const intentId of intentIds) {
        await pool.query("DELETE FROM confirmation_challenges WHERE intent_id=$1", [intentId]);
        await pool.query("DELETE FROM knowledge_bundle_exports WHERE intent_id=$1", [intentId]);
        await pool.query("DELETE FROM knowledge_export_intents WHERE id=$1", [intentId]);
      }
      await pool.query("DELETE FROM auth.passkey WHERE id=$1", [passkeyId]);
      if (createdOwner) {
        await pool.query("DELETE FROM auth.\"user\" WHERE id='context-use-owner'");
      }
      await pool.query("COMMIT");
    } catch (error) {
      await pool.query("ROLLBACK");
      throw error;
    }
    await dashboardPool.end();
    await confirmationPool.end();
    await pool.end();
  });

  test("creates only full-bundle intents and binds confirmation and claims to the owner session", async () => {
    const principal = { ownerUserId: "context-use-owner", sessionId: `bundle-${randomUUID()}` };
    const intent = await bundles.createExportIntent(principal);
    intentIds.push(intent.id);

    expect(intent.page_count).toBeGreaterThanOrEqual(0);
    expect(intent.asset_count).toBeGreaterThanOrEqual(0);
    expect(intent.estimated_bytes).toBeGreaterThanOrEqual(0);
    expect(await bundles.exportIntent(intent.id)).toMatchObject({
      owner_user_id: principal.ownerUserId,
      session_id: principal.sessionId,
    });
    expect((await pool.query(
      "SELECT count(*)::int AS count FROM knowledge_bundle_exports WHERE intent_id=$1",
      [intent.id],
    )).rows[0]!.count).toBe(1);
    expect(await confirmations.exportIntent(intent.id)).toMatchObject({
      owner_user_id: principal.ownerUserId,
      session_id: principal.sessionId,
    });

    await confirmations.issueChallenge("knowledge_export", intent.id, randomBytes(32).toString("base64url"));
    await expect(confirmations.claimExport(intent.id, principal)).rejects.toThrow();
    await expect(confirmations.confirmExport(intent.id, { ...principal, sessionId: "wrong-session" }, {
      credentialId: passkeyId,
      expectedCounter: 0,
      newCounter: 0,
    })).rejects.toThrow();
    await confirmations.confirmExport(intent.id, principal, {
      credentialId: passkeyId,
      expectedCounter: 0,
      newCounter: 0,
    });
    await expect(confirmations.claimExport(intent.id, { ...principal, sessionId: "wrong-session" }))
      .rejects.toThrow();
    await confirmations.claimExport(intent.id, principal);

    const claimed = await bundles.exportIntent(intent.id);
    expect(claimed?.download_started_at).toBeInstanceOf(Date);
    expect(new Date(claimed!.expires_at).getTime()).toBeGreaterThan(Date.now() + 23 * 60 * 60 * 1_000);
  });

  test("discarding an unconfirmed bundle intent removes its bundle job", async () => {
    const principal = { ownerUserId: "context-use-owner", sessionId: `discard-${randomUUID()}` };
    const intent = await bundles.createExportIntent(principal);
    intentIds.push(intent.id);
    await bundles.discardExportIntent(intent.id, principal);
    expect(await bundles.exportIntent(intent.id)).toBeNull();
    expect((await pool.query(
      "SELECT count(*)::int AS count FROM knowledge_bundle_exports WHERE intent_id=$1",
      [intent.id],
    )).rows[0]!.count).toBe(0);
  });
});
