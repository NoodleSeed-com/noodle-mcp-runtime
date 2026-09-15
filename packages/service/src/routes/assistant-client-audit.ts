import type { ControlPlaneIdentity } from '@noodle-borg/control-plane/portable';
import type { AuditSink } from '../store/audit.js';
import type { TenantRef } from '../store.js';

/** One safe projection for the assistant-client lifecycle; never accepts credentials or hashes. */
export async function emitAssistantClientAudit(
  audit: AuditSink,
  tenant: TenantRef,
  actor: Pick<ControlPlaneIdentity, 'subject' | 'email'> | undefined,
  action: 'created' | 'rotated' | 'revoked',
  client: { readonly id: string; readonly name?: string; readonly deploymentId?: string },
): Promise<void> {
  await audit.emit({
    eventType: `assistant.client.${action}`,
    org: tenant.org,
    app: tenant.app,
    env: tenant.env,
    ...(client.deploymentId ? { deploymentId: client.deploymentId } : {}),
    decision: 'allow',
    status: action === 'created' ? 201 : action === 'rotated' ? 200 : 204,
    ...(actor ? { actorSubject: actor.subject } : {}),
    ...(actor?.email ? { actorEmail: actor.email } : {}),
    details: { clientId: client.id, ...(action === 'created' ? { name: client.name } : {}) },
  });
}
