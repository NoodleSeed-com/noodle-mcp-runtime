import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AdmissionContext, AdmissionGate } from '@noodle-borg/module';
import { afterEach, describe, expect, it } from 'vitest';
import { createServiceHandler, InMemoryAssistantStore, ServerRegistry } from '../src/index.js';
import { EMBEDDED_ASSISTANT_MANIFEST } from './embedded-assistant-fixtures.js';

const ORIGIN = 'https://app.example.com';
const TENANT = { org: 'acme', app: 'support', env: 'test' };
const MANIFEST = EMBEDDED_ASSISTANT_MANIFEST.replace(
  '  - name: lookup\n',
  '  - name: lookup\n    authorization: { requiredScopes: [account.read] }\n',
);

describe('configured assistant admission', () => {
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(
      servers
        .splice(0)
        .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
  });

  async function start(admissionGate?: AdmissionGate) {
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
    const store = new InMemoryAssistantStore();
    const server = createServer(
      createServiceHandler(registry, {
        assistantStore: store,
        ...(admissionGate === undefined ? {} : { admissionGate }),
      }),
    );
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const created = await fetch(`${base}/v1/orgs/acme/apps/support/envs/test/assistant/clients`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'backend' }),
    });
    expect(created.status).toBe(201);
    const client = await created.json();
    const basic = Buffer.from(`${client.id}:${client.clientSecret}`).toString('base64');
    return {
      base,
      store,
      deploymentId: deployed.deploymentId,
      async mint(id = 'member', scopes: readonly string[] = ['account.read']) {
        return fetch(`${base}/v1/assistant/sessions`, {
          method: 'POST',
          headers: { authorization: `Basic ${basic}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            origin: ORIGIN,
            user: { id, scopes },
            org: 'forged',
            app: 'forged',
            env: 'forged',
          }),
        });
      },
      async request(token: string | undefined, path: string, body: unknown, origin = ORIGIN) {
        return fetch(`${base}/v1/assistant/${path}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin,
            ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
          },
          body: JSON.stringify(body),
        });
      },
    };
  }

  it('denies mint using the authenticated client tenant and asserted backend subject', async () => {
    const seen: AdmissionContext[] = [];
    const app = await start(async (context) => {
      seen.push(context);
      return { allow: context.subject === 'member', reason: 'grant_required' };
    });
    const denied = await app.mint('outsider');
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ code: 'assistant_admission_denied' });
    expect(seen).toEqual([
      expect.objectContaining({
        ...TENANT,
        subject: 'outsider',
        method: 'assistant/sessions',
        category: 'protocol',
        deploymentId: expect.any(String),
      }),
    ]);
    expect((await app.mint()).status).toBe(201);
  });

  it('admits each apps operation once with its actual category and denies execution', async () => {
    const seen: AdmissionContext[] = [];
    const app = await start(async (context) => {
      seen.push(context);
      return context.category === 'execute'
        ? { allow: false, reason: 'execution_disabled' }
        : { allow: true };
    });
    const { token } = await (await app.mint()).json();
    seen.length = 0;
    expect((await app.request(token, 'apps', { method: 'tools/list', params: {} })).status).toBe(
      200,
    );
    expect(
      (
        await app.request(token, 'apps', {
          method: 'resources/read',
          params: { uri: 'docs://account/guide' },
        })
      ).status,
    ).toBe(200);
    const denied = await app.request(token, 'apps', {
      method: 'tools/call',
      params: { name: 'lookup', arguments: {} },
      subject: 'forged',
      org: 'forged',
    });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ code: 'assistant_admission_denied' });
    expect(seen.map(({ method, category, name }) => ({ method, category, name }))).toEqual([
      { method: 'tools/list', category: 'discovery', name: undefined },
      { method: 'resources/read', category: 'read', name: 'docs://account/guide' },
      { method: 'tools/call', category: 'execute', name: 'lookup' },
    ]);
    expect(
      seen.every(
        (context) =>
          context.subject === 'member' &&
          context.org === 'acme' &&
          context.app === 'support' &&
          context.env === 'test',
      ),
    ).toBe(true);
  });

  it('rechecks changed policy on existing sessions for every protected route', async () => {
    let allowed = true;
    const seen: AdmissionContext[] = [];
    const app = await start(async (context) => {
      seen.push(context);
      return allowed ? { allow: true } : { allow: false, reason: 'revoked' };
    });
    const { token } = await (await app.mint()).json();
    expect(
      (
        await app.request(token, 'apps', {
          method: 'tools/call',
          params: { name: 'lookup', arguments: {} },
        })
      ).status,
    ).toBe(200);
    allowed = false;
    seen.length = 0;
    for (const path of [
      'apps',
      'turns',
      'transcript',
      'suggestions',
      'interactions',
      'tool-confirmations',
    ]) {
      const denied = await app.request(token, path, { method: 'tools/list', params: {} });
      expect(denied.status, path).toBe(403);
      expect(await denied.json()).toMatchObject({ code: 'assistant_admission_denied' });
    }
    expect(seen.map(({ method, category }) => ({ method, category }))).toEqual([
      { method: 'tools/list', category: 'discovery' },
      { method: 'assistant/turns', category: 'execute' },
      { method: 'assistant/transcript', category: 'read' },
      { method: 'assistant/suggestions', category: 'execute' },
      { method: 'assistant/interactions', category: 'execute' },
      { method: 'assistant/tool-confirmations', category: 'execute' },
    ]);
  });

  it('rejects missing session and wrong origin before the configured gate', async () => {
    const seen: AdmissionContext[] = [];
    const app = await start(async (context) => {
      seen.push(context);
      return { allow: true };
    });
    const { token } = await (await app.mint()).json();
    seen.length = 0;
    const body = { method: 'tools/list', params: {} };
    expect((await app.request(undefined, 'apps', body)).status).toBe(401);
    expect((await app.request(token, 'apps', body, 'https://other.example.com')).status).toBe(403);
    expect((await app.request(token, 'transcript', {}, 'https://other.example.com')).status).toBe(
      403,
    );
    expect(seen).toEqual([]);
  });

  it('does not project an anonymous session identifier as a verified subject', async () => {
    const seen: AdmissionContext[] = [];
    const app = await start(async (context) => {
      seen.push(context);
      return { allow: context.subject === 'member', reason: 'identity_required' };
    });
    const instant = new Date();
    const anonymous = await app.store.createSession({
      clientId: 'public-fixture',
      tenant: TENANT,
      deploymentId: app.deploymentId,
      origin: ORIGIN,
      caller: { subject: 'member', identityKind: 'anonymous' },
      createdAt: instant.toISOString(),
      expiresAt: new Date(instant.getTime() + 60_000).toISOString(),
      absoluteExpiresAt: new Date(instant.getTime() + 60_000).toISOString(),
    });
    const denied = await app.request(anonymous.token, 'apps', { method: 'tools/list', params: {} });
    expect(denied.status).toBe(403);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.subject).toBeUndefined();
  });

  it('returns bounded denial when configured admission throws at mint or operation time', async () => {
    let unavailable = false;
    const app = await start(async () => {
      if (unavailable) throw new Error('private callback details');
      return { allow: true };
    });
    const { token } = await (await app.mint()).json();
    unavailable = true;
    for (const response of [
      await app.mint(),
      await app.request(token, 'apps', { method: 'tools/list', params: {} }),
      await app.request(token, 'transcript', {}),
    ]) {
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        error: 'assistant request denied',
        code: 'assistant_admission_denied',
      });
    }
  });

  it('preserves native scope authorization when admission allows', async () => {
    const app = await start(async () => ({ allow: true }));
    const { token } = await (await app.mint('member', ['unrelated'])).json();
    const listed = await app.request(token, 'apps', { method: 'tools/list', params: {} });
    expect(
      (await listed.json()).tools.some((tool: { name: string }) => tool.name === 'lookup'),
    ).toBe(false);
    const denied = await app.request(token, 'apps', {
      method: 'tools/call',
      params: { name: 'lookup', arguments: {} },
    });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: 'tool forbidden' });
  });

  it('keeps authenticated embeds working when no extra gate is configured', async () => {
    const app = await start();
    const { token } = await (await app.mint()).json();
    const result = await app.request(token, 'apps', {
      method: 'tools/call',
      params: { name: 'lookup', arguments: {} },
    });
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ content: expect.any(Array) });
  });
});
