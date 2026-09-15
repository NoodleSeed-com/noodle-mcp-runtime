import { randomBytes, randomUUID } from 'node:crypto';
import { InMemoryAssistantStore } from '@noodle-borg/assistant-gateway/portable';
import { PostgresAssistantStore } from '@noodle-borg/assistant-gateway/postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const databaseUrl = process.env.DATABASE_URL_TEST;
for (const kind of ['memory', 'postgres'] as const) {
  describe.skipIf(kind === 'postgres' && !databaseUrl)(`${kind} client ensure`, () => {
    const pool = kind === 'postgres' ? new Pool({ connectionString: databaseUrl }) : undefined;
    const store = pool ? new PostgresAssistantStore(pool) : new InMemoryAssistantStore();
    const peer = pool ? new PostgresAssistantStore(pool) : store;
    beforeAll(async () => {
      if (store instanceof PostgresAssistantStore) await store.ensureSchema();
    });
    afterAll(async () => {
      await pool?.end();
    });
    function input() {
      return {
        id: `embed_${randomUUID()}`,
        name: 'website',
        clientSecret: `nsa_${randomBytes(32).toString('base64url')}`,
        idempotencyKey: randomUUID(),
        tenant: { org: randomUUID(), app: 'app', env: 'test' },
        creation: {
          deploymentId: 'deployment-original',
          allowedOrigins: ['https://app.example.com'],
        },
        now: new Date(),
      };
    }
    it('recovers the same usable caller credential after response loss and changing deployment audit data', async () => {
      const request = input();
      await store.ensureClient(request); // Response intentionally discarded.
      const replay = await peer.ensureClient({ ...request, creation: undefined });
      expect(replay).toMatchObject({
        disposition: 'replayed',
        client: { id: request.id, deploymentId: 'deployment-original' },
      });
      expect(await store.authenticateClient(request.id, request.clientSecret)).toBeDefined();
      expect(
        await peer.ensureClient({
          ...request,
          creation: { deploymentId: 'changed', allowedOrigins: [] },
        }),
      ).toMatchObject({ disposition: 'replayed' });
      expect(await store.listClients(request.tenant)).toHaveLength(1);
      expect(JSON.stringify(replay)).not.toContain(request.clientSecret);
      expect(JSON.stringify(await store.listClients(request.tenant))).not.toContain('provisioning');
    });
    it('serializes competing independent stores on the tenant key and reads the committed winner', async () => {
      const request = input();
      const results = await Promise.all(
        Array.from({ length: 16 }, (_, n) => (n % 2 ? peer : store).ensureClient(request)),
      );
      expect(results.filter((r) => r.disposition === 'created')).toHaveLength(1);
      expect(results.filter((r) => r.disposition === 'replayed')).toHaveLength(15);
      expect(await store.listClients(request.tenant)).toHaveLength(1);
    });
    it('reserves the tenant operation key across competing different client IDs', async () => {
      const request = input();
      const second = { ...request, id: `embed_${randomUUID()}` };
      const results = await Promise.all([store.ensureClient(request), peer.ensureClient(second)]);
      expect(results.map((result) => result.disposition).sort()).toEqual(['conflict', 'created']);
      expect(await store.listClients(request.tenant)).toHaveLength(1);
      if (pool) {
        const persisted = await pool.query(
          'SELECT provisioning_key_hash, provisioning_fingerprint FROM assistant_clients WHERE org_slug=$1',
          [request.tenant.org],
        );
        expect(persisted.rows[0].provisioning_key_hash).toMatch(/^[a-f0-9]{64}$/);
        expect(persisted.rows[0].provisioning_fingerprint).toMatch(/^[a-f0-9]{64}$/);
        expect(JSON.stringify(persisted.rows)).not.toContain(request.idempotencyKey);
        expect(JSON.stringify(persisted.rows)).not.toContain(request.clientSecret);
      }
    });

    it('conflicts on changed identity, name, credential, key or tenant without creating another client', async () => {
      const request = input();
      await store.ensureClient(request);
      for (const changes of [
        { id: `embed_${randomUUID()}` },
        { name: 'other' },
        { clientSecret: input().clientSecret },
        { idempotencyKey: randomUUID() },
        { tenant: { ...request.tenant, org: 'other' } },
      ]) {
        expect(await peer.ensureClient({ ...request, ...changes })).toEqual({
          disposition: 'conflict',
        });
      }
      expect(await store.listClients(request.tenant)).toHaveLength(1);
    });
    it.each([
      'rotate',
      'revoke',
    ] as const)('does not resurrect a client after %s', async (action) => {
      const request = input();
      await store.ensureClient(request);
      if (action === 'rotate') await peer.rotateClient(request.id, new Date());
      else await peer.revokeClient(request.id, new Date());
      expect(await store.ensureClient(request)).toEqual({ disposition: 'unavailable' });
      expect(await store.authenticateClient(request.id, request.clientSecret)).toBeUndefined();
    });
    it('allows a recovery probe without creating a client', async () => {
      const request = input();
      expect(await store.ensureClient({ ...request, creation: undefined })).toEqual({
        disposition: 'missing',
      });
      expect(await store.listClients(request.tenant)).toHaveLength(0);
    });
  });
}

describe.skipIf(!databaseUrl)('additive client provisioning schema', () => {
  it('preserves legacy credentials and leaves their provisioning fields unset', async () => {
    const admin = new Pool({ connectionString: databaseUrl });
    const schema = `client_upgrade_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    const isolated = new Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${schema}`,
    });
    try {
      await isolated.query(
        `CREATE TABLE assistant_clients (id text PRIMARY KEY, name text NOT NULL, org_slug text NOT NULL, app_slug text NOT NULL, environment text NOT NULL, deployment_id text NOT NULL, allowed_origins jsonb NOT NULL, secret_hash text NOT NULL, created_at timestamptz NOT NULL, revoked_at timestamptz)`,
      );
      await isolated.query(
        `INSERT INTO assistant_clients VALUES ('legacy', 'web', 'org', 'app', 'test', 'old-deployment', '[]', 'old-hash', '2030-01-01', NULL)`,
      );
      const store = new PostgresAssistantStore(isolated);
      await store.ensureSchema();
      await store.ensureSchema();
      const result = await isolated.query('SELECT * FROM assistant_clients');
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]).toMatchObject({
        id: 'legacy',
        secret_hash: 'old-hash',
        deployment_id: 'old-deployment',
        provisioning_key_hash: null,
        provisioning_fingerprint: null,
      });
    } finally {
      await isolated.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  });
});
