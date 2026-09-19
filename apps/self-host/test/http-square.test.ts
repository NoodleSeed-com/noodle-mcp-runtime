import { compileManifest, InMemoryCatalog } from '@noodle-borg/compiler';
import { afterEach, expect, it, vi } from 'vitest';
import { createHttpSquareConnectors, SQUARE_CATALOG } from '../src/http-square.js';
import { actionManifest, config } from './http-actions.fixture.js';

function setup(name = 'square_get_cart', confirm = false) {
  const tool = actionManifest.tools[0];
  if (!tool) throw new Error('missing tool');
  const compiled = compileManifest(
    {
      ...actionManifest,
      connectors: { actions: { id: 'operator_square', version: '1.0.0' } },
      tools: [
        {
          ...tool,
          name,
          annotations: { confirm, readOnlyHint: false },
          fulfilment: { use: `actions.${name}`, args: { values: '${input.values}' } },
        },
      ],
    },
    { catalog: new InMemoryCatalog([SQUARE_CATALOG]) },
  );
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.errors));
  const bridge = createHttpSquareConnectors(config);
  const connector = bridge.create({
    tenant: { org: 'acme', app: 'support', env: 'test' },
    deploymentId: 'dep-one',
    artifact: compiled.artifact,
  })[0];
  if (!connector) throw new Error('missing connector');
  const call = {
    operation: name,
    args: { values: { name: 'Visitor' } },
    credential: { token: '' },
    assistantSessionId: 'session-one',
    execution: { id: 'a'.repeat(64), toolName: name, entrypointKind: 'tool' as const },
  };
  return { connector, call, artifact: compiled.artifact };
}
afterEach(() => vi.unstubAllGlobals());
it('posts only trusted scope to the fixed action origin and isolates sessions', async () => {
  const fetcher = vi.fn(async () => Response.json({ data: {} }));
  vi.stubGlobal('fetch', fetcher);
  const { connector, call } = setup();
  await connector.invoke(call);
  await connector.invoke({ ...call, assistantSessionId: 'session-two' });
  const calls = fetcher.mock.calls as unknown as [string, RequestInit][];
  expect(calls.map(([url]) => url)).toEqual(
    Array(2).fill('http://127.0.0.1:9082/internal/runtime/square'),
  );
  expect(calls.map(([, init]) => JSON.parse(String(init.body)).customerSessionId)).toEqual([
    'session-one',
    'session-two',
  ]);
  expect(JSON.parse(String(calls[0]?.[1].body))).toEqual({
    version: 1,
    runtimeInstanceId: 'runtime-one',
    executionId: 'a'.repeat(64),
    target: { org: 'acme', app: 'support', environment: 'test', deploymentId: 'dep-one' },
    tool: 'square_get_cart',
    customerSessionId: 'session-one',
    values: { name: 'Visitor' },
  });
});
it.each([
  { assistantSessionId: undefined },
  { operation: 'square_charge' },
  { execution: undefined },
  {
    execution: {
      id: 'a'.repeat(64),
      toolName: 'square_add_cart_item',
      entrypointKind: 'tool' as const,
    },
  },
  { args: { values: { name: 'Visitor', customerSessionId: 'forged' } } },
  { args: { values: { name: 'Visitor' }, assistantSessionId: 'forged' } },
])('rejects untrusted calls without HTTP', async (extra) => {
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  const { connector, call } = setup();
  await expect(connector.invoke({ ...call, ...extra })).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});
it('requires checkout confirmation while cart writes remain actions without confirmation', () => {
  expect(() => setup('square_prepare_checkout')).toThrow();
  expect(() => setup('square_prepare_checkout', true)).not.toThrow();
  expect(setup('square_add_cart_item').connector.signature('square_add_cart_item')?.type).toBe(
    'action',
  );
});
it.each([
  new Response('private secret', { status: 500 }),
  Response.json({ data: { value: 'x'.repeat(131072) } }),
  Response.json({ data: [] }),
])('sanitizes ambiguous write failures and reports unknown', async (response) => {
  const fetcher = vi.fn(async () => response);
  vi.stubGlobal('fetch', fetcher);
  const { connector, call } = setup('square_add_cart_item');
  const reportOutcome = vi.fn();
  await expect(connector.invoke({ ...call, reportOutcome })).rejects.toMatchObject({
    retryable: false,
    message: expect.stringContaining('unknown'),
  });
  expect(reportOutcome).toHaveBeenCalledWith({ outcome: 'unknown' });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('carries verified same-owner model and widget sessions into the actual adapter', async () => {
  const { executeAssistantAppToolCall } = await import(
    '../../../packages/assistant-gateway/src/app-tool-call.js'
  );
  const { dispatchAssistantTool } = await import(
    '../../../packages/assistant-gateway/src/assistant-interactive.js'
  );
  const { InMemoryAssistantStore } = await import(
    '../../../packages/assistant-gateway/src/in-memory-assistant-store.js'
  );
  const fetcher = vi.fn(async () => Response.json({ data: {} }));
  vi.stubGlobal('fetch', fetcher);
  const { connector, artifact } = setup();
  const deps = {
    connectors: { resolve: () => connector },
    broker: { getCredential: async () => ({ token: '' }) },
    assistantSessionId: 'forged-stale-dep',
  };
  const now = new Date('2030-01-01T00:00:00.000Z');
  const store = new InMemoryAssistantStore();
  const audit = { emit: async () => {} };
  const sessions = ['first', 'second'].map((id) => ({
    id,
    tokenHash: 'private',
    clientId: 'embed-one',
    tenant: { org: 'acme', app: 'support', env: 'test' },
    deploymentId: 'dep-one',
    origin: 'https://example.com',
    caller: { subject: 'same-owner', identityKind: 'customer' as const },
    createdAt: now.toISOString(),
    expiresAt: '2030-01-01T00:01:00.000Z',
    absoluteExpiresAt: '2030-01-01T00:02:00.000Z',
    history: [],
  }));
  const tool = artifact.tools[0];
  if (!tool) throw new Error('missing tool');
  for (const session of sessions) {
    await executeAssistantAppToolCall({
      artifact,
      deps,
      session,
      toolName: tool.name,
      arguments: { values: { name: 'Visitor' } },
      now: () => now,
      store,
      audit,
    });
    await dispatchAssistantTool({
      artifact,
      tool,
      executeDeps: deps,
      session,
      caller: session.caller,
      arguments: { values: { name: 'Visitor' } },
      context: {
        temporal: {
          instant: now.toISOString(),
          localDate: '2030-01-01',
          localTime: '00:00:00',
          utcOffset: '+00:00',
          weekday: 'Tuesday',
          timeZone: 'UTC',
          locale: 'en-US',
          source: { locale: 'platform-default', timeZone: 'platform-default' },
        },
        ambientStatus: 'not_configured',
      },
      now: () => now,
      store,
      audit,
    });
  }
  const requests = fetcher.mock.calls as unknown as [string, RequestInit][];
  expect(requests.map(([, init]) => JSON.parse(String(init.body)).customerSessionId)).toEqual([
    'first',
    'first',
    'second',
    'second',
  ]);
});

it('dispatches checkout only after runtime confirmation and preserves its stored session', async () => {
  const { executeAssistantAppToolCall } = await import(
    '../../../packages/assistant-gateway/src/app-tool-call.js'
  );
  const { assistantPreparedToolContinuation } = await import(
    '../../../packages/assistant-gateway/src/assistant-interactive.js'
  );
  const { withAssistantSessionExecutionAuthority } = await import(
    '../../../packages/assistant-gateway/src/assistant-customer-routing.js'
  );
  const { InMemoryAssistantStore } = await import(
    '../../../packages/assistant-gateway/src/in-memory-assistant-store.js'
  );
  const { executePreparedTool } = await import('@noodle-borg/runtime');
  const fetcher = vi.fn(async () =>
    Response.json({ data: { checkoutUrl: 'https://example.com/checkout' } }),
  );
  vi.stubGlobal('fetch', fetcher);
  const { connector, artifact } = setup('square_prepare_checkout', true);
  const deps = {
    connectors: { resolve: () => connector },
    broker: { getCredential: async () => ({ token: '' }) },
  };
  const now = new Date('2030-01-01T00:00:00.000Z');
  const store = new InMemoryAssistantStore();
  const session = {
    id: 'checkout-session',
    tokenHash: 'private',
    clientId: 'embed-one',
    tenant: { org: 'acme', app: 'support', env: 'test' },
    deploymentId: 'dep-one',
    origin: 'https://example.com',
    caller: { subject: 'same-owner', identityKind: 'customer' as const },
    createdAt: now.toISOString(),
    expiresAt: '2030-01-01T00:01:00.000Z',
    absoluteExpiresAt: '2030-01-01T00:02:00.000Z',
    history: [],
  };
  const proposed = await executeAssistantAppToolCall({
    artifact,
    deps,
    session,
    toolName: 'square_prepare_checkout',
    arguments: { values: { name: 'Visitor' } },
    now: () => now,
    store,
    audit: { emit: async () => {} },
  });
  expect(fetcher).not.toHaveBeenCalled();
  if (proposed.kind !== 'interaction') throw new Error('missing proposal');
  const interaction = await store.getInteraction({
    id: String(proposed.data.id),
    sessionId: session.id,
    deploymentId: session.deploymentId,
    now,
  });
  if (interaction?.kind !== 'confirmation') throw new Error('missing confirmation');
  const continuation = assistantPreparedToolContinuation(interaction);
  if (!continuation) throw new Error('missing continuation');
  const result = await executePreparedTool(
    artifact,
    continuation,
    withAssistantSessionExecutionAuthority(deps, artifact, session),
  );
  expect(result.status).toBe('completed');
  const requests = fetcher.mock.calls as unknown as [string, RequestInit][];
  expect(requests).toHaveLength(1);
  expect(JSON.parse(String(requests[0]?.[1].body)).customerSessionId).toBe(session.id);
});

it('denies direct runtime tool invocation without an assistant session before HTTP', async () => {
  const { executeTool } = await import('@noodle-borg/runtime');
  const { artifact, connector } = setup();
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  const result = await executeTool(
    artifact,
    'square_get_cart',
    { values: { name: 'Visitor' } },
    {
      connectors: { resolve: () => connector },
      broker: { getCredential: async () => ({ token: '' }) },
    },
  );
  expect(result.ok).toBe(false);
  expect(fetcher).not.toHaveBeenCalled();
});
