import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ControlPlaneIdentity } from '@noodle-borg/control-plane/portable';
import { readJsonBody, sendJson } from '@noodle-borg/transport-http';
import { ensureAssistantClientRequestSchema } from '@noodle-borg/wire-contracts';
import type { TenantRef } from '../store.js';
import type { AssistantRouteDeps } from './assistant.js';
import { emitAssistantClientAudit } from './assistant-client-audit.js';
import { now } from './assistant-route-http.js';
import { activeAssistantTarget } from './assistant-session-target.js';

/** Called only after the same control-plane authorization as legacy client management. */
export async function handleAssistantClientEnsure(
  req: IncomingMessage,
  res: ServerResponse,
  tenant: TenantRef,
  id: string,
  deps: AssistantRouteDeps,
  actor: Pick<ControlPlaneIdentity, 'subject' | 'email'> | undefined,
): Promise<void> {
  const body = await readJsonBody(req, Math.min(deps.maxBody, 4096));
  if (!body.ok) return sendJson(res, body.status, { error: body.error });
  const request = ensureAssistantClientRequestSchema.safeParse({
    id,
    idempotencyKey: req.headers['idempotency-key'],
    body: body.value,
  });
  if (!request.success) return sendJson(res, 400, { error: 'invalid assistant client request' });
  const input = {
    id,
    tenant,
    ...request.data.body,
    idempotencyKey: request.data.idempotencyKey,
    now: now(deps),
  };
  let result = await deps.store.ensureClient(input);
  if (result.disposition === 'missing') {
    const target = await activeAssistantTarget({ registry: deps.registry }, tenant);
    const assistant = target?.served.artifact.server.assistant;
    if (!target?.deploymentId || !assistant)
      return sendJson(res, 409, { error: 'assistant deployment is unavailable' });
    result = await deps.store.ensureClient({
      ...input,
      creation: { deploymentId: target.deploymentId, allowedOrigins: assistant.allowedOrigins },
    });
  }
  if (result.disposition !== 'created' && result.disposition !== 'replayed') {
    return sendJson(res, 409, {
      error: result.disposition === 'conflict' ? 'idempotency_conflict' : 'client_unavailable',
    });
  }
  const { client, disposition } = result;
  const status = disposition === 'created' ? 201 : 200;
  if (disposition === 'created')
    await emitAssistantClientAudit(deps.audit, tenant, actor, 'created', client);
  return sendJson(res, status, {
    ok: true,
    id: client.id,
    name: client.name,
    createdAt: client.createdAt,
    createdAgainstDeploymentId: client.deploymentId,
    disposition,
  });
}
