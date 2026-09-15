import { createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ServeServiceOptions } from '@noodle-borg/service';
import { createMcpRouter, noopLogger, type ServedTarget } from '@noodle-borg/transport-http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  InMemoryConnectorRegistry,
  StaticServiceBroker,
} from '../../../packages/runtime/src/index.js';
import { resolveSelfHostConfig } from '../src/config.js';
import { startSelfHostService } from '../src/main.js';

const privateKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey;
const jwk = {
  ...createPublicKey(privateKey).export({ format: 'jwk' }),
  kid: 'fixture-key',
  alg: 'ES256',
  use: 'sig',
};
const publicOrigin = 'https://runtime.example.test';
const path = '/o/example/fixture/test/mcp';
const admissionToken = '5AbpGdq-RSKQxCM8ErRJVcMFLEHe5DRBWgfSXJn46d0';
const servers: Server[] = [];
function environment(): Record<string, string> {
  return {
    DATABASE_URL: 'postgresql://runtime:password@database/runtime',
    NOODLE_SECRET_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
    NOODLE_SELF_HOST_ADMIN_TOKEN: 'LQPPSnvpT4TMomooI4tXegZQJQFxeEJr2Sn9sYrZj9Y',
    NOODLE_ASSET_ROOT: '/var/lib/runtime/assets',
    NOODLE_ASSET_IDENTITY_SALT: Buffer.alloc(32, 9).toString('base64url'),
    PUBLIC_BASE_URL: publicOrigin,
  };
}
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
async function listen(server: Server): Promise<string> {
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
function token(issuer: string, audience = publicOrigin + path, expiry = 60): string {
  const header = Buffer.from(
    JSON.stringify({ alg: 'ES256', kid: 'fixture-key', typ: 'at+jwt' }),
  ).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      iss: issuer,
      aud: audience,
      sub: 'fixture-person',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + expiry,
      scope: 'fixture:read',
      noodle_identity: 'customer',
    }),
  ).toString('base64url');
  const input = `${header}.${payload}`;
  return `${input}.${sign('sha256', Buffer.from(input), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
}
async function setup(trustProxy?: string) {
  const admitted: unknown[] = [];
  const issuer = await listen(
    createServer(async (request, response) => {
      response.setHeader('content-type', 'application/json');
      if (request.url === '/jwks') {
        response.end(JSON.stringify({ keys: [jwk] }));
        return;
      }
      if (
        request.url === '/admit' &&
        request.headers.authorization === `Bearer ${admissionToken}`
      ) {
        let body = '';
        for await (const chunk of request) body += chunk.toString();
        admitted.push(JSON.parse(body));
        response.end('{"allow":true}');
        return;
      }
      response.writeHead(403);
      response.end('{}');
    }),
  );
  let received: ServeServiceOptions | undefined;
  await startSelfHostService(
    {
      ...environment(),
      ...(trustProxy === undefined ? {} : { NOODLE_TRUST_PROXY: trustProxy }),
      NOODLE_OAUTH_ISSUER: issuer,
      NOODLE_OAUTH_JWKS_URI: `${issuer}/jwks`,
      NOODLE_ADMISSION_URL: `${issuer}/admit`,
      NOODLE_ADMISSION_TOKEN: admissionToken,
    },
    {
      logger: noopLogger,
      serve: async (options) => {
        received = options;
        return { close: async () => undefined };
      },
      onSigterm: () => undefined,
      setExitCode: () => undefined,
    },
  );
  if (!received?.verifyOwnerToken || !received.admissionGate)
    throw new Error('Missing managed verifier or admission gate');
  const artifact = JSON.parse(
    readFileSync(
      new URL(
        '../../../packages/compiler/fixtures/valid/minimal.resolved.artifact.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  const target: ServedTarget = {
    served: {
      artifact,
      deps: {
        connectors: new InMemoryConnectorRegistry([]),
        broker: new StaticServiceBroker({ token: 'fixture' }),
      },
    },
    deploymentId: 'fixture-deployment',
    accessMode: 'authenticated',
    org: 'example',
    app: 'fixture',
    environment: 'test',
  };
  const runtime = await listen(
    createServer(
      createMcpRouter(async () => target, {
        tenantLookup: async () => target,
        verifyOwnerToken: received.verifyOwnerToken,
        admissionGate: received.admissionGate,
        ...(received.tls === undefined ? {} : { tls: received.tls }),
      }),
    ),
  );
  const call = async (headers: Record<string, string>, bearer = token(issuer)) => {
    return new Promise<number>((resolve, reject) => {
      const request = httpRequest(
        runtime + path,
        {
          method: 'POST',
          headers: {
            host: 'runtime.example.test',
            authorization: `Bearer ${bearer}`,
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            ...headers,
          },
        },
        (response) => {
          response.resume();
          response.on('end', () => resolve(response.statusCode ?? 0));
        },
      );
      request.on('error', reject);
      request.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }));
    });
  };
  return { call, issuer, admitted };
}
describe('self-host trusted TLS proxy', () => {
  it('defaults to ignoring forwarded protocol headers', async () => {
    const app = await setup();
    expect(await app.call({ 'x-forwarded-proto': 'https' })).toBe(401);
    expect(app.admitted).toEqual([]);
  });
  it('keeps explicit false equivalent to the direct HTTP default', async () => {
    const app = await setup('false');
    expect(await app.call({ 'x-forwarded-proto': 'https' })).toBe(401);
    expect(app.admitted).toEqual([]);
  });
  it('accepts short-lived ES256 HTTPS-audience tokens and reaches real managed admission over HTTP', async () => {
    const app = await setup('true');
    expect(await app.call({ 'x-forwarded-proto': 'https' })).toBe(200);
    expect(app.admitted).toEqual([
      expect.objectContaining({
        version: 1,
        context: expect.objectContaining({
          subject: 'fixture-person',
          org: 'example',
          app: 'fixture',
          env: 'test',
          method: 'tools/list',
        }),
      }),
    ]);
  });
  it('requires HTTPS from the trusted proxy and does not use forwarded host for audience', async () => {
    const app = await setup('true');
    for (const headers of [{}, { 'x-forwarded-proto': 'http' }, { 'x-forwarded-proto': 'unknown' }])
      expect(await app.call(headers)).toBe(426);
    expect(
      await app.call({
        'x-forwarded-proto': 'https',
        host: 'other.example.test',
        'x-forwarded-host': 'runtime.example.test',
      }),
    ).toBe(401);
    expect(
      await app.call({ 'x-forwarded-proto': 'https', 'x-forwarded-host': 'other.example.test' }),
    ).toBe(200);
  });
  it('preserves issuer, resource and maximum lifetime checks behind the proxy', async () => {
    const app = await setup('true');
    for (const bearer of [
      token('http://127.0.0.1:1'),
      token(app.issuer, `${publicOrigin}/o/other/fixture/test/mcp`),
      token(app.issuer, publicOrigin + path, 600),
    ])
      expect(await app.call({ 'x-forwarded-proto': 'https' }, bearer)).toBe(401);
    expect(app.admitted).toEqual([]);
  });
  it('validates the boolean and requires a configured HTTPS public origin', () => {
    expect(resolveSelfHostConfig(environment()).trustProxy).toBe(false);
    expect(resolveSelfHostConfig({ ...environment(), NOODLE_TRUST_PROXY: 'true' }).trustProxy).toBe(
      true,
    );
    for (const value of ['1', 'yes', 'TRUE', ' true ', ''])
      expect(() => resolveSelfHostConfig({ ...environment(), NOODLE_TRUST_PROXY: value })).toThrow(
        'NOODLE_TRUST_PROXY',
      );
    expect(() =>
      resolveSelfHostConfig({
        ...environment(),
        NOODLE_TRUST_PROXY: 'true',
        PUBLIC_BASE_URL: 'http://localhost:8787',
      }),
    ).toThrow('PUBLIC_BASE_URL');
  });
});
