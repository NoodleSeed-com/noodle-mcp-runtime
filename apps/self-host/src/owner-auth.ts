import { TextDecoder } from 'node:util';
import {
  createJwtVerifier,
  createStaticSigningKeyProvider,
  type TokenVerifier,
} from '@noodle-borg/auth';
import type { ServeServiceOptions } from '@noodle-borg/service';
import { GoogleOAuthAuthenticator } from '@noodle-borg/service/oauth-google';

import type { SelfHostConfig } from './config.js';

type OwnerAuthOptions = Pick<
  ServeServiceOptions,
  'authServerIssuer' | 'verifyOwnerToken' | 'oauth'
>;

/** Map the validated self-host owner-auth group onto the portable service boundary. */
export async function ownerAuthOptions(
  config: SelfHostConfig['ownerAuth'],
  managedAdmission = false,
): Promise<OwnerAuthOptions> {
  if (config === undefined) return {};

  if (config.kind === 'external') {
    const verify = createJwtVerifier({
      issuer: config.issuer,
      jwksUri: config.jwksUri,
      ...(managedAdmission ? { trustNoodleRoles: false, trustNoodlePrivateClaims: false } : {}),
    });
    return {
      authServerIssuer: config.issuer,
      verifyOwnerToken: managedAdmission ? managedCustomerVerifier(verify) : verify,
    };
  }

  const privateKeyPem = decodeSigningKey(config.signingKeyBase64);
  try {
    return {
      oauth: {
        issuer: config.issuer,
        signer: await createStaticSigningKeyProvider({ privateKeyPem }),
        google: new GoogleOAuthAuthenticator({
          clientId: config.clientId,
          clientSecret: config.clientSecret,
          redirectUri: config.redirectUri,
        }),
        ...(config.allowedEmailDomain === undefined
          ? {}
          : { allowedEmailDomain: config.allowedEmailDomain }),
      },
    };
  } catch {
    throw signingKeyError();
  }
}

function managedCustomerVerifier(verify: TokenVerifier): TokenVerifier {
  return async (token, resource) => {
    if (resource === undefined || resource.trim().length === 0) return null;
    const verified = await verify(token, resource);
    if (verified === null) return null;
    const { caller } = verified;
    const { expiresAt } = caller;
    const now = Math.floor(Date.now() / 1_000);
    if (
      typeof expiresAt !== 'number' ||
      !Number.isSafeInteger(expiresAt) ||
      expiresAt <= now ||
      expiresAt > now + 300
    ) {
      return null;
    }
    return {
      caller: {
        subject: caller.subject,
        scopes: caller.scopes,
        roles: [],
        audience: resource,
        expiresAt,
        identityKind: 'customer',
        ...(caller.email === undefined ? {} : { email: caller.email }),
        ...(caller.name === undefined ? {} : { name: caller.name }),
        ...(caller.locale === undefined ? {} : { locale: caller.locale }),
        ...(caller.timeZone === undefined ? {} : { timeZone: caller.timeZone }),
        ...(caller.authTime === undefined ? {} : { authTime: caller.authTime }),
      },
    };
  };
}

function decodeSigningKey(value: string): string {
  try {
    const decoded = Buffer.from(value, 'base64');
    if (decoded.length === 0 || decoded.toString('base64') !== value) throw signingKeyError();
    const privateKeyPem = new TextDecoder('utf-8', { fatal: true }).decode(decoded);
    if (privateKeyPem.trim().length === 0) throw signingKeyError();
    return privateKeyPem;
  } catch {
    throw signingKeyError();
  }
}

function signingKeyError(): Error {
  return new Error(
    'self-host configuration: NOODLE_OAUTH_SIGNING_KEY_BASE64 must decode to a valid PKCS#8 PEM',
  );
}
