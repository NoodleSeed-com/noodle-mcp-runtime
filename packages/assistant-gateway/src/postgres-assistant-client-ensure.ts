import type { Pool } from 'pg';
import {
  assistantClientProvisioning,
  type EnsureAssistantClientInput,
  type EnsureAssistantClientResult,
  replayAssistantClient,
} from './assistant-client-ensure.js';
import type { AssistantClientRecord } from './assistant-store.js';

export async function ensureAssistantClientSchema(pool: Pool): Promise<void> {
  await pool.query(`ALTER TABLE assistant_clients
    ADD COLUMN IF NOT EXISTS provisioning_key_hash text,
    ADD COLUMN IF NOT EXISTS provisioning_fingerprint text`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS assistant_clients_provisioning_key_idx
    ON assistant_clients (org_slug, app_slug, environment, provisioning_key_hash)
    WHERE provisioning_key_hash IS NOT NULL`);
}

export async function ensurePostgresAssistantClient(
  pool: Pool,
  input: EnsureAssistantClientInput,
): Promise<EnsureAssistantClientResult> {
  const provisioning = assistantClientProvisioning(input);
  const connection = await pool.connect();
  try {
    await connection.query('BEGIN');
    let created = false;
    if (input.creation) {
      const result = await connection.query(
        `INSERT INTO assistant_clients
        (id,name,org_slug,app_slug,environment,deployment_id,allowed_origins,secret_hash,created_at,provisioning_key_hash,provisioning_fingerprint)
        VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11) ON CONFLICT DO NOTHING`,
        [
          input.id,
          input.name.trim(),
          input.tenant.org,
          input.tenant.app,
          input.tenant.env,
          input.creation.deploymentId,
          JSON.stringify(input.creation.allowedOrigins),
          provisioning.secretHash,
          input.now.toISOString(),
          provisioning.keyHash,
          provisioning.fingerprint,
        ],
      );
      created = result.rowCount === 1;
    }
    // A fresh READ COMMITTED statement observes a conflicting INSERT's committed winner.
    // Lock the receipt against concurrent rotation/revocation until this decision commits.
    const result = await connection.query<ClientRow>(
      `SELECT * FROM assistant_clients WHERE id=$1 OR
      (org_slug=$2 AND app_slug=$3 AND environment=$4 AND provisioning_key_hash=$5)
      ORDER BY id FOR UPDATE`,
      [input.id, input.tenant.org, input.tenant.app, input.tenant.env, provisioning.keyHash],
    );
    const row = result.rows[0];
    let receipt: EnsureAssistantClientResult;
    if (!row) receipt = { disposition: 'missing' };
    else if (result.rows.length !== 1) receipt = { disposition: 'conflict' };
    else {
      const client: AssistantClientRecord = {
        id: row.id,
        name: row.name,
        tenant: { org: row.org_slug, app: row.app_slug, env: row.environment },
        deploymentId: row.deployment_id,
        allowedOrigins: row.allowed_origins,
        secretHash: row.secret_hash,
        createdAt: row.created_at.toISOString(),
        ...(row.revoked_at ? { revokedAt: row.revoked_at.toISOString() } : {}),
      };
      receipt = replayAssistantClient(
        input,
        provisioning,
        client,
        row.provisioning_key_hash && row.provisioning_fingerprint
          ? { keyHash: row.provisioning_key_hash, fingerprint: row.provisioning_fingerprint }
          : undefined,
      );
      if (created && receipt.disposition === 'replayed')
        receipt = { disposition: 'created', client };
    }
    await connection.query('COMMIT');
    return receipt;
  } catch (error) {
    await connection.query('ROLLBACK');
    throw error;
  } finally {
    connection.release();
  }
}
interface ClientRow {
  id: string;
  name: string;
  org_slug: string;
  app_slug: string;
  environment: string;
  deployment_id: string;
  allowed_origins: string[];
  secret_hash: string;
  created_at: Date;
  revoked_at: Date | null;
  provisioning_key_hash: string | null;
  provisioning_fingerprint: string | null;
}
