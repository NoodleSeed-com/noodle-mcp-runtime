import { randomUUID } from 'node:crypto';
import {
  ACTIVITY_MAX_BATCH_BYTES,
  ACTIVITY_MAX_EVENT_BYTES,
  type ActivityEnvelope,
  type ActivityLease,
  type ActivityOutbox,
  type ModuleSqlTransaction,
} from '@noodle-borg/module';
import type { Pool } from 'pg';
export class PostgresActivityOutbox implements ActivityOutbox {
  constructor(private readonly pool: Pool) {}
  async append(event: ActivityEnvelope, transaction?: ModuleSqlTransaction): Promise<void> {
    const encoded = JSON.stringify(event);
    if (Buffer.byteLength(encoded) > ACTIVITY_MAX_EVENT_BYTES)
      throw new Error('Activity event exceeds bound');
    await (transaction ?? this.pool).query(
      'INSERT INTO activity_outbox (id,org_slug,app_slug,environment,expires_at,event) VALUES ($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT (id) DO NOTHING',
      [event.id, event.tenant.org, event.tenant.app, event.tenant.env, event.expiresAt, encoded],
    );
  }
  async claim(org: string, limit: number): Promise<ActivityLease> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 50)
      throw new Error('Invalid activity claim limit');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const leaseToken = randomUUID();
      const clock = await client.query<{ deadline: Date }>(
        "SELECT clock_timestamp() + interval '60 seconds' AS deadline",
      );
      const leaseExpiresAt = clock.rows[0]!.deadline.toISOString();
      const result = await client.query<{ event: ActivityEnvelope }>(
        `SELECT event FROM activity_outbox WHERE org_slug=$1 AND expires_at>clock_timestamp() AND (lease_expires_at IS NULL OR lease_expires_at<=clock_timestamp()) ORDER BY last_attempt_at ASC NULLS FIRST,id LIMIT $2 FOR UPDATE SKIP LOCKED`,
        [org, limit],
      );
      const events: ActivityEnvelope[] = [];
      for (const row of result.rows) {
        if (
          Buffer.byteLength(
            JSON.stringify({ leaseToken, leaseExpiresAt, events: [...events, row.event] }),
          ) > ACTIVITY_MAX_BATCH_BYTES
        )
          break;
        events.push(row.event);
      }
      if (events.length)
        await client.query(
          'UPDATE activity_outbox SET lease_token=$1,lease_expires_at=$2,last_attempt_at=clock_timestamp() WHERE org_slug=$3 AND id=ANY($4::uuid[])',
          [leaseToken, leaseExpiresAt, org, events.map((event) => event.id)],
        );
      await client.query('COMMIT');
      return { leaseToken, leaseExpiresAt, events };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async ack(org: string, leaseToken: string, eventIds: readonly string[]): Promise<number> {
    if (eventIds.length > 50) throw new Error('Invalid activity ack limit');
    const result = await this.pool.query(
      'DELETE FROM activity_outbox WHERE org_slug=$1 AND lease_token=$2 AND lease_expires_at>clock_timestamp() AND id=ANY($3::uuid[])',
      [org, leaseToken, eventIds],
    );
    return result.rowCount ?? 0;
  }
  async purgeExpired(limit = 500): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500)
      throw new Error('Invalid purge limit');
    await this.pool.query(
      'DELETE FROM activity_turn_ordinals WHERE session_id IN (SELECT session_id FROM activity_turn_ordinals WHERE expires_at<=clock_timestamp() LIMIT $1)',
      [limit],
    );
    const result = await this.pool.query(
      'DELETE FROM activity_outbox WHERE id IN (SELECT id FROM activity_outbox WHERE expires_at<=clock_timestamp() ORDER BY expires_at LIMIT $1 FOR UPDATE SKIP LOCKED)',
      [limit],
    );
    return result.rowCount ?? 0;
  }
}
