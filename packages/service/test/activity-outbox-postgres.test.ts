import { randomUUID } from 'node:crypto';
import type { ActivityEnvelope } from '@noodle-borg/module';
import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { PostgresActivityOutbox } from '../../observability/src/activity-outbox-postgres.js';
import { ensureActivityOutboxSchema } from '../../observability/src/activity-outbox-schema.js';

const pool = new Pool({ connectionString: process.env.CORE_ACTIVITY_TEST_DATABASE_URL });
const enabled = !!process.env.CORE_ACTIVITY_TEST_DATABASE_URL;
const test = enabled ? it : it.skip;
beforeAll(async () => {
  if (enabled) await ensureActivityOutboxSchema(pool);
});
afterAll(async () => {
  await pool.end();
});
function event(org: string): ActivityEnvelope {
  return {
    schemaVersion: 1,
    id: randomUUID(),
    kind: 'assistant.turn.started',
    occurredAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    tenant: { org, app: 'app', env: 'test' },
    deploymentId: 'd',
    payload: {
      sessionId: 's',
      turnId: randomUUID(),
      ordinal: 1,
      startedAt: new Date().toISOString(),
      channel: 'private_test',
      userText: 'Hello',
      userTextTruncated: false,
    },
  };
}
test('leases isolate tenants, redeliver stable IDs, survive reconstruction, and delete ack/expired payloads', async () => {
  const org = randomUUID(),
    store = new PostgresActivityOutbox(pool),
    a = event(org),
    b = event(org);
  await store.append(a);
  await store.append(b);
  const claims = await Promise.all([store.claim(org, 1), store.claim(org, 1)]);
  expect(claims[0]!.events[0]!.id).not.toBe(claims[1]!.events[0]!.id);
  expect((await store.claim(org, 50)).events).toHaveLength(0);
  expect(await store.ack('foreign', claims[0]!.leaseToken, [a.id, b.id])).toBe(0);
  await pool.query(
    "UPDATE activity_outbox SET lease_expires_at=now()-interval '1 second' WHERE org_slug=$1",
    [org],
  );
  expect(await store.ack(org, claims[0]!.leaseToken, [a.id, b.id])).toBe(0);
  const replay = await new PostgresActivityOutbox(pool).claim(org, 50);
  expect(replay.events.map((e) => e.id).sort()).toEqual([a.id, b.id].sort());
  expect(await store.ack(org, replay.leaseToken, [a.id, b.id])).toBe(2);
  expect(await store.ack(org, replay.leaseToken, [a.id, b.id])).toBe(0);
  const expired = { ...event(org), expiresAt: new Date(0).toISOString() };
  await store.append(expired);
  expect((await store.claim(org, 50)).events).toHaveLength(0);
  expect(await store.purgeExpired()).toBeGreaterThanOrEqual(1);
  expect(
    (await pool.query('SELECT id FROM activity_outbox WHERE org_slug=$1', [org])).rowCount,
  ).toBe(0);
});
test('late committing inserts are claimable and attempted poison prefixes cannot starve fresh rows', async () => {
  const org = randomUUID(),
    store = new PostgresActivityOutbox(pool),
    client = await pool.connect();
  try {
    await client.query('BEGIN');
    const late = event(org);
    await store.append(late, client);
    const fresh = event(org);
    await store.append(fresh);
    const first = await store.claim(org, 1);
    expect(first.events[0]?.id).toBe(fresh.id);
    await client.query('COMMIT');
    await pool.query(
      "UPDATE activity_outbox SET lease_expires_at=now()-interval '1 second' WHERE org_slug=$1",
      [org],
    );
    expect((await store.claim(org, 1)).events[0]?.id).toBe(late.id);
  } finally {
    client.release();
    await pool.query('DELETE FROM activity_outbox WHERE org_slug=$1', [org]);
  }
});

test('commits history and terminal payload together and rolls both back on failure', async () => {
  const { PostgresAssistantStore } = await import('@noodle-borg/assistant-gateway/postgres');
  const sessions = new PostgresAssistantStore(pool);
  await sessions.ensureSchema();
  const org = randomUUID(),
    outbox = new PostgresActivityOutbox(pool),
    now = new Date();
  const client = await sessions.createClient({
    name: 'activity',
    tenant: { org, app: 'a', env: 'test' },
    deploymentId: 'd',
    allowedOrigins: ['https://example.com'],
    now,
  });
  const { session, token } = await sessions.createSession({
    clientId: client.client.id,
    tenant: { org, app: 'a', env: 'test' },
    deploymentId: 'd',
    origin: 'https://example.com',
    caller: { subject: 'test', identityKind: 'customer' },
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 60000).toISOString(),
    absoluteExpiresAt: new Date(now.getTime() + 120000).toISOString(),
  });
  const record = event(org);
  await expect(
    sessions.appendHistory(session.id, [{ role: 'user', content: 'rollback' }], async (tx) => {
      await outbox.append(record, tx);
      throw new Error('rollback');
    }),
  ).rejects.toThrow('rollback');
  expect((await sessions.getSession(token, now))?.history).toHaveLength(0);
  expect((await outbox.claim(org, 50)).events).toHaveLength(0);
  await sessions.appendHistory(session.id, [{ role: 'user', content: 'committed' }], (tx) =>
    outbox.append(record, tx),
  );
  expect((await sessions.getSession(token, now))?.history[0]?.content).toBe('committed');
  expect((await outbox.claim(org, 50)).events[0]?.id).toBe(record.id);
  expect(await sessions.nextActivityOrdinal(session.id)).toBe(1);
  expect(await new PostgresAssistantStore(pool).nextActivityOrdinal(session.id)).toBe(2);
  await pool.query('DELETE FROM activity_outbox WHERE org_slug=$1', [org]);
});

test('a separate process can commit an event that is delivered after it exits', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const org = randomUUID(),
    record = event(org);
  const script = `import pg from './packages/observability/node_modules/pg/lib/index.js';const {Pool}=pg;import {PostgresActivityOutbox} from './packages/observability/dist/index.js';const pool=new Pool({connectionString:process.env.CORE_ACTIVITY_TEST_DATABASE_URL});await new PostgresActivityOutbox(pool).append(JSON.parse(process.argv[1]));await pool.end();`;
  await promisify(execFile)(process.execPath, [
    '--input-type=module',
    '-e',
    script,
    JSON.stringify(record),
  ]);
  const store = new PostgresActivityOutbox(pool),
    lease = await store.claim(org, 50);
  expect(lease.events[0]?.id).toBe(record.id);
  await store.ack(org, lease.leaseToken, [record.id]);
});
