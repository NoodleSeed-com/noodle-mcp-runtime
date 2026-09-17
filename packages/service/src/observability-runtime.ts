import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DeployAuthGate } from '@noodle-borg/control-plane/portable';
import type { IntentEventStore, RequestEventStore } from '@noodle-borg/module';
import {
  InMemoryIntentCaptureSettingsStore,
  InMemoryIntentEventStore,
  InMemoryRequestEventStore,
  type IntentCaptureSettingsStore,
} from '@noodle-borg/observability';
import {
  applySecurityHeaders,
  enforceHttps,
  type ServedTarget,
  sendJson,
  type TenantRouteRef,
  type TlsPosture,
} from '@noodle-borg/transport-http';
import type { ServiceOptions } from './options.js';
import type { ServerRegistry } from './registry.js';
import { handleActivityExport } from './routes/activity.js';
import { dispatchAnalyticsReads } from './routes/analytics-dispatch.js';
import { dispatchIntentCaptureRoutes } from './routes/intent-capture-dispatch.js';
import { withKnowledgeActivity } from './routes/knowledge-activity.js';
import type { AuditSink } from './store/audit.js';
import type { ControlPlaneStore } from './store.js';

export function createObservabilityStores(options: ServiceOptions) {
  return [
    options.intentCaptureSettingsStore ?? new InMemoryIntentCaptureSettingsStore(),
    options.intentEventStore ?? new InMemoryIntentEventStore(),
    options.requestEventStore ?? new InMemoryRequestEventStore(),
    new Set(options.intentCapturePreviewOrgs ?? []),
  ] as const;
}

async function resolveIntentMode(
  target: Awaited<ReturnType<ServerRegistry['getServing']>>,
  ref: TenantRouteRef | undefined,
  previewOrgs: ReadonlySet<string>,
  settings: IntentCaptureSettingsStore,
): Promise<ServedTarget | undefined> {
  if (target === undefined) return undefined;
  const resolved =
    ref ??
    (target.org !== undefined && target.app !== undefined && target.environment !== undefined
      ? { org: target.org, app: target.app, env: target.environment }
      : undefined);
  if (resolved === undefined || !previewOrgs.has(resolved.org)) return target;
  try {
    const setting = await settings.get(resolved);
    return { ...target, intentCaptureMode: setting?.mode ?? 'off' };
  } catch {
    return target;
  }
}

export function createIntentTargetResolver(
  settings: IntentCaptureSettingsStore,
  previewOrgs: ReadonlySet<string>,
  options?: ServiceOptions,
) {
  return (
    target: Awaited<ReturnType<ServerRegistry['getServing']>>,
    ref?: TenantRouteRef,
  ): Promise<ServedTarget | undefined> =>
    resolveIntentMode(target, ref, previewOrgs, settings).then((resolved) => {
      if (
        !resolved ||
        !options?.activityOutbox ||
        !resolved.org ||
        !resolved.app ||
        !resolved.environment ||
        !resolved.deploymentId
      )
        return resolved;
      return withKnowledgeActivity(
        resolved,
        {
          tenant: { org: resolved.org, app: resolved.app, env: resolved.environment },
          deploymentId: resolved.deploymentId,
          channel: 'external_mcp',
        },
        (event) => options.activityOutbox!.append(event),
        () =>
          options.logger?.warn('activity.capture.failed', { kind: 'knowledge.search.finished' }),
      );
    });
}

export function createObservabilityDispatcher(deps: {
  readonly gate: DeployAuthGate;
  readonly controlPlane: ControlPlaneStore;
  readonly requestEvents: RequestEventStore;
  readonly intentEvents: IntentEventStore;
  readonly intentSettings: IntentCaptureSettingsStore;
  readonly previewOrgs: ReadonlySet<string>;
  readonly audit: AuditSink;
  readonly maxBody: number;
  readonly tls: TlsPosture;
  readonly options: ServiceOptions;
}): (req: IncomingMessage, res: ServerResponse, url: URL) => boolean {
  return (req, res, url) => {
    const match = /^\/v1\/orgs\/([^/]+)\/activity\/(claim|ack)$/.exec(url.pathname);
    if (match && req.method === 'POST' && deps.options.activityOutbox) {
      applySecurityHeaders(res, deps.tls);
      if (enforceHttps(req, res, deps.tls)) return true;
      void handleActivityExport(
        req,
        res,
        decodeURIComponent(match[1]!),
        match[2] as 'claim' | 'ack',
        { gate: deps.gate, controlPlane: deps.controlPlane, outbox: deps.options.activityOutbox },
      ).catch(() => {
        if (!res.headersSent) sendJson(res, 500, { error: 'activity storage unavailable' });
      });
      return true;
    }
    return (
      dispatchAnalyticsReads(req, res, url, {
        gate: deps.gate,
        controlPlane: deps.controlPlane,
        requestEventStore: deps.requestEvents,
        applySecurityHeaders,
        enforceHttps,
        sendJson,
        tls: deps.tls,
        developerGrantStore: deps.options.developerGrantStore,
      }) ||
      dispatchIntentCaptureRoutes(req, res, url, {
        gate: deps.gate,
        controlPlane: deps.controlPlane,
        settings: deps.intentSettings,
        intents: deps.intentEvents,
        requests: deps.requestEvents,
        audit: deps.audit,
        maxBody: deps.maxBody,
        previewOrgs: deps.previewOrgs,
        applySecurityHeaders,
        enforceHttps,
        sendJson,
        tls: deps.tls,
        ...(deps.options.clock === undefined ? {} : { clock: deps.options.clock }),
      })
    );
  };
}
