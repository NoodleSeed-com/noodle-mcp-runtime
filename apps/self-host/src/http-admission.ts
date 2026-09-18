import { parseAssistantExecutionPolicy, type ServeServiceOptions } from '@noodle-borg/service';
import type { SelfHostConfig } from './config.js';
import { createOperatorJsonPost } from './operator-http.js';

type AdmissionGate = NonNullable<ServeServiceOptions['admissionGate']>;
type AdmissionDecision = Awaited<ReturnType<AdmissionGate>>;
const MAX_RESPONSE_BYTES = 16 * 1_024;

const UNAVAILABLE = { allow: false, reason: 'admission_unavailable', status: 403 } as const;

/** Query an operator-configured policy endpoint without moving product policy into the runtime. */
export function createHttpAdmissionGate(
  config: NonNullable<SelfHostConfig['admission']>,
): AdmissionGate {
  const post = createOperatorJsonPost(config);
  return async (context) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs ?? 2_000);
    try {
      const response = await post({ version: 1, context }, controller.signal);
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
