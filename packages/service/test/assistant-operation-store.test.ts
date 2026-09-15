import { randomUUID } from 'node:crypto';
import { InMemoryAssistantStore } from '@noodle-borg/assistant-gateway/portable';
import { PostgresAssistantStore } from '@noodle-borg/assistant-gateway/postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const databaseUrl = process.env.DATABASE_URL_TEST;
for (const kind of ['memory', 'postgres'] as const) {
  describe.skipIf(kind === 'postgres' && !databaseUrl)(
    `${kind} durable assistant operations`,
    () => {
      const pool = kind === 'postgres' ? new Pool({ connectionString: databaseUrl }) : undefined;
      const store = pool ? new PostgresAssistantStore(pool) : new InMemoryAssistantStore();
      const peer = pool ? new PostgresAssistantStore(pool) : store;
      beforeAll(async () => {
        if (store instanceof PostgresAssistantStore) await store.ensureSchema();
      });
      afterAll(async () => {
        await pool?.end();
      });
      const input = () => ({
        sessionId: randomUUID(),
        clientId: 'embed-client',
        tenant: { org: 'org', app: 'app', env: 'test' },
        deploymentId: 'deployment',
        origin: 'https://app.example.com',
        serverVersion: '1',
        requestKey: randomUUID(),
        requestDigest: 'a'.repeat(64),
      });
      it('recovers preparation by correlation key without changing its server identity or digest', async () => {
        const request = input();
        const first = await store.operations.prepare(request);
        expect(first?.status).toBe('prepared');
        expect(first?.operationId).toMatch(/^[a-f0-9-]{36}$/);
        expect(await peer.operations.prepare(request)).toEqual(first);
        expect(
          await peer.operations.prepare({ ...request, requestDigest: 'b'.repeat(64) }),
        ).toBeUndefined();
        expect(
          await peer.operations.prepare({ ...request, deploymentId: 'other' }),
        ).toBeUndefined();
      });
      it('admits only one concurrent operation for a session and only one executor', async () => {
        const request = input();
        const results = await Promise.all(
          Array.from({ length: 12 }, (_, n) =>
            (n % 2 ? peer : store).operations.prepare({ ...request, requestKey: randomUUID() }),
          ),
        );
        const prepared = results.filter((value) => value !== undefined);
        expect(prepared).toHaveLength(1);
        const operationId = prepared[0]?.operationId ?? 'missing';
        const claims = await Promise.all(
          Array.from({ length: 12 }, (_, n) =>
            (n % 2 ? peer : store).operations.claim(operationId, request),
          ),
        );
        expect(claims.filter(Boolean)).toHaveLength(1);
        expect(await peer.operations.get(operationId, request)).toMatchObject({
          status: 'executing',
        });
      });
      it.each([
        'completed',
        'unknown',
        'denied',
      ] as const)('never reclaims %s after store recreation', async (status) => {
        const request = input();
        const prepared = await store.operations.prepare(request);
        const operationId = prepared?.operationId ?? 'missing';
        expect(await store.operations.claim(operationId, request)).toBe(true);
        await store.operations.finish(operationId, request, status);
        const restarted = pool ? new PostgresAssistantStore(pool) : peer;
        expect(await restarted.operations.claim(operationId, request)).toBe(false);
        expect(await restarted.operations.get(operationId, request)).toMatchObject({ status });
        expect(await restarted.operations.prepare(request)).toMatchObject({ operationId, status });
        expect(await restarted.operations.prepare({ ...request, requestKey: randomUUID() }))[
          status === 'unknown' ? 'toBeUndefined' : 'toBeDefined'
        ]();
      });
      it('binds every read and claim to the immutable session target and payload', async () => {
        const request = input();
        const operation = await store.operations.prepare(request);
        for (const change of [
          { sessionId: randomUUID() },
          { clientId: 'other' },
          { origin: 'https://other.example' },
          { deploymentId: 'other' },
          { serverVersion: '2' },
          { tenant: { ...request.tenant, org: 'other' } },
        ]) {
          expect(
            await peer.operations.get(operation?.operationId ?? 'missing', {
              ...request,
              ...change,
            }),
          ).toBeUndefined();
          expect(
            await peer.operations.claim(operation?.operationId ?? 'missing', {
              ...request,
              ...change,
            }),
          ).toBe(false);
        }
        expect(
          await peer.operations.claim(operation?.operationId ?? 'missing', {
            ...request,
            requestDigest: 'b'.repeat(64),
          }),
        ).toBe(false);
        expect(await peer.operations.claim(operation?.operationId ?? 'missing', request)).toBe(
          true,
        );
        expect(await peer.operations.claim(operation?.operationId ?? 'missing', request)).toBe(
          false,
        );
        if (pool) {
          const table = await pool.query(
            "SELECT relpersistence FROM pg_class WHERE oid='assistant_operations'::regclass",
          );
          expect(table.rows[0].relpersistence).toBe('p');
          const restarted = new PostgresAssistantStore(pool);
          expect(
            await restarted.operations.claim(operation?.operationId ?? 'missing', request),
          ).toBe(false);
        }
      });
    },
  );
}
