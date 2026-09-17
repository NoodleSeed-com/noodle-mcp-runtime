import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PostgresAssistantStore } from '@noodle-borg/assistant-gateway/postgres';
import type { ActivityEnvelope, AdmissionContext, AdmissionGate } from '@noodle-borg/module';
import { ensureActivityOutboxSchema } from '@noodle-borg/observability';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createServiceHandler, InMemoryAssistantStore, ServerRegistry } from '../src/index.js';
import { EMBEDDED_ASSISTANT_MANIFEST } from './embedded-assistant-fixtures.js';

const ORIGIN = 'https://app.example.com';
const TENANT = { org: 'acme', app: 'support', env: 'test' };
const MANIFEST = EMBEDDED_ASSISTANT_MANIFEST.replace(
  '      kind: openai-compatible',
  '      kind: openai-compatible\n      transport: responses',
);
const POLICY = {
  version: 1,
  policyId: 'test-policy',
  maxModelRequests: 2,
  maxInputTokens: 16384,
  maxCompletionTokens: 1024,
  maxTokensPerTurn: 2048,
  maxRequestBytes: 131072,
  maxToolCallsPerTurn: 1,
  timeoutMs: 30000,
  maxTurnMs: 90000,
  reasoningEffort: 'none',
} as const;

for (const kind of ['memory', 'postgres'] as const)
  describe.skipIf(kind === 'postgres' && !process.env.DATABASE_URL_TEST)(
    `${kind} durable admitted model turns`,
    () => {
      const pool =
        kind === 'postgres'
          ? new Pool({ connectionString: process.env.DATABASE_URL_TEST })
          : undefined;
      beforeAll(async () => {
        if (pool) {
          await new PostgresAssistantStore(pool).ensureSchema();
          await ensureActivityOutboxSchema(pool);
        }
      });
      afterAll(async () => {
        await pool?.end();
      });
      const servers: Server[] = [];
      afterEach(async () => {
        await Promise.all(
          servers
            .splice(0)
            .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
        );
      });

      async function start(
        admissionGate: AdmissionGate = async () => ({ allow: true, assistantExecution: POLICY }),
        mode:
          | 'answer'
          | 'partial'
          | 'count-failure'
          | 'tool'
          | 'oversized-second'
          | 'disconnect' = 'answer',
      ) {
        const registry = new ServerRegistry();
        const scope = { level: 'env' as const, ...TENANT };
        for (const [kind, name, value] of [
          ['variable', 'ASSISTANT_MODEL_BASE_URL', 'https://models.example/v1'],
          ['variable', 'ASSISTANT_MODEL', 'test-model'],
          ['secret', 'ASSISTANT_MODEL_API_KEY', 'test-only-provider-key'],
        ] as const)
          await registry.configStore.setConfigValue({ kind, scope, name, value });
        const deployed = await registry.deploy(TENANT, MANIFEST, { accessMode: 'public' });
        if (!deployed.ok) throw new Error(JSON.stringify(deployed.errors));
        const store = pool ? new PostgresAssistantStore(pool) : new InMemoryAssistantStore();
        let completeProvider: (() => void) | undefined;
        const providerRequests: { url: string; body: Record<string, unknown> }[] = [];
        const modelFetch = async (url: string | URL | Request, init?: RequestInit) => {
          providerRequests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
          if (String(url).endsWith('/input_tokens'))
            return mode === 'count-failure'
              ? new Response('', { status: 503 })
              : Response.json({
                  input_tokens:
                    mode === 'oversized-second' && providerRequests.length > 2 ? 16385 : 42,
                });
          if (mode === 'disconnect')
            return new Response(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(
                    new TextEncoder().encode(
                      'data: {"type":"response.output_text.delta","delta":"partial"}\n\n',
                    ),
                  );
                  completeProvider = () => {
                    controller.enqueue(
                      new TextEncoder().encode(
                        'data: {"type":"response.completed","response":{"output":[{"type":"message","content":[{"type":"output_text","text":"partial"}]}]}}\n\n',
                      ),
                    );
                    controller.close();
                  };
                },
              }),
              { headers: { 'content-type': 'text/event-stream' } },
            );
          if (mode === 'partial')
            return new Response(
              'data: {"type":"response.output_text.delta","delta":"partial"}\n\n',
              { headers: { 'content-type': 'text/event-stream' } },
            );
          if (
            (mode === 'tool' || mode === 'oversized-second') &&
            providerRequests.filter((r) => !r.url.endsWith('/input_tokens')).length === 1
          )
            return Response.json({
              output: [
                { type: 'function_call', call_id: 'call-1', name: 'lookup', arguments: '{}' },
              ],
            });
          return Response.json({
            output: [{ type: 'message', content: [{ type: 'output_text', text: 'answer' }] }],
          });
        };
        const activity: ActivityEnvelope[] = [];
        const activityOutbox = {
          append: async (event: ActivityEnvelope) => {
            activity.push(event);
          },
          claim: async () => ({ leaseToken: '', leaseExpiresAt: '', events: activity }),
          ack: async () => 0,
          purgeExpired: async () => 0,
        };
        const server = createServer(
          createServiceHandler(registry, {
            assistantStore: store,
            activityOutbox,
            requireAssistantExecutionAdmission: true,
            assistantModelFetch: modelFetch,
            ...(admissionGate === undefined ? {} : { admissionGate }),
          }),
        );
        servers.push(server);
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        let base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        const created = await fetch(
          `${base}/v1/orgs/acme/apps/support/envs/test/assistant/clients`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: 'backend' }),
          },
        );
        expect(created.status).toBe(201);
        const client = await created.json();
        const basic = Buffer.from(`${client.id}:${client.clientSecret}`).toString('base64');
        return {
          base,
          store,
          providerRequests,
          activity,
          completeProvider() {
            if (!completeProvider) throw new Error('provider has not started');
            completeProvider();
          },
          async restart() {
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
            const restarted = createServer(
              createServiceHandler(registry, {
                assistantStore: pool ? new PostgresAssistantStore(pool) : store,
                activityOutbox,
                admissionGate,
                requireAssistantExecutionAdmission: true,
                assistantModelFetch: modelFetch,
              }),
            );
            servers.push(restarted);
            await new Promise<void>((resolve) => restarted.listen(0, '127.0.0.1', resolve));
            base = `http://127.0.0.1:${(restarted.address() as AddressInfo).port}`;
          },
          deploymentId: deployed.deploymentId,
          async mint(id = 'member', scopes: readonly string[] = ['account.read']) {
            return fetch(`${base}/v1/assistant/sessions`, {
              method: 'POST',
              headers: { authorization: `Basic ${basic}`, 'content-type': 'application/json' },
              body: JSON.stringify({
                origin: ORIGIN,
                user: { id, scopes },
              }),
            });
          },
          async request(
            token: string | undefined,
            path: string,
            body: unknown,
            origin = ORIGIN,
            signal?: AbortSignal,
          ) {
            return fetch(`${base}/v1/assistant/${path}`, {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                origin,
                ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
              },
              body: JSON.stringify(body),
              ...(signal ? { signal } : {}),
            });
          },
        };
      }

      it('requires an explicit admission gate at startup', () => {
        expect(() =>
          createServiceHandler(new ServerRegistry(), { requireAssistantExecutionAdmission: true }),
        ).toThrow();
      });
      it('recovers preparation, rejects altered bodies, and admits exactly one concurrent tool-and-answer sequence', async () => {
        const seen: AdmissionContext[] = [];
        const app = await start(async (context) => {
          seen.push(context);
          return { allow: true, assistantExecution: POLICY };
        }, 'tool');
        const { token, sessionId, endpoints } = await (await app.mint()).json();
        expect(endpoints.operations).toBe(`${app.base}/v1/assistant/operations`);
        expect(endpoints.operationStatus).toBe(`${app.base}/v1/assistant/operations/status`);
        const turn = { message: 'lookup', suggestions: true };
        const requestKey = randomUUID();
        const prepared = await app.request(token, 'operations', { requestKey, turn });
        expect(prepared.status).toBe(201);
        const operation = await prepared.json();
        expect(await (await app.request(token, 'operations', { requestKey, turn })).json()).toEqual(
          operation,
        );
        expect(
          (await app.request(token, 'operations', { requestKey, turn: { message: 'different' } }))
            .status,
        ).toBe(409);
        expect(
          (
            await app.request(token, 'turns', {
              ...turn,
              message: 'altered',
              operationId: operation.operationId,
            })
          ).status,
        ).toBe(409);
        const responses = await Promise.all(
          Array.from({ length: 8 }, () =>
            app.request(token, 'turns', { ...turn, operationId: operation.operationId }),
          ),
        );
        expect(responses.filter((r) => r.status === 200)).toHaveLength(1);
        expect(responses.filter((r) => r.status === 409)).toHaveLength(7);
        const stream = await responses.find((r) => r.status === 200)?.text();
        expect(stream).toContain('answer');
        expect(stream).toContain(operation.operationId);
        expect(app.providerRequests.map((r) => r.url.split('/').at(-1))).toEqual([
          'input_tokens',
          'responses',
          'input_tokens',
          'responses',
        ]);
        const admitted = seen.filter((c) => c.assistantExecution);
        expect(admitted).toHaveLength(1);
        expect(app.activity.map((e) => e.kind)).toEqual([
          'assistant.turn.started',
          'assistant.turn.finished',
        ]);
        expect(admitted[0]).toMatchObject({
          ...TENANT,
          subject: 'member',
          serverVersion: '1.0.0',
          assistantExecution: {
            sessionId,
            operationId: operation.operationId,
            clientId: expect.stringMatching(/^embed_/),
            requestDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
            model: {
              source: 'operator',
              transport: 'responses',
              baseUrl: 'https://models.example/v1',
              model: 'test-model',
            },
          },
        });
        expect(
          (await app.request(token, 'turns', { ...turn, operationId: operation.operationId }))
            .status,
        ).toBe(409);
        expect(
          await (
            await app.request(token, 'operations/status', { operationId: operation.operationId })
          ).json(),
        ).toMatchObject({ status: 'completed' });
        expect(
          (await app.request(token, 'operations', { requestKey: randomUUID(), turn })).status,
        ).toBe(201);
      });
      it('refuses unkeyed turns, resume, suggestions, interactions and doctor without provider I/O', async () => {
        const app = await start();
        const { token } = await (await app.mint()).json();
        for (const [path, body] of [
          ['turns', { message: 'hello' }],
          ['turns', { resume: true }],
          ['suggestions', {}],
          ['interactions', {}],
          ['tool-confirmations', {}],
        ] as const)
          expect((await app.request(token, path, body)).status).toBe(403);
        const doctor = await fetch(
          `${app.base}/v1/orgs/acme/apps/support/envs/test/assistant/doctor`,
          { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
        );
        expect(doctor.status).toBe(403);
        expect(app.providerRequests).toHaveLength(0);
      });
      it.each([
        'partial',
        'count-failure',
        'oversized-second',
      ] as const)('retains claimed operation after %s and refuses every replay', async (mode) => {
        const app = await start(undefined, mode);
        const { token } = await (await app.mint()).json();
        const turn = { message: 'hello' };
        const prepared = await app.request(token, 'operations', { requestKey: randomUUID(), turn });
        expect(prepared.status).toBe(201);
        const { operationId } = await prepared.json();
        const response = await app.request(token, 'turns', { ...turn, operationId });
        expect(await response.text()).toContain('event: error');
        const requests = app.providerRequests.length;
        if (mode === 'oversized-second') expect(requests).toBe(3);
        await app.restart();
        expect((await app.request(token, 'turns', { ...turn, operationId })).status).toBe(409);
        expect(app.providerRequests).toHaveLength(requests);
        expect(app.activity.map((e) => e.kind)).toEqual([
          'assistant.turn.started',
          'assistant.turn.finished',
        ]);
        expect(app.activity.at(-1)?.payload).toMatchObject({ outcome: 'failed' });
        expect(
          await (await app.request(token, 'operations/status', { operationId })).json(),
        ).toMatchObject({ status: 'unknown' });
      });
      it.each([
        'denied',
        'missing-policy',
        'invalid-policy',
        'throw',
      ] as const)('fails %s before count or inference and preserves native origin authorization', async (mode) => {
        const app = await start(async (context) => {
          if (!context.assistantExecution) return { allow: true };
          if (mode === 'throw') throw new Error('private policy details');
          if (mode === 'denied') return { allow: false, reason: 'old_candidate' };
          if (mode === 'missing-policy') return { allow: true };
          return { allow: true, assistantExecution: { ...POLICY, maxInputTokens: -1 } };
        });
        const { token } = await (await app.mint()).json();
        const turn = { message: 'hello' };
        expect(
          (
            await app.request(
              token,
              'operations',
              { requestKey: randomUUID(), turn },
              'https://wrong.example',
            )
          ).status,
        ).toBe(403);
        const prepared = await app.request(token, 'operations', { requestKey: randomUUID(), turn });
        expect(prepared.status).toBe(201);
        const { operationId } = await prepared.json();
        expect((await app.request(token, 'turns', { ...turn, operationId })).status).toBe(403);
        expect((await app.request(token, 'turns', { ...turn, operationId })).status).toBe(409);
        expect(app.providerRequests).toHaveLength(0);
      });

      it('retains a committed claim when the browser disconnects and never starts another provider sequence', async () => {
        const app = await start(undefined, 'disconnect');
        const { token } = await (await app.mint()).json();
        const turn = { message: 'hello' };
        const { operationId } = await (
          await app.request(token, 'operations', { requestKey: randomUUID(), turn })
        ).json();
        const controller = new AbortController();
        const response = await app.request(
          token,
          'turns',
          { ...turn, operationId },
          ORIGIN,
          controller.signal,
        );
        const reader = response.body?.getReader();
        if (!reader) throw new Error('missing response stream');
        await reader.read();
        controller.abort();
        await reader.cancel().catch(() => undefined);
        expect((await app.request(token, 'turns', { ...turn, operationId })).status).toBe(409);
        expect(
          await (await app.request(token, 'operations/status', { operationId })).json(),
        ).toMatchObject({ status: 'executing' });
        app.completeProvider();
        for (let n = 0; n < 20; n++) {
          const status = await (
            await app.request(token, 'operations/status', { operationId })
          ).json();
          if (status.status === 'completed') break;
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        expect(
          await (await app.request(token, 'operations/status', { operationId })).json(),
        ).toMatchObject({ status: 'completed' });
        expect(app.providerRequests).toHaveLength(2);
        expect(app.activity.map((e) => e.kind)).toEqual([
          'assistant.turn.started',
          'assistant.turn.finished',
        ]);
        expect(app.activity.at(-1)?.payload).toMatchObject({ outcome: 'completed' });
      });
    },
  );
