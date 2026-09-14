import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AssistantSessionRecord } from '@noodle-borg/assistant-gateway/portable';
import type { AdmissionCategory, AdmissionContext, AdmissionGate } from '@noodle-borg/module';
import { sendJson } from '@noodle-borg/transport-http';

type AssistantAdmissionIdentity = Pick<
  AssistantSessionRecord,
  'tenant' | 'deploymentId' | 'caller'
>;
type AssistantAdmissionOperation = Pick<AdmissionContext, 'method' | 'category' | 'name'>;

/** Service-level assistant policy; MCP and public embed capacity accounting remain separate owners. */
export async function admitAssistantRequest(
  req: IncomingMessage,
  res: ServerResponse,
  gate: AdmissionGate | undefined,
  identity: AssistantAdmissionIdentity,
  operation?: AssistantAdmissionOperation,
): Promise<boolean> {
  if (gate === undefined) return true;
  const routeId = new URL(req.url ?? '/', 'http://assistant.invalid').pathname;
  const context: AdmissionContext = {
    routeId,
    ...identity.tenant,
    ...(identity.caller.identityKind === 'anonymous' ? {} : { subject: identity.caller.subject }),
    deploymentId: identity.deploymentId,
    ...(operation ?? sessionOperation(routeId)),
    ...(req.socket.remoteAddress === undefined ? {} : { remoteAddress: req.socket.remoteAddress }),
  };
  let status: 403 | 429 = 403;
  try {
    const decision = await gate(context);
    if (decision?.allow === true) return true;
    if (decision?.allow === false) {
      status = decision.status === 429 ? 429 : 403;
      if (
        decision.retryAfterSeconds !== undefined &&
        Number.isFinite(decision.retryAfterSeconds) &&
        decision.retryAfterSeconds >= 0
      ) {
        res.setHeader('Retry-After', String(Math.ceil(decision.retryAfterSeconds)));
      }
    }
  } catch {
    // An unavailable policy cannot authorize a request or expose its private callback details.
  }
  sendJson(res, status, {
    error: 'assistant request denied',
    code: 'assistant_admission_denied',
  });
  return false;
}

/** Supported apps operations retain their MCP categories; unsupported methods remain protocol work. */
export function assistantAppAdmissionOperation(
  method: string,
  params: Readonly<Record<string, unknown>>,
): AssistantAdmissionOperation {
  const category: AdmissionCategory =
    method === 'tools/call'
      ? 'execute'
      : method === 'resources/read'
        ? 'read'
        : method === 'tools/list' || method === 'resources/list'
          ? 'discovery'
          : 'protocol';
  const name =
    method === 'tools/call' ? params.name : method === 'resources/read' ? params.uri : undefined;
  return { method, category, ...(typeof name === 'string' ? { name } : {}) };
}

function sessionOperation(routeId: string): AssistantAdmissionOperation {
  const method = routeId.replace(/^\/v1\//, '');
  const category: AdmissionCategory =
    method === 'assistant/transcript'
      ? 'read'
      : method === 'assistant/turns' ||
          method === 'assistant/suggestions' ||
          method === 'assistant/interactions' ||
          method === 'assistant/tool-confirmations'
        ? 'execute'
        : 'protocol';
  return { method, category };
}
