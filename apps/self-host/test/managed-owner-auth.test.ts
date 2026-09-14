import { createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { ServeServiceOptions } from '@noodle-borg/service';
import { noopLogger } from '@noodle-borg/transport-http';
import { afterEach, describe, expect, it } from 'vitest';

import { startSelfHostService } from '../src/main.js';

const PRIVATE_KEY = generateKeyPairSync('rsa', { modulusLength: 2_048 }).privateKey;
const PUBLIC_JWK = {
  ...createPublicKey(PRIVATE_KEY).export({ format: 'jwk' }),
  kid: 'owner-key',
  alg: 'RS256',
};
const RESOURCE = 'https://runtime.example.test/mcp/org-one/app-one/live';
const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

function signedToken(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'owner-key' })).toString(
    'base64url',
  );
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const input = `${header}.${body}`;
  return `${input}.${sign('RSA-SHA256', Buffer.from(input), PRIVATE_KEY).toString('base64url')}`;
}

async function verifier(managed = true) {
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ keys: [PUBLIC_JWK] }));
  });
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Missing JWKS address');
  const issuer = `http://127.0.0.1:${address.port}`;
  let verify: ServeServiceOptions['verifyOwnerToken'];
  await startSelfHostService(
    {
      DATABASE_URL: 'postgresql://noodle:password@database:5432/noodle',
      NOODLE_SECRET_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
      NOODLE_SELF_HOST_ADMIN_TOKEN: 'LQPPSnvpT4TMomooI4tXegZQJQFxeEJr2Sn9sYrZj9Y',
      NOODLE_ASSET_ROOT: '/var/lib/noodle/assets',
      NOODLE_ASSET_IDENTITY_SALT: Buffer.alloc(32, 9).toString('base64url'),
      NOODLE_OAUTH_ISSUER: issuer,
      NOODLE_OAUTH_JWKS_URI: `${issuer}/jwks`,
      ...(managed
        ? {
            NOODLE_ADMISSION_URL: `${issuer}/admit`,
            NOODLE_ADMISSION_TOKEN: '5AbpGdq-RSKQxCM8ErRJVcMFLEHe5DRBWgfSXJn46d0',
          }
        : {}),
    },
    {
      logger: noopLogger,
      serve: async (options) => {
        verify = options.verifyOwnerToken;
        return { close: async () => undefined };
      },
      onSigterm: () => undefined,
      setExitCode: () => undefined,
    },
  );
  if (verify === undefined) throw new Error('Missing owner verifier');
  const claims = {
    iss: issuer,
    sub: 'person-one',
    aud: RESOURCE,
    exp: Math.floor(Date.now() / 1_000) + 60,
  };
  return { verify, claims };
}

describe('managed external owner authentication', () => {
  it('accepts a short-lived signed resource token only as a customer', async () => {
    const { verify, claims } = await verifier();
    const token = signedToken({
      ...claims,
      scope: 'inventory:read',
      noodle_identity: 'platform',
      noodle_roles: ['admin'],
      noodle_grant_id: 'developer-grant',
      client_id: 'privileged-client',
    });
    const result = await verify(token, RESOURCE);
    expect(result).toEqual({
      caller: {
        subject: 'person-one',
        scopes: ['inventory:read'],
        roles: [],
        audience: RESOURCE,
        expiresAt: claims.exp,
        identityKind: 'customer',
      },
    });
  });

  it('does not carry a signed service principal binding into customer runtime authority', async () => {
    const { verify, claims } = await verifier();
    const token = signedToken({
      ...claims,
      noodle_identity: 'service',
      client_id: 'person-one',
      noodle_service_grant_id: 'machine-grant',
      noodle_service_credential_id: 'machine-credential',
    });
    const result = await verify(token, RESOURCE);
    expect(result).toEqual({
      caller: {
        subject: 'person-one',
        scopes: [],
        roles: [],
        audience: RESOURCE,
        expiresAt: claims.exp,
        identityKind: 'customer',
      },
    });
  });

  it('requires expiry instead of accepting an otherwise signed bearer indefinitely', async () => {
    const { verify, claims } = await verifier();
    const { exp: _expiry, ...withoutExpiry } = claims;
    await expect(verify(signedToken(withoutExpiry), RESOURCE)).resolves.toBeNull();
  });

  it.each([-1, 600, 3_600])('rejects expiry %s seconds from now', async (offset) => {
    const { verify, claims } = await verifier();
    const token = signedToken({ ...claims, exp: Math.floor(Date.now() / 1_000) + offset });
    await expect(verify(token, RESOURCE)).resolves.toBeNull();
  });

  it('rejects fractional expiry even when signature and remaining validity are valid', async () => {
    const { verify, claims } = await verifier();
    await expect(
      verify(signedToken({ ...claims, exp: claims.exp + 0.5 }), RESOURCE),
    ).resolves.toBeNull();
  });

  it.each([
    undefined,
    '',
  ])('requires a concrete resource audience at verification', async (resource) => {
    const { verify, claims } = await verifier();
    await expect(
      Reflect.apply(verify, undefined, [signedToken(claims), resource]),
    ).resolves.toBeNull();
  });

  it('rejects another resource audience', async () => {
    const { verify, claims } = await verifier();
    await expect(
      verify(signedToken({ ...claims, aud: 'https://other.example.test/mcp' }), RESOURCE),
    ).resolves.toBeNull();
  });

  it('rejects another issuer', async () => {
    const { verify, claims } = await verifier();
    await expect(
      verify(signedToken({ ...claims, iss: 'https://other.example.test' }), RESOURCE),
    ).resolves.toBeNull();
  });

  it('rejects a token whose signed payload was changed', async () => {
    const { verify, claims } = await verifier();
    const token = signedToken(claims).split('.');
    token[1] = Buffer.from(JSON.stringify({ ...claims, sub: 'other-person' })).toString(
      'base64url',
    );
    await expect(verify(token.join('.'), RESOURCE)).resolves.toBeNull();
  });

  it('preserves the existing external verifier when admission is not configured', async () => {
    const { verify, claims } = await verifier(false);
    const { exp: _expiry, ...withoutExpiry } = claims;
    const result = await verify(
      signedToken({ ...withoutExpiry, noodle_identity: 'platform', noodle_roles: ['admin'] }),
      RESOURCE,
    );
    expect(result).toMatchObject({ caller: { identityKind: 'platform', roles: ['admin'] } });
    expect(result?.caller.expiresAt).toBeUndefined();
  });
});
