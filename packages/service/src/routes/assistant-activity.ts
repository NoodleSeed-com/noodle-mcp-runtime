import { randomUUID } from 'node:crypto';
import type { AssistantSessionRecord } from '@noodle-borg/assistant-gateway/portable';
import {
  ACTIVITY_RETENTION_MS,
  type ActivityEnvelope,
  type ActivityFinished,
  type ActivityTurnIdentity,
} from '@noodle-borg/module';
import { activityEnvelopeSchema, boundActivityText } from './activity-schema.js';
import type { AssistantRouteDeps } from './assistant.js';
export interface CapturedAssistantTurn {
  readonly identity: ActivityTurnIdentity;
  readonly expiresAt: string;
  readonly monotonicStart: number;
}
export async function startAssistantActivity(
  deps: AssistantRouteDeps,
  session: AssistantSessionRecord,
  message: string,
  operationId?: string,
): Promise<CapturedAssistantTurn | undefined> {
  if (!deps.activityOutbox) return undefined;
  try {
    if (!deps.store.nextActivityOrdinal) throw new Error('Activity ordinals unavailable');
    const startedAt = (deps.clock?.() ?? new Date()).toISOString();
    const identity: ActivityTurnIdentity = {
      sessionId: session.id,
      turnId: operationId ?? randomUUID(),
      ordinal: await deps.store.nextActivityOrdinal(session.id),
      startedAt,
      channel: session.publicEmbedId
        ? 'website_embed'
        : session.tenant.env === 'test'
          ? 'private_test'
          : 'unknown',
    };
    const state = {
      identity,
      expiresAt: new Date(Date.parse(startedAt) + ACTIVITY_RETENTION_MS).toISOString(),
      monotonicStart: performance.now(),
    };
    const user = boundActivityText(message);
    await deps.activityOutbox.append(
      activityEnvelopeSchema.parse({
        schemaVersion: 1,
        id: randomUUID(),
        kind: 'assistant.turn.started',
        occurredAt: startedAt,
        expiresAt: state.expiresAt,
        tenant: session.tenant,
        deploymentId: session.deploymentId,
        payload: {
          ...identity,
          userText: user.text,
          userTextTruncated: user.truncated,
          ...(session.publicEmbedId ? { embedId: session.publicEmbedId } : {}),
        },
      }),
    );
    return state;
  } catch {
    deps.logger?.warn('activity.capture.failed', { kind: 'assistant.turn.started' });
    return undefined;
  }
}
export function finishedAssistantActivity(
  deps: AssistantRouteDeps,
  session: AssistantSessionRecord,
  state: CapturedAssistantTurn,
  text: string,
  outcome: ActivityFinished['outcome'],
  errorCode?: string,
): ActivityEnvelope {
  const bounded = boundActivityText(text);
  return activityEnvelopeSchema.parse({
    schemaVersion: 1,
    id: randomUUID(),
    kind: 'assistant.turn.finished',
    occurredAt: (deps.clock?.() ?? new Date()).toISOString(),
    expiresAt: state.expiresAt,
    tenant: session.tenant,
    deploymentId: session.deploymentId,
    payload: {
      ...state.identity,
      assistantText: bounded.text,
      assistantTextTruncated: bounded.truncated,
      outcome,
      durationMs: performance.now() - state.monotonicStart,
      ...(errorCode ? { errorCode } : {}),
    },
  });
}
