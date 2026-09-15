import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { ServeServiceOptions } from '@noodle-borg/service';
import { afterEach, describe, expect, it } from 'vitest';

import { startSelfHostService } from '../src/main.js';

type AdmissionGate = NonNullable<ServeServiceOptions['admissionGate']>;
const TOKEN = 'LQPPSnvpT4TMomooI4tXegZQJQFxeEJr2Sn9sYrZj9Y';
const CONTEXT: Parameters<AdmissionGate>[0] = {
  routeId: 'org-one/app-one/live',
  requestId: 'request-one',
  method: 'tools/call',
  category: 'execute',
  name: 'read_inventory',
  subject: 'person-one',
  org: 'org-one',
  app: 'app-one',
  env: 'live',
  serverVersion: 'version-one',
  accessMode: 'public',
  deploymentId: 'deployment-one',
  remoteAddress: '127.0.0.1',
};
const UNAVAILABLE = { allow: false, reason: 'admission_unavailable', status: 403 };
const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function endpoint(
  handler: (request: IncomingMessage, response: ServerResponse) => unknown,
): Promise<string> {
  const server = createServer((request, response) => {
    void Promise.resolve(handler(request, response)).catch(() => {
      response.writeHead(500).end();
    });
  });
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Missing loopback address');
  return `http://127.0.0.1:${address.port}/runtime/admit`;
}

async function configuredGate(url: string) {
  let gate: AdmissionGate | undefined;
  const logs: string[] = [];
  const logger = {
    level: 'info' as const,
    log(level: string, event: string, fields?: Readonly<Record<string, unknown>>) {
      logs.push(JSON.stringify({ level, event, fields }));
    },
    debug(event: string, fields?: Readonly<Record<string, unknown>>) {
      this.log('debug', event, fields);
    },
    info(event: string, fields?: Readonly<Record<string, unknown>>) {
      this.log('info', event, fields);
    },
    warn(event: string, fields?: Readonly<Record<string, unknown>>) {
      this.log('warn', event, fields);
    },
    error(event: string, fields?: Readonly<Record<string, unknown>>) {
      this.log('error', event, fields);
    },
    child() {
      return logger;
    },
  };
  await startSelfHostService(
    {
      DATABASE_URL: 'postgresql://noodle:password@database:5432/noodle',
      NOODLE_SECRET_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
      NOODLE_SELF_HOST_ADMIN_TOKEN: TOKEN,
      NOODLE_ASSET_ROOT: '/var/lib/noodle/assets',
      NOODLE_ASSET_IDENTITY_SALT: Buffer.alloc(32, 9).toString('base64url'),
      NOODLE_OAUTH_ISSUER: 'http://127.0.0.1:9080',
      NOODLE_OAUTH_JWKS_URI: 'http://127.0.0.1:9080/jwks',
      NOODLE_ADMISSION_URL: url,
      NOODLE_ADMISSION_TOKEN: TOKEN,
    },
    {
      logger,
      serve: async (options) => {
        gate = options.admissionGate;
        return { close: async () => undefined };
      },
      onSigterm: () => undefined,
      setExitCode: () => undefined,
    },
  );
  expect(gate).toBeTypeOf('function');
  if (gate === undefined) throw new Error('Configured admission gate was not supplied');
  return { gate, logs };
}

describe('self-host HTTP admission', () => {
  it('posts the versioned context and bearer credential to the fixed endpoint', async () => {
    let received: unknown;
    const url = await endpoint(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += chunk.toString();
      received = {
        method: request.method,
        path: request.url,
        authorization: request.headers.authorization,
        contentType: request.headers['content-type'],
        body: JSON.parse(body),
      };
      response.end('{"allow":true}');
    });
    const { gate, logs } = await configuredGate(url);

    await expect(gate(CONTEXT)).resolves.toEqual({ allow: true });
    expect(received).toEqual({
      method: 'POST',
      path: '/runtime/admit',
      authorization: `Bearer ${TOKEN}`,
      contentType: 'application/json',
      body: { version: 1, context: CONTEXT },
    });
    expect(logs.join()).not.toContain(TOKEN);
  });

  it.each([
    { allow: false, reason: 'permission_denied' },
    { allow: false, reason: 'permission_denied', status: 403 },
    { allow: false, reason: 'capacity_reached', status: 429 },
  ])('preserves a validated denial %j', async (decision) => {
    const url = await endpoint((_request, response) => response.end(JSON.stringify(decision)));
    const { gate } = await configuredGate(url);
    await expect(gate(CONTEXT)).resolves.toEqual(decision);
  });

  it.each([
    '',
    'a'.repeat(65),
    'permission_denied\nprivate-debug',
    'permission_denied\rprivate-debug',
    'permission_denied\u0000private-debug',
    'permission_denied\n',
    'permission_denied\r',
    'Permission Denied',
    '1denied',
    'policy:private-detail',
  ])('replaces unsafe denial reason %j with a safe unavailable code', async (reason) => {
    const url = await endpoint((_request, response) => {
      response.end(JSON.stringify({ allow: false, reason, status: 403 }));
    });
    const { gate } = await configuredGate(url);
    await expect(gate(CONTEXT)).resolves.toEqual(UNAVAILABLE);
  });

  it('preserves a machine-code reason at the 64-character boundary', async () => {
    const reason = `limit_${'a'.repeat(58)}`;
    const url = await endpoint((_request, response) => {
      response.end(JSON.stringify({ allow: false, reason, status: 429 }));
    });
    const { gate } = await configuredGate(url);
    await expect(gate(CONTEXT)).resolves.toEqual({ allow: false, reason, status: 429 });
  });

  it.each([
    400, 401, 403, 429, 500, 503,
  ])('denies an HTTP %s even when its body allows', async (status) => {
    const url = await endpoint((_request, response) =>
      response.writeHead(status).end('{"allow":true}'),
    );
    const { gate } = await configuredGate(url);
    await expect(gate(CONTEXT)).resolves.toEqual(UNAVAILABLE);
  });

  it.each([
    '',
    'not-json',
    'null',
    '[]',
    '{"allow":"true"}',
    '{"allow":true,"reason":"unexpected"}',
    '{"allow":true,"extra":true}',
    '{"allow":false}',
    '{"allow":false,"reason":null}',
    '{"allow":false,"reason":"blocked","status":401}',
    '{"allow":false,"reason":"blocked","status":"403"}',
  ])('denies malformed or unsupported response %j', async (body) => {
    const url = await endpoint((_request, response) => response.end(body));
    const { gate } = await configuredGate(url);
    await expect(gate(CONTEXT)).resolves.toEqual(UNAVAILABLE);
  });

  it('denies an oversized streamed response without waiting for its end', async () => {
    const url = await endpoint((_request, response) => {
      response.write('{"allow":true}');
      response.write(' '.repeat(16_384));
    });
    const { gate } = await configuredGate(url);
    const start = performance.now();
    await expect(gate(CONTEXT)).resolves.toEqual(UNAVAILABLE);
    expect(performance.now() - start).toBeLessThan(1_500);
  });

  it('accepts a valid response at the 16 KiB boundary', async () => {
    const url = await endpoint((_request, response) => {
      response.end(`{"allow":true}${' '.repeat(16_370)}`);
    });
    const { gate } = await configuredGate(url);
    await expect(gate(CONTEXT)).resolves.toEqual({ allow: true });
  });

  it('counts response bytes rather than decoded characters', async () => {
    const url = await endpoint((_request, response) => {
      response.end(JSON.stringify({ allow: false, reason: 'é'.repeat(8_192) }));
    });
    const { gate } = await configuredGate(url);
    await expect(gate(CONTEXT)).resolves.toEqual(UNAVAILABLE);
  });

  it('denies invalid UTF-8 instead of accepting a replacement-character policy reason', async () => {
    const url = await endpoint((_request, response) => {
      response.end(
        Buffer.concat([
          Buffer.from('{"allow":false,"reason":"'),
          Buffer.from([0xff]),
          Buffer.from('"}'),
        ]),
      );
    });
    const { gate } = await configuredGate(url);
    await expect(gate(CONTEXT)).resolves.toEqual(UNAVAILABLE);
  });

  it.each([302, 307, 308])('never follows an HTTP %s redirect', async (status) => {
    let redirectedCalls = 0;
    const destination = await endpoint((_request, response) => {
      redirectedCalls += 1;
      response.end('{"allow":true}');
    });
    const url = await endpoint((_request, response) => {
      response.writeHead(status, { location: destination }).end();
    });
    const { gate } = await configuredGate(url);
    await expect(gate(CONTEXT)).resolves.toEqual(UNAVAILABLE);
    expect(redirectedCalls).toBe(0);
  });

  it('denies connection failure without leaking transport details', async () => {
    const url = await endpoint((_request, response) => response.end('{"allow":true}'));
    const server = servers.at(-1);
    if (server === undefined) throw new Error('Missing test server');
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const { gate, logs } = await configuredGate(url);
    await expect(gate(CONTEXT)).resolves.toEqual(UNAVAILABLE);
    expect(logs.join()).not.toContain(url);
    expect(logs.join()).not.toContain(TOKEN);
  });

  it.each(['headers', 'body'])('bounds a stalled response %s to two seconds', async (phase) => {
    const url = await endpoint((_request, response) => {
      if (phase === 'body') {
        response.writeHead(200);
        response.write('{"allow":');
      }
    });
    const { gate } = await configuredGate(url);
    const start = performance.now();
    await expect(gate(CONTEXT)).resolves.toEqual(UNAVAILABLE);
    expect(performance.now() - start).toBeGreaterThanOrEqual(1_800);
    expect(performance.now() - start).toBeLessThan(2_700);
  });

  it('returns only a safe denial when an error body contains secrets', async () => {
    const body = JSON.stringify({ error: 'private-policy-debug', credential: TOKEN });
    const url = await endpoint((_request, response) => response.writeHead(500).end(body));
    const { gate, logs } = await configuredGate(url);
    const decision = await gate(CONTEXT);
    expect(decision).toEqual(UNAVAILABLE);
    expect(JSON.stringify({ logs, decision })).not.toContain(TOKEN);
    expect(JSON.stringify({ logs, decision })).not.toContain('private-policy-debug');
  });
});

it('accepts only the strict generic allow-side execution policy', async () => {
  const policy = {
    version: 1,
    policyId: 'bounded-v1',
    maxModelRequests: 2,
    maxInputTokens: 16384,
    maxCompletionTokens: 1024,
    maxTokensPerTurn: 2048,
    maxRequestBytes: 131072,
    maxToolCallsPerTurn: 1,
    timeoutMs: 30000,
    maxTurnMs: 90000,
    reasoningEffort: 'none',
  };
  let decision: unknown = { allow: true, assistantExecution: policy };
  const url = await endpoint((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(decision));
  });
  const { gate } = await configuredGate(url);
  expect(await gate(CONTEXT)).toEqual(decision);
  for (const change of [
    { maxInputTokens: -1 },
    { timeoutMs: 0 },
    { maxModelRequests: 1.5 },
    { reasoningEffort: 'high' },
    { invented: true },
  ]) {
    decision = { allow: true, assistantExecution: { ...policy, ...change } };
    expect(await gate(CONTEXT)).toEqual(UNAVAILABLE);
  }
  decision = { allow: true, assistantExecution: null };
  expect(await gate(CONTEXT)).toEqual(UNAVAILABLE);
});
