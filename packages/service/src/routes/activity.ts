import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DeployAuthGate } from '@noodle-borg/control-plane/portable';
import type { ActivityOutbox } from '@noodle-borg/module';
import { readJsonBody, sendJson } from '@noodle-borg/transport-http';
import { z } from 'zod';
import type { ControlPlaneStore } from '../store.js';
import { authorizeTenantControl } from './control-plane.js';

const claim = z.strictObject({ limit: z.number().int().min(1).max(50) });
const ack = z.strictObject({ leaseToken: z.uuid(), eventIds: z.array(z.uuid()).max(50) });
export async function handleActivityExport(
  req: IncomingMessage,
  res: ServerResponse,
  org: string,
  action: 'claim' | 'ack',
  deps: { gate: DeployAuthGate; controlPlane: ControlPlaneStore; outbox: ActivityOutbox },
): Promise<void> {
  if ((await authorizeTenantControl(req, res, deps.gate, deps.controlPlane, org)) === false) return;
  res.setHeader('cache-control', 'no-store');
  const body = await readJsonBody(req, 8192);
  if (!body.ok) return sendJson(res, body.status, { error: body.error });
  if (action === 'claim') {
    const parsed = claim.safeParse(body.value);
    if (!parsed.success) return sendJson(res, 400, { error: 'invalid activity claim' });
    return sendJson(res, 200, await deps.outbox.claim(org, parsed.data.limit));
  }
  const parsed = ack.safeParse(body.value);
  if (!parsed.success) return sendJson(res, 400, { error: 'invalid activity acknowledgement' });
  return sendJson(res, 200, {
    acknowledged: await deps.outbox.ack(org, parsed.data.leaseToken, parsed.data.eventIds),
  });
}
