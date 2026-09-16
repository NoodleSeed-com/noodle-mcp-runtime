import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  permitAssistantModelExecution,
  type ResolvedAssistantModel,
} from '@noodle-borg/assistant-gateway/model-runtime';
import {
  type AssistantOperationScope,
  type AssistantSessionRecord,
  assistantOperationDigest,
} from '@noodle-borg/assistant-gateway/portable';
import type { AssistantExecutionPolicy } from '@noodle-borg/module';
import { readJsonBody, type ServedTarget, sendJson } from '@noodle-borg/transport-http';
import {
  type AssistantMessageTurnRequest,
  assistantOperationPrepareSchema,
  assistantOperationStatusSchema,
} from '@noodle-borg/wire-contracts';
import { admitAssistantRequest } from '../assistant-admission.js';
import type { AssistantRouteDeps } from './assistant.js';
import { resolveAssistantModelBinding } from './assistant-model-binding.js';
import { applyBrowserCors, authenticateSession } from './assistant-route-http.js';
import { assistantSessionTargetReceipt, sessionScopedTarget } from './assistant-session-target.js';

async function operationScope(
  deps: AssistantRouteDeps,
  session: AssistantSessionRecord,
  target: ServedTarget,
): Promise<AssistantOperationScope | undefined> {
  const receipt = await assistantSessionTargetReceipt(
    deps.registry,
    session.tenant,
    session.deploymentId,
    target.served.artifact.server.version,
  );
  return (
    receipt && {
      sessionId: session.id,
      clientId: session.clientId,
      tenant: session.tenant,
      deploymentId: session.deploymentId,
      serverVersion: receipt.serverVersion,
      origin: session.origin,
    }
  );
}

/** Preparation/status never resolve provider credentials or perform model work. */
export async function handleAssistantOperation(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AssistantRouteDeps,
  status: boolean,
): Promise<void> {
  const session = await authenticateSession(req, res, deps);
  if (!session) return;
  applyBrowserCors(req, res, session.origin);
  const target = await sessionScopedTarget(deps.registry, session, deps.resolveRuntimeTarget, req);
  if (!target) return sendJson(res, 409, { error: 'assistant deployment is unavailable' });
  const scope = await operationScope(deps, session, target);
  if (!scope) return sendJson(res, 409, { error: 'assistant deployment is unavailable' });
  const body = await readJsonBody(req, deps.maxBody);
  if (!body.ok) return sendJson(res, body.status, { error: body.error });
  if (status) {
    const parsed = assistantOperationStatusSchema.safeParse(body.value);
    if (!parsed.success) return sendJson(res, 400, { error: 'invalid operation status request' });
    const operation = await deps.store.operations.get(parsed.data.operationId, scope);
    return sendJson(res, operation ? 200 : 404, operation ?? { error: 'operation not found' });
  }
  const parsed = assistantOperationPrepareSchema.safeParse(body.value);
  if (!parsed.success) return sendJson(res, 400, { error: 'invalid operation preparation' });
  const operation = await deps.store.operations.prepare({
    ...scope,
    requestKey: parsed.data.requestKey,
    requestDigest: assistantOperationDigest(parsed.data.turn),
  });
  sendJson(
    res,
    operation ? 201 : 409,
    operation ?? { error: 'assistant operation conflicts', code: 'assistant_operation_conflict' },
  );
}

export interface ClaimedAssistantExecution {
  readonly operationId: string;
  readonly scope: AssistantOperationScope;
  readonly binding: ResolvedAssistantModel;
}
/** Durable compare-and-set precedes the external gate and all provider I/O. Never reclaim a loss. */
export async function claimAssistantExecution(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AssistantRouteDeps,
  session: AssistantSessionRecord,
  target: ServedTarget,
  turn: AssistantMessageTurnRequest,
): Promise<ClaimedAssistantExecution | undefined> {
  const { operationId, ...body } = turn;
  const scope = await operationScope(deps, session, target);
  if (!operationId || !scope) {
    sendJson(res, 403, { error: 'assistant execution operation required' });
    return undefined;
  }
  const requestDigest = assistantOperationDigest(body);
  if (!(await deps.store.operations.claim(operationId, { ...scope, requestDigest }))) {
    const operation = await deps.store.operations.get(operationId, scope);
    sendJson(res, 409, {
      error: 'assistant operation conflicts',
      code: 'assistant_operation_conflict',
      ...operation,
    });
    return undefined;
  }
  try {
    const binding = await resolveAssistantModelBinding(
      target,
      session.tenant,
      session.deploymentId,
      deps,
    );
    let policy: AssistantExecutionPolicy | undefined;
    if (
      !binding ||
      !(await admitAssistantRequest(
        req,
        res,
        deps.admissionGate,
        { ...session, registry: deps.registry },
        {
          method: 'assistant/turns',
          category: 'execute',
          serverVersion: scope.serverVersion,
          assistantExecution: {
            sessionId: scope.sessionId,
            clientId: scope.clientId,
            operationId,
            requestDigest,
            model: {
              source: binding.source,
              transport: binding.transport ?? 'chat-completions',
              baseUrl: binding.baseUrl,
              model: binding.model,
            },
          },
        },
        (allowed) => {
          policy = allowed;
        },
      ))
    ) {
      await deps.store.operations.finish(operationId, scope, 'denied');
      if (!res.headersSent) sendJson(res, 403, { error: 'assistant model execution unavailable' });
      return undefined;
    }
    if (!policy) throw new Error('missing execution policy');
    return { operationId, scope, binding: permitAssistantModelExecution(binding, policy) };
  } catch {
    await deps.store.operations.finish(operationId, scope, 'unknown');
    if (!res.headersSent) sendJson(res, 403, { error: 'assistant model execution unavailable' });
    return undefined;
  }
}
