import { afterEach, expect, it, vi } from 'vitest';
import { createHttpActionConnectors } from '../src/http-actions.js';

import { config, receipt, setup } from './http-actions.fixture.js';

afterEach(() => vi.unstubAllGlobals());
it('binds operator, deployed scope, tool, schema, and execution outside public arguments', async () => {
  const fetcher = vi.fn(async () => Response.json(receipt));
  vi.stubGlobal('fetch', fetcher);
  const { connector, call } = setup();
  expect(await connector.invoke(call)).toEqual(receipt);
  const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe(config.url);
  const body = JSON.parse(String(init.body));
  expect(body).toEqual({
    version: 1,
    runtimeInstanceId: 'runtime-one',
    executionId: 'a'.repeat(64),
    target: { org: 'acme', app: 'support', environment: 'test', deploymentId: 'dep-one' },
    tool: 'submit_contact_form',
    schemaDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    values: { name: 'Visitor' },
  });
  expect(new Headers(init.headers).get('authorization')).toBe('Bearer operator-secret');
  expect(init.redirect).toBe('error');
});
it.each([
  { execution: undefined },
  { execution: { id: 'a'.repeat(64), toolName: 'other' } },
  { args: { values: { name: 'Visitor' }, confirmed: true } },
  { args: { values: { name: 'Visitor', unexpected: true } } },
])('refuses untrusted or malformed action requests without HTTP', async (extra) => {
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  const { connector, call } = setup();
  await expect(connector.invoke({ ...call, ...extra })).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});
it('refuses missing deployment or unconfirmed authored tools', () => {
  const { compiled, bridge } = setup();
  expect(
    bridge.create({
      tenant: { org: 'acme', app: 'support', env: 'test' },
      artifact: compiled.artifact,
    }),
  ).toEqual([]);
  expect(() =>
    bridge.create({
      tenant: { org: 'acme', app: 'support', env: 'test' },
      deploymentId: 'dep-one',
      artifact: {
        ...compiled.artifact,
        tools: compiled.artifact.tools.map((tool) => ({
          ...tool,
          annotations: { confirm: false },
        })),
      },
    }),
  ).toThrow();
});
it.each([
  new Response('secret backend failure', { status: 500 }),
  Response.json({ ...receipt, environment: 'live' }),
  Response.json({ ...receipt, values: { secret: 'do not expose' } }),
  Response.json({ ok: true }),
])('returns sanitized errors for failed or invalid receipts', async (response) => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => response),
  );
  const { connector, call } = setup();
  await expect(connector.invoke(call)).rejects.toThrow('Action submission unavailable');
});
it('confines identity to exact HTTPS Cloud Run origin and requires explicit local origin', () => {
  expect(() => createHttpActionConnectors({ ...config, localOrigin: undefined })).toThrow();
  expect(() =>
    createHttpActionConnectors({ ...config, url: 'http://evil.example/submit' }),
  ).toThrow();
  expect(() =>
    createHttpActionConnectors({
      ...config,
      url: 'https://actions.run.app/submit',
      googleAudience: 'https://other.run.app',
    }),
  ).toThrow();
});

it('preserves safe stale-form failures without returning backend data', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('private values and credentials', { status: 409 })),
  );
  const { connector, call } = setup();
  await expect(connector.invoke(call)).rejects.toMatchObject({
    status: 409,
    message: expect.stringContaining('contact form changed'),
  });
});
it('uses Google identity only at the configured origin, separate from application credentials', async () => {
  const calls: { url: string; headers: Headers }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, init) => {
      calls.push({ url: String(url), headers: new Headers(init.headers) });
      if (String(url).startsWith('http://metadata.google.internal/'))
        return new Response(
          `a.${Buffer.from(JSON.stringify({ aud: 'https://actions-test.run.app', exp: Math.floor(Date.now() / 1000) + 300 })).toString('base64url')}.signature`,
          { headers: { 'metadata-flavor': 'Google' } },
        );
      return Response.json(receipt);
    }),
  );
  const { compiled, call } = setup();
  const bridge = createHttpActionConnectors({
    url: 'https://actions-test.run.app/internal/runtime/contact-submissions',
    token: 'operator-secret',
    googleAudience: 'https://actions-test.run.app',
    runtimeInstanceId: 'runtime-one',
  });
  await bridge
    .create({
      tenant: { org: 'acme', app: 'support', env: 'test' },
      deploymentId: 'dep-one',
      artifact: compiled.artifact,
    })[0]
    ?.invoke(call);
  expect(calls).toHaveLength(2);
  expect(calls[0]?.headers.has('authorization')).toBe(false);
  expect(calls[1]?.url).toBe('https://actions-test.run.app/internal/runtime/contact-submissions');
  expect(calls[1]?.headers.get('authorization')).toBe('Bearer operator-secret');
  expect(calls[1]?.headers.get('x-serverless-authorization')).toMatch(/^Bearer a\./);
});

it.each([
  'resource',
  'prompt',
] as const)('does not let a same-named %s impersonate the confirmed tool', async (kind) => {
  const { compileManifest, InMemoryCatalog } = await import('@noodle-borg/compiler');
  const { executeResource, executePrompt, InMemoryConnectorRegistry, StaticServiceBroker } =
    await import('@noodle-borg/runtime');
  const { ACTION_CATALOG } = await import('../src/http-actions.js');
  const { actionManifest } = await import('./http-actions.fixture.js');
  const fulfilment = { use: 'actions.submit_contact_form', args: { values: { name: 'Visitor' } } };
  const result = compileManifest(
    {
      ...actionManifest,
      ...(kind === 'resource'
        ? {
            resources: [
              {
                name: 'submit_contact_form',
                uri: 'contact://submit',
                mimeType: 'application/json',
                fulfilment,
              },
            ],
          }
        : { prompts: [{ name: 'submit_contact_form', description: 'Contact', fulfilment }] }),
    },
    { catalog: new InMemoryCatalog([ACTION_CATALOG]) },
  );
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  const fetcher = vi.fn(async () => Response.json(receipt));
  vi.stubGlobal('fetch', fetcher);
  const bridge = createHttpActionConnectors(config);
  const connectors = new InMemoryConnectorRegistry(
    bridge.create({
      tenant: { org: 'acme', app: 'support', env: 'test' },
      deploymentId: 'dep-one',
      artifact: result.artifact,
    }),
  );
  const deps = { connectors, broker: new StaticServiceBroker({}) };
  const execution = await (kind === 'resource' ? executeResource : executePrompt)(
    result.artifact,
    'submit_contact_form',
    {},
    deps,
  );
  expect(execution.ok).toBe(false);
  expect(fetcher).not.toHaveBeenCalled();
});
