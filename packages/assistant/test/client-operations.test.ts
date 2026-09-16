import { describe, expect, it } from 'vitest';
import { createAssistantClient } from '../src/client.js';

const BASE = 'https://core.example/v1/assistant';
const ID = 'b0b73eb3-95e8-4390-a12d-811bd9e0ed70';
function session(required = true, overrides: Record<string, unknown> = {}) {
  return Response.json({
    token: 'token',
    expiresAt: '2030-01-01T00:00:00Z',
    ...(required ? { executionAdmission: 'required' } : {}),
    endpoints: {
      turns: `${BASE}/turns`,
      operations: `${BASE}/operations`,
      operationStatus: `${BASE}/operations/status`,
      toolConfirmations: `${BASE}/tool-confirmations`,
    },
    ...overrides,
  });
}
function answer() {
  return new Response('event: content\ndata: {"text":"answer"}\n\nevent: done\ndata: {}\n\n', {
    headers: { 'content-type': 'text/event-stream' },
  });
}
function harness(
  mode: 'ok' | 'reject' | 'prepare-lost' | 'execute-lost' | 'truncated' = 'ok',
  required = true,
) {
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  let prepares = 0;
  const client = createAssistantClient({
    embedId: 'pub_example',
    serviceUrl: 'https://core.example',
    fetch: async (url, init) => {
      const path = String(url).split('/assistant/')[1] ?? '';
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      requests.push({ path, body });
      if (path === 'public-sessions') return session(required);
      if (path === 'operations') {
        prepares++;
        if (mode === 'reject') return Response.json({ error: 'denied' }, { status: 403 });
        if (mode === 'prepare-lost' && prepares === 1) throw new Error('lost prepare response');
        return Response.json({ operationId: ID, status: 'prepared' }, { status: 201 });
      }
      if (path === 'operations/status')
        return Response.json({ operationId: ID, status: 'unknown' });
      if (path === 'turns') {
        if (mode === 'execute-lost') throw new Error('lost execution response');
        if (mode === 'truncated')
          return new Response('event: content\ndata: {"text":"partial"}\n\n', {
            headers: { 'content-type': 'text/event-stream' },
          });
        return answer();
      }
      throw new Error(`unexpected ${path}`);
    },
  });
  return { client, requests };
}

describe('required assistant operation transport', () => {
  it('prepares the exact turn once before executing with its server operation ID', async () => {
    const { client, requests } = harness();
    await client.sendMessage('hello');
    expect(requests.map((r) => r.path)).toEqual(['public-sessions', 'operations', 'turns']);
    expect(requests[1]?.body).toEqual({
      requestKey: expect.stringMatching(/^[a-f0-9-]{36}$/),
      turn: { message: 'hello' },
    });
    expect(requests[2]?.body).toEqual({ message: 'hello', operationId: ID });
    await client.sendMessage('next');
    expect(requests.filter((r) => r.path === 'operations')).toHaveLength(2);
  });
  it('preserves the legacy turn path despite advertised optional operation endpoints', async () => {
    const { client, requests } = harness('ok', false);
    await client.sendMessage('hello');
    expect(requests.map((r) => r.path)).toEqual(['public-sessions', 'turns']);
    expect(requests[1]?.body).toEqual({ message: 'hello' });
  });
  it('never sends a model turn after rejected preparation', async () => {
    const { client, requests } = harness('reject');
    await expect(client.sendMessage('hello')).rejects.toThrow();
    expect(requests.map((r) => r.path)).toEqual(['public-sessions', 'operations']);
  });
  it('recovers a lost preparation result only with the original key and turn', async () => {
    const { client, requests } = harness('prepare-lost');
    await expect(client.sendMessage('hello')).rejects.toThrow();
    await expect(client.sendMessage('different')).rejects.toThrow();
    expect(requests).toHaveLength(2);
    await client.sendMessage('hello');
    const prepares = requests.filter((r) => r.path === 'operations');
    expect(prepares).toHaveLength(2);
    expect(prepares[1]?.body).toEqual(prepares[0]?.body);
    expect(requests.filter((r) => r.path === 'turns')).toHaveLength(1);
  });
  it.each([
    'execute-lost',
    'truncated',
  ] as const)('retains uncertain %s without executing or preparing again', async (mode) => {
    const { client, requests } = harness(mode);
    await expect(client.sendMessage('hello')).rejects.toThrow();
    await expect(client.sendMessage('hello')).rejects.toThrow();
    expect(requests.filter((r) => r.path === 'operations')).toHaveLength(1);
    expect(requests.filter((r) => r.path === 'turns')).toHaveLength(1);
    expect(requests.at(-1)?.path).toBe('operations/status');
    client.resetSession();
    await expect(client.sendMessage('new conversation')).rejects.toThrow();
    expect(requests.filter((r) => r.path === 'operations')).toHaveLength(2);
  });
  it('checks status after a lost execution and delivers only the same still-prepared operation', async () => {
    const requests: { path: string; body: Record<string, unknown> }[] = [];
    let deliveries = 0;
    const client = createAssistantClient({
      sessionEndpoint: '/session',
      fetch: async (url, init) => {
        const path = String(url);
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        requests.push({ path, body });
        if (path === '/session') return session();
        if (path.endsWith('/status') || path.endsWith('/operations'))
          return Response.json({ operationId: ID, status: 'prepared' });
        deliveries++;
        if (deliveries === 1) throw new Error('request never arrived');
        return answer();
      },
    });
    await expect(client.sendMessage('hello')).rejects.toThrow();
    await client.sendMessage('hello');
    expect(requests.filter((r) => r.path === `${BASE}/operations`)).toHaveLength(1);
    const turns = requests.filter((r) => r.path === `${BASE}/turns`);
    expect(turns).toHaveLength(2);
    expect(turns[0]?.body).toEqual(turns[1]?.body);
    expect(turns[1]?.body.operationId).toBe(ID);
  });

  it('never remints or retries a protected turn after an execution 401', async () => {
    const paths: string[] = [];
    const client = createAssistantClient({
      sessionEndpoint: '/session',
      fetch: async (url) => {
        paths.push(String(url));
        if (String(url) === '/session') return session();
        if (String(url).endsWith('/operations'))
          return Response.json({ operationId: ID, status: 'prepared' });
        return new Response('', { status: 401 });
      },
    });
    await expect(client.sendMessage('hello')).rejects.toThrow();
    expect(paths).toEqual(['/session', `${BASE}/operations`, `${BASE}/turns`]);
  });

  it.each([
    { executionAdmission: 'sometimes' },
    {
      executionAdmission: 'required',
      endpoints: { turns: `${BASE}/turns`, toolConfirmations: `${BASE}/tool-confirmations` },
    },
    {
      executionAdmission: 'required',
      endpoints: {
        turns: `${BASE}/turns`,
        operations: 12,
        operationStatus: `${BASE}/operations/status`,
        toolConfirmations: `${BASE}/tool-confirmations`,
      },
    },
  ])('fails closed on malformed protected session capability %j', async (overrides) => {
    let calls = 0;
    const client = createAssistantClient({
      sessionEndpoint: '/session',
      fetch: async () => {
        calls++;
        return session(true, overrides);
      },
    });
    await expect(client.sendMessage('hello')).rejects.toThrow();
    expect(calls).toBe(1);
  });
});
