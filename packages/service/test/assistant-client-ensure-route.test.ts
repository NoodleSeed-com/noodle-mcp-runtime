import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { RequestEventInput } from '@noodle-borg/module';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createServiceHandler,
  InMemoryAssistantStore,
  InMemoryAuditStore,
  ServerRegistry,
} from '../src/index.js';
import { EMBEDDED_ASSISTANT_MANIFEST as MANIFEST } from './embedded-assistant-fixtures.js';

describe('recoverable assistant clients and exact sessions', () => {
  const servers: ReturnType<typeof createServer>[] = [];

  afterEach(async () => {
    await Promise.all(
      servers
        .splice(0)
        .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
  });

  async function start(options: NonNullable<Parameters<typeof createServiceHandler>[1]> = {}) {
    const registry = new ServerRegistry();
    const scope = { level: 'env' as const, org: 'acme', app: 'support', env: 'prod' };
    await registry.configStore.setConfigValue({
      kind: 'variable',
      scope,
      name: 'ASSISTANT_MODEL_BASE_URL',
      value: 'https://models.example/v1',
    });
    await registry.configStore.setConfigValue({
      kind: 'variable',
      scope,
      name: 'ASSISTANT_MODEL',
      value: 'acme-model',
    });
    await registry.configStore.setConfigValue({
      kind: 'secret',
      scope,
      name: 'ASSISTANT_MODEL_API_KEY',
      value: 'provider-key',
    });
    const deployed = await registry.deploy({ org: 'acme', app: 'support', env: 'prod' }, MANIFEST, {
      accessMode: 'public',
    });
    expect(deployed.ok).toBe(true);
    const modelFetch = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { role: 'assistant', content: 'Hello from Acme.' } }],
            usage: { prompt_tokens: 10, completion_tokens: 4 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    const assistantStore = new InMemoryAssistantStore();
    const audit = new InMemoryAuditStore();
    const usageEvents: RequestEventInput[] = [];
    const server = createServer(
      createServiceHandler(registry, {
        assistantStore,
        assistantModelFetch: modelFetch,
        audit,
        captureRequestEvent: (event) => usageEvents.push(event),
        ...options,
      }),
    );
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return {
      base: `http://127.0.0.1:${port}`,
      modelFetch,
      audit,
      registry,
      usageEvents,
      assistantStore,
    };
  }

  it('applies control-plane authentication and org membership before ensure', async () => {
    for (const deployGate of [
      { authorize: () => ({ ok: false as const, status: 401 as const, message: 'unauthorized' }) },
      {
        authorize: () => ({
          ok: true as const,
          identity: { subject: 'outsider', email: 'outsider@example.com', superAdmin: false },
        }),
      },
    ]) {
      const { base, assistantStore } = await start({ deployGate });
      const response = await fetch(
        `${base}/v1/orgs/acme/apps/support/envs/prod/assistant/clients/embed_${randomUUID()}`,
        {
          method: 'PUT',
          headers: { 'Idempotency-Key': randomUUID(), 'content-type': 'application/json' },
          body: JSON.stringify({
            name: 'web',
            clientSecret: `nsa_${randomBytes(32).toString('base64url')}`,
          }),
        },
      );
      expect([401, 403]).toContain(response.status);
      expect(
        await assistantStore.listClients({ org: 'acme', app: 'support', env: 'prod' }),
      ).toHaveLength(0);
    }
  });

  it('recovers the supplied usable credential after an error following the store commit', async () => {
    const { base, audit, assistantStore } = await start();
    vi.spyOn(audit, 'emit').mockRejectedValueOnce(new Error('simulated audit outage'));
    const id = `embed_${randomUUID()}`;
    const clientSecret = `nsa_${randomBytes(32).toString('base64url')}`;
    const request = {
      method: 'PUT',
      headers: { 'Idempotency-Key': randomUUID(), 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'web', clientSecret }),
    };
    const url = `${base}/v1/orgs/acme/apps/support/envs/prod/assistant/clients/${id}`;
    expect((await fetch(url, request)).status).toBe(500);
    const recovered = await fetch(url, request);
    expect(recovered.status).toBe(200);
    expect((await recovered.json()).disposition).toBe('replayed');
    expect(await assistantStore.authenticateClient(id, clientSecret)).toBeDefined();
    expect(
      await assistantStore.listClients({ org: 'acme', app: 'support', env: 'prod' }),
    ).toHaveLength(1);
  });

  it('ensures one client, keeps its receipt safe, and recovers without a live assistant', async () => {
    const { base, registry, audit } = await start();
    const id = `embed_${randomUUID()}`;
    const secret = `nsa_${randomBytes(32).toString('base64url')}`;
    const key = randomUUID();
    const url = `${base}/v1/orgs/acme/apps/support/envs/prod/assistant/clients/${id}`;
    const ensure = (body = { name: 'website', clientSecret: secret }, operation = key) =>
      fetch(url, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'Idempotency-Key': operation },
        body: JSON.stringify(body),
      });
    const response = await ensure();
    expect(response.status).toBe(201);
    const receipt = await response.json();
    expect(receipt).toMatchObject({ ok: true, id, name: 'website', disposition: 'created' });
    expect(Object.keys(receipt).sort()).toEqual([
      'createdAgainstDeploymentId',
      'createdAt',
      'disposition',
      'id',
      'name',
      'ok',
    ]);
    expect((await ensure()).status).toBe(200);
    expect((await ensure({ name: 'changed', clientSecret: secret })).status).toBe(409);
    expect((await ensure({ name: 'website', clientSecret: 'short' })).status).toBe(400);
    expect((await ensure(undefined, '')).status).toBe(400);
    expect((await ensure(undefined, 'x'.repeat(257))).status).toBe(400);
    const basic = Buffer.from(`${id}:${secret}`).toString('base64');
    const mint = await fetch(`${base}/v1/assistant/sessions`, {
      method: 'POST',
      headers: { authorization: `Basic ${basic}`, 'content-type': 'application/json' },
      body: JSON.stringify({ origin: 'https://app.example.com', user: { id: 'user' } }),
    });
    expect(mint.status).toBe(201);
    await registry.deploy(
      { org: 'acme', app: 'support', env: 'prod' },
      MANIFEST.replace(/ {2}assistant:[\s\S]*?(?=tools:)/, ''),
      { accessMode: 'public' },
    );
    expect((await ensure()).status).toBe(200);
    const listing = await (await fetch(url.slice(0, url.lastIndexOf('/')))).json();
    const serialized = JSON.stringify({
      receipt,
      listing,
      audit: await audit.list({ org: 'acme' }),
    });
    for (const hidden of [secret, key, 'secretHash', 'provisioning'])
      expect(serialized).not.toContain(hidden);
  });

  it('pins private sessions to an explicitly selected active version and returns the actual receipt', async () => {
    const { base, registry } = await start();
    const tenant = { org: 'acme', app: 'support', env: 'prod' };
    const v1 = await registry.deploy(tenant, MANIFEST, {
      accessMode: 'public',
      serverVersion: '1',
    });
    const v2 = await registry.deploy(
      tenant,
      MANIFEST.replace(
        'allowedOrigins: [https://app.example.com]',
        'allowedOrigins: [https://next.example.com]',
      ),
      { accessMode: 'public', serverVersion: '2' },
    );
    expect(v1.ok && v2.ok).toBe(true);
    const client = await (
      await fetch(`${base}/v1/orgs/acme/apps/support/envs/prod/assistant/clients`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"name":"web"}',
      })
    ).json();
    const authorization = `Basic ${Buffer.from(`${client.id}:${client.clientSecret}`).toString('base64')}`;
    const mint = (serverVersion: unknown, origin = 'https://app.example.com') =>
      fetch(`${base}/v1/assistant/sessions`, {
        method: 'POST',
        headers: { authorization, 'content-type': 'application/json' },
        body: JSON.stringify({
          origin,
          user: { id: 'user' },
          ...(serverVersion === undefined ? {} : { serverVersion }),
        }),
      });
    const first = await mint('1');
    expect(first.status).toBe(201);
    const receipt = await first.json();
    const actual = await registry.getActiveByTenantVersion(tenant, '1');
    expect(receipt.sessionId).toMatch(/^session_/);
    expect(receipt.target).toEqual({
      ...tenant,
      serverVersion: '1',
      deploymentId: actual?.deploymentId,
    });
    expect((await mint('1', 'https://next.example.com')).status).toBe(403);
    expect((await mint('999')).status).toBe(409);
    for (const invalid of ['', 'wat', '01', 'v1', ' 1', 1, null])
      expect((await mint(invalid)).status).toBe(400);
    const unsupported = await fetch(`${base}/v1/assistant/sessions`, {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify({
        origin: 'https://app.example.com',
        user: { id: 'user' },
        serverVersion: '1',
        signInTicket: 'ticket',
      }),
    });
    expect(unsupported.status).toBe(400);
    const latest = await mint(undefined, 'https://next.example.com');
    expect(latest.status).toBe(201);
    expect((await latest.json()).target.serverVersion).toBe('2');
  });
});
