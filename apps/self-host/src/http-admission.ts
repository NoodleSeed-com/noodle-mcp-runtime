import type { ServeServiceOptions } from '@noodle-borg/service';

import type { SelfHostConfig } from './config.js';

type AdmissionGate = NonNullable<ServeServiceOptions['admissionGate']>;
type AdmissionDecision = Awaited<ReturnType<AdmissionGate>>;
const MAX_RESPONSE_BYTES = 16 * 1_024;
const TIMEOUT_MS = 2_000;
const UNAVAILABLE = { allow: false, reason: 'admission_unavailable', status: 403 } as const;

/** Query an operator-configured policy endpoint without moving product policy into the runtime. */
export function createHttpAdmissionGate(
  config: NonNullable<SelfHostConfig['admission']>,
): AdmissionGate {
  return async (context) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetch(config.url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.token}`,
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
  if ('allow' in value && value.allow === true && keys.length === 1) return { allow: true };
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
