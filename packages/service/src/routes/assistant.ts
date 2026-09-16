import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  type AdmissionEnvelope,
  clientAddressBucket,
  type DailyCounterStore,
} from '@noodle-borg/admission-limits/portable';
import {
  assistantModelFailure,
  assistantModelSource,
  assistantModelTransport,
  type ManagedAssistantModelResolver,
} from '@noodle-borg/assistant-gateway/model-runtime';
import type {
  AssistantAppearanceSettingsStore,
  AssistantElevationCoordinator,
  AssistantElevationStore,
  PublicEmbedStore,
} from '@noodle-borg/assistant-gateway/portable';
import {
  type AssistantStore,
  executeAssistantAppToolCall,
  parseAssistantContextPreferences,
  prepareAssistantSessionIdentity,
  prepareAssistantSessionRecord,
  refuseBridgeToolCall,
  refusePublicTurn,
  resolveInvocationContextSnapshot,
  resumeTurnMessage,
  resumeUnavailableMessage,
  shouldAutoResume,
  withAssistantSessionExecutionAuthority,
} from '@noodle-borg/assistant-gateway/portable';
import { canonicalizeAuthorizationClaimValues } from '@noodle-borg/auth';
import type { DeployAuthGate } from '@noodle-borg/control-plane/portable';
import { type AdmissionGate, type RequestEventInput, tenantMcpUrl } from '@noodle-borg/module';
import {
  assistantAppToolCallRecorder,
  assistantRefusedTurnUsageRequestEvent,
  assistantSessionUsageRequestEvent,
  assistantTurnNumber,
  assistantTurnUsageRequestEvent,
  captureAssistantUsage,
} from '@noodle-borg/observability';
import {
  mapExecutionError,
  mapResourceContents,
  mapResourcesList,
  mapToolOutput,
  mapToolsList,
} from '@noodle-borg/protocol';
import { type ExecuteDeps, executeResource } from '@noodle-borg/runtime';
import type { Logger } from '@noodle-borg/transport-http';
import { readJsonBody, sendJson } from '@noodle-borg/transport-http';
import {
  type AssistantMessageTurnRequest,
  assistantMessageTurnRequestSchema,
  assistantResumeTurnRequestSchema,
  assistantSessionResponseSchema,
  parsePrivateAssistantSessionInput,
} from '@noodle-borg/wire-contracts';
import type { RuntimeTargetResolver } from '../application-runtime-target.js';
import { admitAssistantRequest, assistantAppAdmissionOperation } from '../assistant-admission.js';
import { sendUnauthorized } from '../http-util.js';
import type { ServerRegistry } from '../registry.js';
import type { AuditSink } from '../store/audit.js';
import type { ControlPlaneStore } from '../store.js';
import { type AssistantEvent, createAssistantTurnStats, runAgentTurn } from './assistant-agent.js';
import { elevateAssistantSession } from './assistant-elevation.js';
import {
  executeAssistantKnowledgeSearch,
  findAssistantKnowledgeComponent,
  resolveAssistantKnowledge,
} from './assistant-knowledge.js';
import { claimAssistantExecution } from './assistant-operations.js';
import {
  applyBrowserCors,
  assistantSessionEndpoints,
  authenticateSession,
  handleAssistantPreflight,
  now,
} from './assistant-route-http.js';
import {
  activeAssistantTarget,
  assistantSessionTargetReceipt,
  sessionScopedTarget,
} from './assistant-session-target.js';
import { authorizeControlPlane } from './control-plane.js';

export { applyBrowserCors, authenticateSession, handleAssistantPreflight, now };

export interface AssistantRouteDeps {
  readonly registry: ServerRegistry;
  /** Optional external policy, separate from built-in MCP and public embed capacity counters. */
  readonly admissionGate?: AdmissionGate;
  readonly requireAssistantExecutionAdmission?: boolean;
  readonly resolveRuntimeTarget?: RuntimeTargetResolver;
  readonly store: AssistantStore;
  /**
   * Public-surface ports. Both absent means this deployment serves authenticated embeds only, and the
   * public mint route refuses outright rather than half-working.
   */
  readonly publicEmbeds?: PublicEmbedStore;
  readonly appearance?: AssistantAppearanceSettingsStore;
  readonly admissionCounters?: DailyCounterStore;
  /** Read per request, never snapshotted onto a session, so lowering a budget takes effect immediately. */
  readonly admissionEnvelope?: AdmissionEnvelope;
  /** Mid-conversation sign-in (5.6b). Absent means a mixed surface simply never offers elevation. */
  readonly elevations?: AssistantElevationStore;
  readonly elevationCoordinator?: AssistantElevationCoordinator;
  readonly gate: DeployAuthGate;
  readonly controlPlane: ControlPlaneStore;
  readonly audit: AuditSink;
  readonly maxBody: number;
  readonly serviceBase: (req: IncomingMessage) => string;
  readonly modelFetch?: typeof fetch;
  readonly managedModelResolver?: ManagedAssistantModelResolver;
  /** Enqueue-only tenant telemetry; absence keeps capture disabled. */
  readonly captureRequestEvent?: (event: RequestEventInput) => void;
  readonly clock?: () => Date;
  readonly logger?: Logger;
}

export async function handleConsoleApprovalNonce(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AssistantRouteDeps,
): Promise<void> {
  const identity = await authorizeControlPlane(req, res, deps.gate, { requireIdentity: true });
  if (!identity) return;
  const body = await readJsonBody(req, deps.maxBody);
  if (!body.ok) return sendJson(res, body.status, { error: body.error });
  const { nonce, expiresAt } = body.value as { nonce?: unknown; expiresAt?: unknown };
  if (typeof nonce !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(nonce)) {
    return sendJson(res, 400, { error: 'invalid nonce' });
  }
  if (typeof expiresAt !== 'string') return sendJson(res, 400, { error: 'invalid expiry' });
  const current = now(deps);
  const expiry = new Date(expiresAt);
  if (
    !Number.isFinite(expiry.getTime()) ||
    expiry.getTime() <= current.getTime() ||
    expiry.getTime() > current.getTime() + 10 * 60 * 1000
  ) {
    return sendJson(res, 400, { error: 'invalid expiry' });
  }
  const consumed = await deps.store.consumeConsoleApprovalNonce(
    nonce,
    identity.subject,
    expiry,
    current,
  );
  return sendJson(
    res,
    consumed ? 201 : 409,
    consumed ? { ok: true } : { ok: false, error: 'already_used_or_expired' },
  );
}

export async function handleAssistantSession(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AssistantRouteDeps,
): Promise<void> {
  const usageStartedAt = performance.now();
  const credentials = basicCredentials(req);
  if (!credentials) return sendUnauthorized(res, 'invalid assistant client');
  const client = await deps.store.authenticateClient(credentials.id, credentials.secret);
  if (!client) return sendUnauthorized(res, 'invalid assistant client');
  const body = await readJsonBody(req, deps.maxBody);
  if (!body.ok) return sendJson(res, body.status, { error: body.error });
  const envelope = parsePrivateAssistantSessionInput(body.value);
  if (!envelope.ok)
    return sendJson(res, envelope.error === 'origin is not allowed' ? 403 : 400, {
      error: envelope.error,
    });
  const parsed = envelope.value;
  const { serverVersion } = parsed;
  const target = await activeAssistantTarget(deps, client.tenant, serverVersion);
  const assistant = target?.served.artifact.server.assistant;
  if (!target?.deploymentId || !assistant)
    return sendJson(res, 409, { error: 'assistant deployment is unavailable' });
  const identity = prepareAssistantSessionIdentity(target.served.artifact, parsed, {
    audience: tenantMcpUrl(deps.serviceBase(req), client.tenant),
    roles: canonicalizeAuthorizationClaimValues(parsed.user.roles, 'role'),
    scopes: canonicalizeAuthorizationClaimValues(parsed.user.scopes, 'scope'),
  });
  if (!identity.ok)
    return sendJson(res, identity.error === 'origin is not allowed' ? 403 : 400, {
      error: identity.error,
      ...('endpoint' in identity ? { endpoint: identity.endpoint } : {}),
    });
  const { caller } = identity;
  const prepared = await prepareAssistantSessionRecord({
    client,
    deploymentId: target.deploymentId,
    artifact: target.served.artifact,
    identity,
    appearance: deps.appearance,
    businessNotice: target.businessNotice,
    now: now(deps),
  });
  const configuration = prepared.record.configuration;
  if (
    !(await admitAssistantRequest(req, res, deps.admissionGate, {
      tenant: client.tenant,
      deploymentId: target.deploymentId,
      caller,
    }))
  )
    return;

  // Mid-conversation sign-in (5.6b). Its decision, refusals, audit, and response live in
  // `assistant-elevation.ts`, which owns elevation; this is only the branch.
  if (parsed.signInTicket !== undefined) {
    if (parsed.resume !== undefined && typeof parsed.resume !== 'boolean') {
      return sendJson(res, 400, { error: '"resume" must be a boolean' });
    }
    return elevateAssistantSession(res, deps, {
      signInTicket: parsed.signInTicket,
      client,
      resume: shouldAutoResume(parsed.resume),
      ...prepared.authentication,
      configuration,
      endpoints: assistantSessionEndpoints(deps.serviceBase(req)),
    });
  }

  const receipt = await assistantSessionTargetReceipt(
    deps.registry,
    client.tenant,
    target.deploymentId,
    target.served.artifact.server.version,
  );
  if (!receipt || (serverVersion !== undefined && receipt.serverVersion !== serverVersion))
    return sendJson(res, 409, { error: 'assistant deployment is unavailable' });
  const session = await deps.store.createSession(prepared.record);
  const sessionBody = {
    ...(deps.requireAssistantExecutionAdmission ? { executionAdmission: 'required' as const } : {}),
    token: session.token,
    sessionId: session.session.id,
    target: receipt,
    expiresAt: session.session.expiresAt,
    endpoints: assistantSessionEndpoints(deps.serviceBase(req)),
    ...(configuration ? { configuration } : {}),
  };
  // Every published @noodleseed/assistant widget consumes this shape; parse (don't just test)
  // so a contract break fails loudly at mint time instead of stranding deployed widgets (ADR 0151).
  assistantSessionResponseSchema.parse(sessionBody);
  captureAssistantUsage(
    deps.captureRequestEvent,
    assistantSessionUsageRequestEvent(session.session, performance.now() - usageStartedAt),
  );
  return sendJson(res, 201, sessionBody);
}

/**
 * Both turn entries — a resume and a typed message — refuse identically: the refusal is spent
 * budget, so it is recorded against the surface before the caller is told no. Kept in one place so
 * the two entries cannot drift into recording it differently.
 */
function refuseTurn(
  deps: AssistantRouteDeps,
  res: ServerResponse,
  session: Parameters<typeof assistantRefusedTurnUsageRequestEvent>[0],
  refusal: { readonly status: number; readonly code: string; readonly message: string },
  usageStartedAt: number,
): void {
  const durationMs = performance.now() - usageStartedAt;
  captureAssistantUsage(
    deps.captureRequestEvent,
    assistantRefusedTurnUsageRequestEvent(session, refusal.code, durationMs),
  );
  sendJson(res, refusal.status, { error: refusal.message, code: refusal.code });
}

export async function handleAssistantTurn(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AssistantRouteDeps,
): Promise<void> {
  const usageStartedAt = performance.now();
  const session = await authenticateSession(
    req,
    res,
    deps,
    deps.requireAssistantExecutionAdmission ? 'defer-to-app-operation' : 'session',
  );
  if (!session) return;
  const usageTurnNumber = assistantTurnNumber(session);
  applyBrowserCors(req, res, session.origin);
  const body = await readJsonBody(req, deps.maxBody);
  if (!body.ok) return sendJson(res, body.status, { error: body.error });
  // Admission tier 3, hashed here for the same reason the mint hashes it: no raw address may reach the
  // decision, a counter key, or an audit payload.
  const target = await sessionScopedTarget(deps.registry, session, deps.resolveRuntimeTarget, req);
  if (!target) return sendJson(res, 409, { error: 'assistant deployment is unavailable' });
  if (
    deps.requireAssistantExecutionAdmission &&
    (!isRecord(body.value) || typeof body.value.operationId !== 'string' || 'resume' in body.value)
  )
    return sendJson(res, 403, { error: 'assistant execution operation required' });
  const addressBucket = clientAddressBucket(req.socket.remoteAddress);
  let turn: AssistantMessageTurnRequest | undefined;
  let message: string;
  let resumedTool: string | undefined;
  let suggestionsRequested = false;
  if (isRecord(body.value) && 'resume' in body.value) {
    // The one-shot post-sign-in resume (issue #1177): no user text, the pending intent is server
    // state. Admission runs FIRST so a refused resume stays armed for a retry; the consume is a
    // single statement, so two requests racing the arm cannot both run it.
    const resumeResult = assistantResumeTurnRequestSchema.safeParse(body.value);
    if (!resumeResult.success) {
      return sendJson(res, 400, { error: 'invalid turn request' });
    }
    suggestionsRequested = resumeResult.data.suggestions === true;
    const refusal = await refusePublicTurn(deps, session, 'resume', addressBucket);
    if (refusal) return refuseTurn(deps, res, session, refusal, usageStartedAt);
    const pending = await deps.store.consumePendingResume(session.id);
    if (!pending) {
      return sendJson(res, 409, {
        error: 'nothing to resume on this session',
        code: 'nothing_to_resume',
      });
    }
    message = resumeTurnMessage(pending.tool);
    resumedTool = pending.tool;
    await deps.audit.emit({
      eventType: 'assistant.session.resumed',
      org: session.tenant.org,
      app: session.tenant.app,
      env: session.tenant.env,
      deploymentId: session.deploymentId,
      decision: 'allow',
      actorSubject: session.caller.subject,
      details: { tool: pending.tool, sessionId: session.id },
    });
  } else {
    const turnResult = assistantMessageTurnRequestSchema.safeParse(body.value);
    if (!turnResult.success) {
      const issueRoot = turnResult.error.issues[0]?.path[0];
      if (issueRoot === 'modelContext') {
        return sendJson(res, 400, { error: 'invalid model context' });
      }
      if (issueRoot === 'clientContext') {
        return sendJson(res, 400, { error: 'invalid client context' });
      }
      if (issueRoot === 'pageContext') {
        return sendJson(res, 400, { error: 'invalid page context' });
      }
      if (issueRoot === 'message') {
        return sendJson(res, 400, { error: '"message" must be a non-empty string' });
      }
      return sendJson(res, 400, { error: 'invalid turn request' });
    }
    turn = turnResult.data;
    suggestionsRequested = turn.suggestions === true;
    message = turn.message;
    if (message.trim().length === 0) {
      return sendJson(res, 400, { error: '"message" must be a non-empty string' });
    }
    // Resolve live authority first: a paused application or removed origin spends no turn allowance.
    // Admission still precedes every model request and business operation.
    const refusal = await refusePublicTurn(deps, session, message, addressBucket);
    if (refusal) return refuseTurn(deps, res, session, refusal, usageStartedAt);
    // The visitor typed first: any pending post-sign-in resume is moot, and must not fire later.
    if (session.pendingResume) await deps.store.consumePendingResume(session.id);
  }
  if (
    resumedTool !== undefined &&
    !target.served.artifact.tools.some((tool) => tool.name === resumedTool)
  ) {
    // The elevation landed on a surface whose projection does not offer the intercepted tool: fail
    // closed to an honest explanation instead of asking the model to call a tool it cannot see.
    message = resumeUnavailableMessage(resumedTool);
  }
  const clientContext =
    turn?.clientContext === undefined
      ? undefined
      : parseAssistantContextPreferences(turn.clientContext);
  if (clientContext?.ok === false) {
    return sendJson(res, 400, { error: 'invalid client context' });
  }
  const execution = turn?.operationId
    ? await claimAssistantExecution(req, res, deps, session, target, turn)
    : undefined;
  if (turn?.operationId && !execution) return;
  let operationCompleted = false;
  try {
    const invocationContext = await resolveInvocationContextSnapshot({
      artifact: target.served.artifact,
      executeDeps: withAssistantSessionExecutionAuthority(
        target.served.deps as ExecuteDeps,
        target.served.artifact,
        session,
      ),
      caller: session.caller,
      instant: now(deps),
      ...(session.preferences ? { applicationPreference: session.preferences } : {}),
      ...(clientContext?.ok ? { clientHint: clientContext.value } : {}),
    });
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'access-control-allow-origin': session.origin,
      vary: 'Origin',
    });
    res.flushHeaders?.();
    const events: AssistantEvent[] = [];
    const stats = createAssistantTurnStats();
    const emit = (event: AssistantEvent): void => {
      if (execution)
        event = { ...event, data: { ...event.data, operationId: execution.operationId } };
      events.push(event);
      res.write(`event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`);
    };
    let turnCompleted = false;
    try {
      if (suggestionsRequested) {
        try {
          await deps.store.replaceLatestSuggestions(session.id, undefined);
        } catch {
          // Suggestions are optional; the assistant turn remains authoritative.
        }
      }
      await runAgentTurn(
        target,
        session,
        message.trim(),
        invocationContext,
        deps,
        emit,
        turn?.modelContext,
        turn?.pageContext,
        stats,
        suggestionsRequested,
        execution?.binding,
      );
      turnCompleted = true;
    } catch (error) {
      const failure = assistantModelFailure(error);
      emit({ event: 'error', data: { ...failure, ...(execution ? { retryable: false } : {}) } });
      deps.logger?.warn('assistant.model.failed', {
        org: session.tenant.org,
        app: session.tenant.app,
        env: session.tenant.env,
        deploymentId: session.deploymentId,
        code: failure.code,
        ...(failure.status === undefined ? {} : { upstreamStatus: failure.status }),
        retryable: failure.retryable,
        modelSource:
          session.modelSource ??
          assistantModelSource(target?.served.artifact.server.assistant?.model),
        transport: assistantModelTransport(target?.served.artifact.server.assistant?.model),
      });
    }
    if (turnCompleted) {
      const assistantContent = events
        .filter((event) => event.event === 'content')
        .map((event) => String(event.data.delta ?? ''))
        .join('');
      try {
        await deps.store.appendHistory(session.id, [
          { role: 'user', content: message.trim(), kind: turn ? 'visible' : 'narration' },
          ...(assistantContent
            ? [{ role: 'assistant' as const, content: assistantContent, kind: 'visible' as const }]
            : []),
        ]);
      } catch {
        emit({ event: 'error', data: { code: 'conversation_state_failed', retryable: false } });
        deps.logger?.warn('assistant.history.failed', {
          org: session.tenant.org,
          app: session.tenant.app,
          env: session.tenant.env,
          deploymentId: session.deploymentId,
        });
      }
    }
    operationCompleted = turnCompleted && !events.some((event) => event.event === 'error');
    if (execution)
      await deps.store.operations.finish(
        execution.operationId,
        execution.scope,
        operationCompleted ? 'completed' : 'unknown',
      );
    res.end(
      `event: done\ndata: ${JSON.stringify(execution ? { operationId: execution.operationId } : {})}\n\n`,
    );
    const error = events.find((event) => event.event === 'error');
    captureAssistantUsage(
      deps.captureRequestEvent,
      assistantTurnUsageRequestEvent(session, {
        outcome: error === undefined ? 'delivered' : 'failed',
        counters: stats,
        turnNumber: usageTurnNumber,
        durationMs: performance.now() - usageStartedAt,
        ...(typeof error?.data.code === 'string' ? { errorKind: error.data.code } : {}),
      }),
    );
  } finally {
    if (execution && !operationCompleted)
      await deps.store.operations.finish(execution.operationId, execution.scope, 'unknown');
  }
}

/** Standard MCP operations exposed to an initialized app inside the embedded assistant host. */
export async function handleAssistantAppRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AssistantRouteDeps,
): Promise<void> {
  const session = await authenticateSession(req, res, deps, 'defer-to-app-operation');
  if (!session) return;
  applyBrowserCors(req, res, session.origin);
  const body = await readJsonBody(req, deps.maxBody);
  if (!body.ok) return sendJson(res, body.status, { error: body.error });
  if (
    !isRecord(body.value) ||
    typeof body.value.method !== 'string' ||
    !isRecord(body.value.params)
  ) {
    return sendJson(res, 400, { error: 'invalid MCP App request' });
  }
  const operation = assistantAppAdmissionOperation(body.value.method, body.value.params);
  if (
    !(await admitAssistantRequest(
      req,
      res,
      deps.admissionGate,
      { ...session, registry: deps.registry },
      operation,
    ))
  )
    return;
  const target = await sessionScopedTarget(deps.registry, session, deps.resolveRuntimeTarget, req);
  if (!target) return sendJson(res, 409, { error: 'assistant deployment is unavailable' });
  const method = body.value.method;
  const params = body.value.params;
  // Answered before any resolution work, so a refused browser agent costs nothing (ADR 0220). The
  // marker is client-declared: it selects a budget, never authority, which the session below decides.
  const bridged = method === 'tools/call' && body.value.bridge === 'webmcp';
  // Bound before the budget gate below, because that refusal is the one an operator watching a
  // browser agent most needs to see, and answering it before any resolution work must not mean
  // answering it silently. `bridged` is attribution only: it labels the row, never authority.
  const record = assistantAppToolCallRecorder({
    capture: deps.captureRequestEvent,
    session,
    ...(typeof params.name === 'string' ? { toolName: params.name } : { toolName: undefined }),
    bridged,
    clock: () => performance.now(),
  });
  const refusal = bridged ? await refuseBridgeToolCall(deps, session) : undefined;
  if (refusal) {
    record('refused', refusal.code);
    return sendJson(res, refusal.status, { error: refusal.message, code: refusal.code });
  }
  const knowledge = await resolveAssistantKnowledge(target.served);
  if (method === 'tools/list') {
    return sendJson(
      res,
      200,
      mapToolsList(target.served.artifact, session.caller, {
        knowledgeTools: knowledge !== undefined,
      }),
    );
  }
  if (method === 'resources/list') {
    return sendJson(res, 200, mapResourcesList(target.served.artifact));
  }
  if (method === 'resources/read') {
    if (typeof params.uri !== 'string')
      return sendJson(res, 400, { error: 'resource uri required' });
    const resource = target.served.artifact.resources?.find(
      (candidate) => candidate.uri === params.uri,
    );
    if (!resource) return sendJson(res, 404, { error: 'resource not found' });
    // One projection for both the snapshot and the execution: they must agree, and building it
    // twice was two chances for them not to.
    const executeDeps = withAssistantSessionExecutionAuthority(
      target.served.deps as ExecuteDeps,
      target.served.artifact,
      session,
    );
    const context = await resolveInvocationContextSnapshot({
      artifact: target.served.artifact,
      executeDeps,
      caller: session.caller,
      instant: now(deps),
      ...(session.preferences ? { applicationPreference: session.preferences } : {}),
    });
    const execution = await executeResource(
      target.served.artifact,
      resource.name,
      {},
      {
        ...executeDeps,
        caller: session.caller,
        context,
      },
    );
    if (!execution.ok) return sendJson(res, 400, mapExecutionError(execution.error));
    return sendJson(
      res,
      200,
      mapResourceContents(resource.uri, resource.mimeType, execution.output, resource._meta),
    );
  }
  if (method === 'tools/call') {
    if (typeof params.name !== 'string') {
      record('refused', 'tool_name_required');
      return sendJson(res, 400, { error: 'tool name required' });
    }
    const toolName = params.name;
    const knowledgeComponent = findAssistantKnowledgeComponent(knowledge, toolName);
    if (knowledge !== undefined && knowledgeComponent !== undefined) {
      const content = await executeAssistantKnowledgeSearch(
        knowledge,
        knowledgeComponent,
        params.arguments ?? {},
      );
      // A knowledge search reports failure in its payload rather than by throwing, so reading the
      // envelope is the only way not to file a refused or failed search as a successful one.
      const payload: unknown = JSON.parse(content);
      const failure =
        isRecord(payload) && typeof payload.error === 'string' ? payload.error : undefined;
      if (failure === undefined) record('ok');
      else record(failure === 'invalid_arguments' ? 'refused' : 'failed', failure);
      return sendJson(res, 200, mapToolOutput(payload));
    }
    const call = await executeAssistantAppToolCall({
      artifact: target.served.artifact,
      deps: target.served.deps as ExecuteDeps,
      session,
      toolName,
      arguments: params.arguments,
      now: () => now(deps),
      store: deps.store,
      audit: deps.audit,
    });
    if (call.kind === 'not-found') {
      record('refused', 'app_tool_not_found');
      return sendJson(res, 404, { error: 'app tool not found' });
    }
    if (call.kind === 'forbidden') {
      record('refused', 'tool_forbidden');
      return sendJson(res, 403, { error: 'tool forbidden' });
    }
    if (call.kind === 'invalid-arguments') {
      record('refused', 'invalid_tool_arguments');
      return sendJson(res, 200, {
        content: [{ type: 'text', text: 'invalid tool arguments' }],
        isError: true,
      });
    }
    if (call.kind === 'interaction') {
      // A raised confirmation is not a failure and not yet an execution: the bridge did what it
      // should, and the interaction is answered on its own route.
      record('ok');
      return sendJson(res, 200, { interaction: { event: call.event, data: call.data } });
    }
    if (call.kind === 'error') {
      record('failed', call.code);
      return sendJson(res, 200, {
        content: [{ type: 'text', text: call.code }],
        isError: true,
      });
    }
    record('ok');
    return sendJson(res, 200, mapToolOutput(call.output));
  }
  return sendJson(res, 400, { error: 'unsupported MCP App method' });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function basicCredentials(req: IncomingMessage): { id: string; secret: string } | undefined {
  const match = /^Basic\s+(.+)$/i.exec(req.headers.authorization ?? '');
  if (!match?.[1]) return undefined;
  try {
    const decoded = Buffer.from(match[1], 'base64').toString('utf8');
    const index = decoded.indexOf(':');
    return index > 0
      ? { id: decoded.slice(0, index), secret: decoded.slice(index + 1) }
      : undefined;
  } catch {
    return undefined;
  }
}
