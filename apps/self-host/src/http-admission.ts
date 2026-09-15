import { parseAssistantExecutionPolicy, type ServeServiceOptions } from '@noodle-borg/service';

import type { SelfHostConfig } from './config.js';

type AdmissionGate = NonNullable<ServeServiceOptions['admissionGate']>;
type AdmissionDecision = Awaited<ReturnType<AdmissionGate>>;
const MAX_RESPONSE_BYTES = 16 * 1_024;

const UNAVAILABLE = { allow: false, reason: 'admission_unavailable', status: 403 } as const;

/** Query an operator-configured policy endpoint without moving product policy into the runtime. */
export function createHttpAdmissionGate(
  config: NonNullable<SelfHostConfig['admission']>,
): AdmissionGate {
  if (config.googleAudience !== undefined) {
    const policy = new URL(config.url);
    const audience = new URL(config.googleAudience);
    if (
      policy.protocol !== 'https:' ||
      !policy.hostname.endsWith('.run.app') ||
      policy.username ||
      policy.password ||
      policy.port ||
      audience.origin !== policy.origin ||
      config.googleAudience !== audience.origin
    ) {
      throw new Error('Google admission identity requires the same HTTPS Cloud Run origin');
    }
  }
  let identity: { token: string; expiresAt: number } | undefined;
  return async (context) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs ?? 2_000);
    try {
      if (
        config.googleAudience !== undefined &&
        (identity === undefined || identity.expiresAt - 60_000 <= Date.now())
      ) {
        identity = await fetchGoogleIdentity(config.googleAudience, controller.signal);
      }
      const response = await fetch(config.url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.token}`,
          ...(identity === undefined
            ? {}
            : { 'x-serverless-authorization': `Bearer ${identity.token}` }),
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({ version: 1, context }),
        redirect: 'error',
        signal: controller.signal,
      });
      if (!response.ok || response.body === null) return UNAVAILABLE;

      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.byteLength;
        if (size > MAX_RESPONSE_BYTES) return UNAVAILABLE;
        chunks.push(chunk);
      }
      const body = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size));
      return parseDecision(JSON.parse(body));
    } catch {
      return UNAVAILABLE;
    } finally {
      clearTimeout(timeout);
      controller.abort();
    }
  };
}

function parseDecision(value: unknown): AdmissionDecision {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return UNAVAILABLE;
  const keys = Object.keys(value);
  if ('allow' in value && value.allow === true) {
    if (keys.length === 1) return { allow: true };
    if (keys.length !== 2 || !('assistantExecution' in value)) return UNAVAILABLE;
    const policy = parseAssistantExecutionPolicy(value.assistantExecution);
    return policy === undefined ? UNAVAILABLE : { allow: true, assistantExecution: policy };
  }
  if (
    !('allow' in value) ||
    value.allow !== false ||
    !('reason' in value) ||
    typeof value.reason !== 'string' ||
    !/^[a-z][a-z0-9_]{0,63}$/.test(value.reason) ||
    value.reason.trim() !== value.reason ||
    keys.some((key) => key !== 'allow' && key !== 'reason' && key !== 'status')
  ) {
    return UNAVAILABLE;
  }
  if ('status' in value) {
    if (value.status !== 403 && value.status !== 429) return UNAVAILABLE;
    return { allow: false, reason: value.reason, status: value.status };
  }
  return { allow: false, reason: value.reason };
}

/** Fixed metadata endpoint. Audience-bound ID tokens only reach the matching Cloud Run origin. */
async function fetchGoogleIdentity(
  audience: string,
  signal: AbortSignal,
): Promise<{ token: string; expiresAt: number }> {
  const url = new URL(
    'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity',
  );
  url.searchParams.set('audience', audience);
  url.searchParams.set('format', 'full');
  const response = await fetch(url, {
    headers: { 'metadata-flavor': 'Google' },
    redirect: 'error',
    signal,
  });
  if (
    !response.ok ||
    response.headers.get('metadata-flavor') !== 'Google' ||
    response.body === null
  )
    throw new Error('identity unavailable');
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > MAX_RESPONSE_BYTES) throw new Error('identity unavailable');
    chunks.push(chunk);
  }
  const token = Buffer.concat(chunks).toString('utf8');
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token))
    throw new Error('identity unavailable');
  const payload: unknown = JSON.parse(
    Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'),
  );
  if (
    typeof payload !== 'object' ||
    payload === null ||
    !('exp' in payload) ||
    typeof payload.exp !== 'number' ||
    !Number.isSafeInteger(payload.exp) ||
    !('aud' in payload) ||
    payload.aud !== audience ||
    payload.exp * 1000 <= Date.now() + 60_000
  )
    throw new Error('identity unavailable');
  return { token, expiresAt: payload.exp * 1000 };
}
