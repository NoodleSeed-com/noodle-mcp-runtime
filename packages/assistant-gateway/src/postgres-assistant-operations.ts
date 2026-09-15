import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import {
  type AssistantOperation,
  type AssistantOperationInput,
  type AssistantOperationScope,
  type AssistantOperationStore,
  type AssistantOperationTerminal,
  assistantOperationScopeKey,
} from './assistant-operations.js';

/** Logged independently of disposable sessions. Never cascade session cleanup into this ledger. */
export class PostgresAssistantOperations implements AssistantOperationStore {
  constructor(readonly pool: Pool) {}
  async ensureSchema(): Promise<void> {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS assistant_operations (
      id uuid PRIMARY KEY, session_id text NOT NULL, request_key uuid NOT NULL,
      scope_hash text NOT NULL, scope jsonb NOT NULL, request_digest text NOT NULL,
      status text NOT NULL CHECK (status IN ('prepared','executing','completed','denied','unknown')),
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (session_id, request_key)
    )`);
    await this.pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS assistant_operations_active_session_idx
      ON assistant_operations(session_id) WHERE status IN ('prepared','executing','unknown')`);
  }
  async prepare(input: AssistantOperationInput): Promise<AssistantOperation | undefined> {
    // Fresh statement snapshot observes a winner committed while INSERT waited for its unique key.
    await this.pool.query(
      `INSERT INTO assistant_operations (id,session_id,request_key,scope_hash,request_digest,scope,status)
      VALUES ($1,$2,$3,$4,$5,$6::jsonb,'prepared') ON CONFLICT DO NOTHING`,
      [
        randomUUID(),
        input.sessionId,
        input.requestKey,
        assistantOperationScopeKey(input),
        input.requestDigest,
        JSON.stringify({
          sessionId: input.sessionId,
          clientId: input.clientId,
          tenant: input.tenant,
          deploymentId: input.deploymentId,
          serverVersion: input.serverVersion,
          origin: input.origin,
        }),
      ],
    );
    const result = await this.pool.query<AssistantOperation>(
      `SELECT id AS "operationId", status FROM assistant_operations
      WHERE session_id=$1 AND request_key=$2 AND scope_hash=$3 AND request_digest=$4`,
      [input.sessionId, input.requestKey, assistantOperationScopeKey(input), input.requestDigest],
    );
    return result.rows[0];
  }
  async get(id: string, scope: AssistantOperationScope): Promise<AssistantOperation | undefined> {
    const result = await this.pool.query<AssistantOperation>(
      `SELECT id AS "operationId", status FROM assistant_operations
      WHERE id=$1 AND scope_hash=$2`,
      [id, assistantOperationScopeKey(scope)],
    );
    return result.rows[0];
  }
  async claim(
    id: string,
    input: AssistantOperationScope & { readonly requestDigest: string },
  ): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE assistant_operations SET status='executing', updated_at=now()
      WHERE id=$1 AND scope_hash=$2 AND request_digest=$3 AND status='prepared'`,
      [id, assistantOperationScopeKey(input), input.requestDigest],
    );
    return result.rowCount === 1;
  }
  async finish(
    id: string,
    scope: AssistantOperationScope,
    status: AssistantOperationTerminal,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE assistant_operations SET status=$3, updated_at=now()
      WHERE id=$1 AND scope_hash=$2 AND status='executing'`,
      [id, assistantOperationScopeKey(scope), status],
    );
  }
}
