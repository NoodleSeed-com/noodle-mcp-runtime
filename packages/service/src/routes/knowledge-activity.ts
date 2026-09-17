import { randomUUID } from 'node:crypto';
import { searchRequestSchema } from '@noodle-borg/knowledge/portable';
import {
  ACTIVITY_RETENTION_MS,
  type ActivityChannel,
  type ActivityEnvelope,
} from '@noodle-borg/module';
import type { ExecuteDeps, KnowledgeSearchPort } from '@noodle-borg/runtime';
import type { ServedTarget } from '@noodle-borg/transport-http';
import { activityEnvelopeSchema } from './activity-schema.js';
export interface KnowledgeActivityContext {
  readonly tenant: { readonly org: string; readonly app: string; readonly env: string };
  readonly deploymentId: string;
  readonly channel: ActivityChannel;
  readonly sessionId?: string;
  readonly turnId?: string;
  readonly turnStartedAt?: string;
}
/** Correlation is passed by authenticated server execution; no request arguments supply it. */
export function captureKnowledgePort(
  port: KnowledgeSearchPort,
  context: KnowledgeActivityContext,
  components: readonly {
    readonly name: string;
    readonly generatedTool: { readonly name: string };
  }[],
  capture: (event: ActivityEnvelope) => Promise<void>,
  diagnose: () => void = () => {},
): KnowledgeSearchPort {
  return {
    enabled: () => port.enabled(),
    async search(componentName, request) {
      const started = performance.now();
      const outcome = await port.search(componentName, request);
      // Invalid inputs are never archived; the native boundary remains authoritative.
      const validated = searchRequestSchema.safeParse(request);
      if (validated.success) {
        const occurredAt = new Date().toISOString();
        const event: ActivityEnvelope = {
          schemaVersion: 1,
          id: randomUUID(),
          kind: 'knowledge.search.finished',
          occurredAt,
          expiresAt: new Date(
            Date.parse(context.turnStartedAt ?? occurredAt) + ACTIVITY_RETENTION_MS,
          ).toISOString(),
          tenant: context.tenant,
          deploymentId: context.deploymentId,
          payload: {
            invocationId: randomUUID(),
            componentName,
            toolName:
              components.find((c) => c.name === componentName)?.generatedTool.name ??
              `search_${componentName}`,
            query: request.query,
            limit: validated.data.limit,
            hits: outcome.ok ? outcome.hits : [],
            durationMs: performance.now() - started,
            outcome: outcome.ok ? (outcome.hits.length ? 'success' : 'empty') : 'error',
            channel: context.channel,
            ...(context.sessionId ? { sessionId: context.sessionId } : {}),
            ...(context.turnId ? { turnId: context.turnId } : {}),
            ...(context.turnStartedAt ? { turnStartedAt: context.turnStartedAt } : {}),
            ...(!outcome.ok ? { errorCode: outcome.reason } : {}),
          },
        };
        try {
          await capture(activityEnvelopeSchema.parse(event));
        } catch {
          diagnose();
        }
      }
      return outcome;
    },
  };
}
export function withKnowledgeActivity<T extends ServedTarget>(
  target: T,
  context: KnowledgeActivityContext,
  capture: (event: ActivityEnvelope) => Promise<void>,
  diagnose: () => void,
): T {
  const deps = target.served.deps as ExecuteDeps;
  if (!deps.knowledgeSearch) return target;
  return {
    ...target,
    served: {
      ...target.served,
      deps: {
        ...deps,
        knowledgeSearch: captureKnowledgePort(
          deps.knowledgeSearch,
          context,
          target.served.artifact.server.knowledge ?? [],
          capture,
          diagnose,
        ),
      },
    },
  };
}
