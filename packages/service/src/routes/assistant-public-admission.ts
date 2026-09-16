import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  authorizePublicConfiguration,
  publicEmbedTenant,
  publicSurfaceOf,
} from '@noodle-borg/assistant-gateway/portable';
import { sendJson } from '@noodle-borg/transport-http';
import { admitAssistantRequest } from '../assistant-admission.js';
import type { AssistantRouteDeps } from './assistant.js';
import { activeAssistantTarget } from './assistant-session-target.js';

/** Resolve and admit an exact public deployment before minting spends capacity or creates state. */
export async function admitPublicAssistantMint(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AssistantRouteDeps,
  embedId: unknown,
  origin: string | undefined,
): Promise<string | false | undefined> {
  if (!deps.admissionGate) return undefined;
  const embeds = deps.publicEmbeds;
  if (!embeds) return false;
  let target: Awaited<ReturnType<typeof activeAssistantTarget>>;
  const authorized = await authorizePublicConfiguration(
    { embedId, origin },
    {
      embeds,
      resolveActiveSurface: async (embed) => {
        target = await activeAssistantTarget(deps, publicEmbedTenant(embed));
        return publicSurfaceOf(target?.served.artifact.server.assistant);
      },
    },
  );
  if (!authorized.ok) {
    sendJson(res, authorized.status, { error: authorized.message, code: authorized.code });
    return false;
  }
  const selected = target;
  if (!selected?.deploymentId || origin === undefined) {
    sendJson(res, 409, { error: 'assistant deployment is unavailable' });
    return false;
  }
  const tenant = publicEmbedTenant(authorized.embed);
  const allowed = await admitAssistantRequest(
    req,
    res,
    deps.admissionGate,
    {
      tenant,
      deploymentId: selected.deploymentId,
      registry: deps.registry,
      caller: { subject: '', identityKind: 'anonymous' },
      publicEmbedId: authorized.embed.embedId,
      boundSurface: 'public',
      origin,
    },
    {
      method: 'assistant/public-sessions',
      category: 'protocol',
    },
  );
  return allowed ? selected.deploymentId : false;
}
