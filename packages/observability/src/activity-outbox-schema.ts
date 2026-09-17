import type { Pool } from 'pg';
/** Migration-owner only. Runtime construction deliberately performs no DDL. */
export async function ensureActivityOutboxSchema(pool: Pick<Pool, 'query'>): Promise<void> {
  await pool.query(`CREATE TABLE IF NOT EXISTS activity_outbox (
 id uuid PRIMARY KEY, org_slug text NOT NULL, app_slug text NOT NULL, environment text NOT NULL,
 expires_at timestamptz NOT NULL, event jsonb NOT NULL,
 last_attempt_at timestamptz, lease_token uuid, lease_expires_at timestamptz,
 CHECK (octet_length(event::text) <= 270336)
 )`);
  await pool.query(
    'CREATE TABLE IF NOT EXISTS activity_turn_ordinals (session_id text PRIMARY KEY,ordinal integer NOT NULL,expires_at timestamptz NOT NULL)',
  );
  await pool.query(
    'CREATE INDEX IF NOT EXISTS activity_outbox_claim ON activity_outbox (org_slug,last_attempt_at NULLS FIRST)',
  );
  await pool.query(
    'CREATE INDEX IF NOT EXISTS activity_outbox_expiry ON activity_outbox (expires_at)',
  );
}
