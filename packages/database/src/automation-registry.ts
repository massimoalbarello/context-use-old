import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";

export type AutomationRegistration = {
  id: string;
  key: string;
  name: string;
  instructions_document_id: string;
  state_document_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  disabled_at: Date | string | null;
};

export type RegisterAutomationInput = {
  id?: string;
  key: string;
  name: string;
  instructions_document_id: string;
  state_document_id: string | null;
};

export class AutomationRegistryIdentityConflictError extends Error {
  constructor(readonly key: string) {
    super(`Automation registry identity conflicts for key ${key}`);
    this.name = "AutomationRegistryIdentityConflictError";
  }
}

const RETURNING = `
  id,key,name,instructions_document_id,state_document_id,
  created_at,updated_at,disabled_at
`;

async function transaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export class AutomationRegistryRepository {
  constructor(private readonly pool: Pool) {}

  async byKey(key: string): Promise<AutomationRegistration | null> {
    const result = await this.pool.query<AutomationRegistration>(
      `SELECT ${RETURNING} FROM automation_registry WHERE key=$1`,
      [key],
    );
    return result.rows[0] ?? null;
  }

  async listActive(): Promise<AutomationRegistration[]> {
    const result = await this.pool.query<AutomationRegistration>(
      `SELECT ${RETURNING}
       FROM automation_registry
       WHERE disabled_at IS NULL
       ORDER BY key,id`,
    );
    return result.rows;
  }

  async list(): Promise<AutomationRegistration[]> {
    const result = await this.pool.query<AutomationRegistration>(
      `SELECT ${RETURNING}
       FROM automation_registry
       ORDER BY disabled_at NULLS FIRST,key,id`,
    );
    return result.rows;
  }

  /**
   * Adopt one exact operational contract without ever silently retargeting an
   * existing key. Retries preserve the registry id and all owner state,
   * including its presentation and enabled/disabled choice.
   */
  async register(input: RegisterAutomationInput): Promise<AutomationRegistration> {
    return transaction(this.pool, async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock_shared(hashtextextended('filesystem-hypermedia-corpus-transition',0))",
      );
      const result = await client.query<AutomationRegistration>(
        `INSERT INTO automation_registry(
           id,key,name,instructions_document_id,state_document_id
         ) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (key) DO UPDATE
         SET updated_at=now()
         WHERE automation_registry.instructions_document_id=excluded.instructions_document_id
           AND automation_registry.state_document_id IS NOT DISTINCT FROM excluded.state_document_id
         RETURNING ${RETURNING}`,
        [input.id ?? randomUUID(), input.key, input.name,
          input.instructions_document_id, input.state_document_id],
      );
      const registration = result.rows[0];
      if (!registration) throw new AutomationRegistryIdentityConflictError(input.key);
      return registration;
    });
  }
}
