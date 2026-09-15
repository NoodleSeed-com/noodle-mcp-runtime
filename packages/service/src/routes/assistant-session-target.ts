import {
  type AssistantSessionRecord,
  assistantConfigurationHasBusinessNotice,
  resolveAssistantSessionTarget,
} from '@noodle-borg/assistant-gateway/portable';
import { type RuntimeTargetResolver, resolveTargetOrigins } from '../application-runtime-target.js';
import type { ServerRegistry } from '../registry.js';
import type { TenantRef } from '../store.js';

/** Adapt the registry to the gateway-owned, surface-projected session target decision. */
export async function sessionScopedTarget(
  registry: Pick<ServerRegistry, 'get'>,
  session: AssistantSessionRecord,
  resolve: RuntimeTargetResolver = resolveTargetOrigins,
  req?: Pick<IncomingMessage, 'socket'>,
) {
  const target = await resolveAssistantSessionTarget(async (deploymentId) => {
    const target = await registry.get(deploymentId);
    return target && resolve(target);
  }, session);
  if (target === undefined) return undefined;
  if (
    target.businessNotice &&
    !assistantConfigurationHasBusinessNotice(session.configuration, target.businessNotice)
  )
    return undefined;
  const publicAdmission = trustedPublicAdmission({
    scope: `${session.tenant.org}/${session.tenant.app}/${session.tenant.env}`,
    sourceAddress: req?.socket?.remoteAddress,
    subject: session.caller.subject,
  });
  return {
    ...target,
    served: {
      ...target.served,
      deps: {
        ...target.served.deps,
        ...(publicAdmission === undefined ? {} : { publicAdmission }),
      },
    },
  };
}

export async function activeAssistantTarget(
  deps: {
    readonly registry: ServerRegistry;
    readonly resolveRuntimeTarget?: RuntimeTargetResolver;
  },
  tenant: TenantRef,
  serverVersion?: string,
) {
  const target =
    serverVersion === undefined
      ? await deps.registry.getActiveByTenant(tenant)
      : await deps.registry.getActiveByTenantVersion(tenant, serverVersion);
  return target && (deps.resolveRuntimeTarget ?? resolveTargetOrigins)(target);
}

import type { IncomingMessage } from 'node:http';
import { trustedPublicAdmission } from '@noodle-borg/admission-limits/portable';

/** Receipt uses the selected deployment record, never the request's version hint. */
export async function assistantSessionTargetReceipt(
  registry: ServerRegistry,
  tenant: TenantRef,
  deploymentId: string,
  legacyVersion: string,
) {
  const record = (await registry.listDeployments(tenant)).find(
    (candidate) => candidate.deploymentId === deploymentId,
  );
  return record
    ? {
        ...tenant,
        deploymentId: record.deploymentId,
        serverVersion: record.serverVersion ?? legacyVersion,
      }
    : undefined;
}
