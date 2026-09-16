import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AssistantSessionRecord } from '@noodle-borg/assistant-gateway/portable';
import type { AdmissionCategory, AdmissionContext, AdmissionGate } from '@noodle-borg/module';
import { type AssistantExecutionPolicy, parseAssistantExecutionPolicy } from '@noodle-borg/module';
import { sendJson } from '@noodle-borg/transport-http';
import type { ServerRegistry } from './registry.js';

type AssistantAdmissionIdentity = Pick<
  AssistantSessionRecord,
  'tenant' | 'deploymentId' | 'caller'
> &
  Partial<Pick<AssistantSessionRecord, 'publicEmbedId' | 'boundSurface' | 'origin'>> & {
    readonly registry?: Pick<ServerRegistry, 'listDeployments' | 'get'>;
  };
type AssistantAdmissionOperation = Pick<
  AdmissionContext,
  'method' | 'category' | 'name' | 'serverVersion' | 'assistantExecution'
>;

/** Service-level assistant policy; MCP and public embed capacity accounting remain separate owners. */
export async function admitAssistantRequest(
  req: IncomingMessage,
  res: ServerResponse,
  gate: AdmissionGate | undefined,
  identity: AssistantAdmissionIdentity,
  operation?: AssistantAdmissionOperation,
  executionPolicy?: (policy: AssistantExecutionPolicy) => void,
): Promise<boolean> {
  if (gate === undefined && executionPolicy === undefined) return true;
  const routeId = new URL(req.url ?? '/', 'http://assistant.invalid').pathname;
  let context: AdmissionContext = {
    routeId,
    ...identity.tenant,
    ...(identity.caller.identityKind === 'anonymous' ? {} : { subject: identity.caller.subject }),
    deploymentId: identity.deploymentId,
    ...(identity.publicEmbedId !== undefined &&
    identity.boundSurface === 'public' &&
    identity.origin !== undefined
      ? {
          assistantSurface: {
            kind: 'public' as const,
            origin: identity.origin,
            publicEmbedId: identity.publicEmbedId,
          },
        }
      : {}),
    ...(operation ?? sessionOperation(routeId)),
    ...(req.socket.remoteAddress === undefined ? {} : { remoteAddress: req.socket.remoteAddress }),
  };
  let status: 403 | 429 = 403;
  try {
    if (context.assistantSurface !== undefined) {
      const record = (await identity.registry?.listDeployments(identity.tenant))?.find(
        (candidate) => candidate.deploymentId === identity.deploymentId,
      );
      if (!record) throw new Error('public deployment unavailable');
      const serverVersion =
        record.serverVersion ??
        (await identity.registry?.get(record.deploymentId))?.served.artifact.server.version;
      if (!serverVersion) throw new Error('public deployment version unavailable');
      context = { ...context, serverVersion, accessMode: record.accessMode ?? 'owner-only' };
    }
    const decision = await gate?.(context);
    if (decision?.allow === true) {
      const policy =
        decision.assistantExecution === undefined
          ? undefined
          : parseAssistantExecutionPolicy(decision.assistantExecution);
      if (decision.assistantExecution !== undefined && policy === undefined)
        throw new Error('invalid policy');
      if (executionPolicy !== undefined && policy === undefined)
        throw new Error('execution policy required');
      if (policy !== undefined) executionPolicy?.(policy);
      return true;
    }
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
    method === 'assistant/transcript' || method === 'assistant/operations/status'
      ? 'read'
      : method === 'assistant/turns' ||
          method === 'assistant/suggestions' ||
          method === 'assistant/interactions' ||
          method === 'assistant/tool-confirmations'
        ? 'execute'
        : 'protocol';
  return { method, category };
}
