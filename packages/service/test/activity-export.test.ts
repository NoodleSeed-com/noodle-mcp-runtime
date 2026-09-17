import { describe, expect, it } from 'vitest';
import { activityEnvelopeSchema, boundActivityText } from '../src/routes/activity-schema.js';

const base = {
  schemaVersion: 1,
  id: 'b45ecbba-7bb1-4b3e-9ba6-853cb187ffde',
  occurredAt: '2026-09-18T00:00:00.000Z',
  expiresAt: '2026-10-18T00:00:00.000Z',
  tenant: { org: 'o', app: 'a', env: 'test' },
  deploymentId: 'd',
};
const turn = {
  sessionId: 's',
  turnId: 't',
  ordinal: 1,
  startedAt: base.occurredAt,
  channel: 'private_test',
};
describe('activity contract', () => {
  it('accepts each bounded event kind', () => {
    for (const [kind, payload] of [
      ['assistant.turn.started', { ...turn, userText: 'Hello', userTextTruncated: false }],
      [
        'assistant.turn.finished',
        {
          ...turn,
          assistantText: '[Source](https://example.com)',
          assistantTextTruncated: false,
          outcome: 'completed',
          durationMs: 5,
        },
      ],
      [
        'knowledge.search.finished',
        {
          invocationId: 'i',
          componentName: 'docs',
          toolName: 'search_docs',
          query: 'hello',
          channel: 'external_mcp',
          hits: [{ id: 'h', title: 'T', excerpt: 'Evidence', sourceKind: 'document' }],
          durationMs: 2,
          outcome: 'success',
        },
      ],
    ])
      expect(activityEnvelopeSchema.safeParse({ ...base, kind, payload }).success).toBe(true);
  });
  it('rejects versions, malformed payloads, oversized text and unknown fields', () => {
    const event = {
      ...base,
      kind: 'assistant.turn.started',
      payload: { ...turn, userText: 'x', userTextTruncated: false },
    };
    for (const value of [
      { ...event, schemaVersion: 2 },
      { ...event, secret: 'no' },
      { ...event, payload: { ...event.payload, ordinal: 0 } },
      { ...event, payload: { ...event.payload, userText: '😀'.repeat(20000) } },
    ])
      expect(activityEnvelopeSchema.safeParse(value).success).toBe(false);
  });
  it('bounds UTF-8 without splitting a character', () => {
    expect(boundActivityText('😀'.repeat(20000))).toEqual({
      text: '😀'.repeat(16384),
      truncated: true,
    });
  });
});

it('authorizes the export before claim and validates its bounded request', async () => {
  const { createServer } = await import('node:http');
  const { createServiceHandler, ServerRegistry, InMemoryControlPlaneStore } = await import(
    '../src/index.js'
  );
  const plane = new InMemoryControlPlaneStore();
  await plane.addOrgMember({
    org: 'acme',
    subject: 'owner',
    email: 'owner@example.com',
    role: 'owner',
  });
  let claims = 0;
  const server = createServer(
    createServiceHandler(new ServerRegistry(), {
      controlPlaneStore: plane,
      deployGate: {
        authorize: async (req) =>
          req.headers.authorization === 'Bearer owner'
            ? {
                ok: true as const,
                identity: { subject: 'owner', email: 'owner@example.com', superAdmin: false },
              }
            : { ok: false as const, status: 401 as const, message: 'unauthorized' },
      },
      activityOutbox: {
        append: async () => {},
        claim: async () => {
          claims++;
          return {
            leaseToken: 'b45ecbba-7bb1-4b3e-9ba6-853cb187ffde',
            leaseExpiresAt: base.expiresAt,
            events: [],
          };
        },
        ack: async () => 0,
        purgeExpired: async () => 0,
      },
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as import('node:net').AddressInfo).port;
  const post = (org: string, token: string, limit: number) =>
    fetch(`http://127.0.0.1:${port}/v1/orgs/${org}/activity/claim`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ limit }),
    });
  try {
    expect((await post('acme', 'embed-token', 50)).status).toBe(401);
    expect((await post('other', 'owner', 50)).status).toBe(403);
    expect((await post('acme', 'owner', 51)).status).toBe(400);
    const result = await post('acme', 'owner', 50);
    expect(result.status).toBe(200);
    expect(result.headers.get('cache-control')).toBe('no-store');
    expect(claims).toBe(1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it('keeps expiration maintenance enabled after capture/export is disabled', async () => {
  const { configuredActivityStores } = await import('../src/activity-runtime.js');
  const { Pool } = await import('pg');
  const pool = new Pool();
  const stores = configuredActivityStores(
    { schemaMode: 'external', activityCaptureEnabled: false },
    pool,
  );
  expect(stores.capture).toBeUndefined();
  expect(stores.retention).toBeDefined();
  await pool.end();
});
