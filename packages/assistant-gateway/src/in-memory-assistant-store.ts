import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { ADMISSION_DEFAULTS } from '@noodle-borg/admission-limits/portable';
import {
  type EnsureAssistantClientInput,
  type EnsureAssistantClientResult,
  InMemoryAssistantClientProvisioning,
} from './assistant-client-ensure.js';
import {
  AssistantInteractionCapacityError,
  type AssistantInteractionClaimResult,
  type AssistantInteractionCompletionResult,
  type AssistantInteractionCreateInput,
  type AssistantInteractionRecord,
  type AssistantInteractionScope,
  type AssistantInteractionTransitionInput,
  type AssistantInteractionTransitionResult,
  type AssistantPendingConfirmationInteractionRecord,
  type AssistantPendingInputInteractionRecord,
  type AssistantPendingInteractionRecord,
  cloneInteraction,
  completedInteraction,
  createPendingInteraction,
  DEFAULT_MAX_PENDING_INTERACTIONS_PER_SESSION,
  executingInteraction,
  expireStrandedExecutingInteraction,
  isPrunableInteraction,
  isTerminalInteraction,
  scrubExecutingInteraction,
  shouldExpireStrandedExecutingInteraction,
  transitionedInteractions,
} from './assistant-interaction-state.js';
import { InMemoryAssistantOperations } from './assistant-operations.js';
import {
  ASSISTANT_HISTORY_MAX_MESSAGES,
  ASSISTANT_SESSION_IDLE_MS,
  type AssistantClientRecord,
  type AssistantHistoryMessage,
  type AssistantInitialSuggestionsClaim,
  type AssistantPendingResume,
  type AssistantSessionElevation,
  type AssistantSessionRecord,
  type AssistantStore,
  type AssistantSuggestedPrompts,
  type AssistantTurnConsumption,
} from './assistant-store.js';
import type { AssistantRecoverableView } from './assistant-view-availability.js';
import type { TenantRef } from './tenant-ref.js';

export class InMemoryAssistantStore implements AssistantStore {
  readonly operations = new InMemoryAssistantOperations();
  readonly #provisioning = new InMemoryAssistantClientProvisioning();
  readonly #clients = new Map<string, AssistantClientRecord>();
  readonly #sessions = new Map<string, AssistantSessionRecord>();
  readonly #interactions = new Map<string, AssistantInteractionRecord>();
  readonly #consoleApprovalNonces = new Map<string, { subject: string; expiresAt: number }>();
  readonly #maxPendingInteractionsPerSession: number;

  constructor(options: { readonly maxPendingInteractionsPerSession?: number } = {}) {
    const limit =
      options.maxPendingInteractionsPerSession ?? DEFAULT_MAX_PENDING_INTERACTIONS_PER_SESSION;
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new RangeError('maxPendingInteractionsPerSession must be a positive integer');
    }
    this.#maxPendingInteractionsPerSession = limit;
  }

  async ensureClient(input: EnsureAssistantClientInput): Promise<EnsureAssistantClientResult> {
    return this.#provisioning.ensure(input, this.#clients);
  }

  async createClient(input: {
    readonly name: string;
    readonly tenant: TenantRef;
    readonly deploymentId: string;
    readonly allowedOrigins: readonly string[];
    readonly now: Date;
  }): Promise<{ readonly client: AssistantClientRecord; readonly secret: string }> {
    const id = `embed_${randomUUID()}`;
    const secret = mintSecret('nsa_');
    const client: AssistantClientRecord = {
      id,
      name: input.name,
      tenant: { ...input.tenant },
      deploymentId: input.deploymentId,
      allowedOrigins: [...input.allowedOrigins],
      secretHash: digest(secret),
      createdAt: input.now.toISOString(),
    };
    this.#clients.set(id, client);
    return { client, secret };
  }

  async listClients(tenant: TenantRef): Promise<readonly AssistantClientRecord[]> {
    return [...this.#clients.values()].filter((client) => sameTenant(client.tenant, tenant));
  }

  async rotateClient(
    id: string,
    now: Date,
  ): Promise<{ readonly client: AssistantClientRecord; readonly secret: string } | undefined> {
    const current = this.#clients.get(id);
    if (!current || current.revokedAt) return undefined;
    const secret = mintSecret('nsa_');
    const client = { ...current, secretHash: digest(secret), createdAt: now.toISOString() };
    this.#clients.set(id, client);
    return { client, secret };
  }

  async revokeClient(id: string, now: Date): Promise<boolean> {
    const current = this.#clients.get(id);
    if (!current || current.revokedAt) return false;
    this.#clients.set(id, { ...current, revokedAt: now.toISOString() });
    return true;
  }

  async authenticateClient(id: string, secret: string): Promise<AssistantClientRecord | undefined> {
    const client = this.#clients.get(id);
    if (!client || client.revokedAt || !safeEqual(client.secretHash, digest(secret)))
      return undefined;
    return client;
  }

  async createSession(
    input: Omit<
      AssistantSessionRecord,
      'id' | 'tokenHash' | 'history' | 'modelToolUses' | 'turnCount'
    >,
  ): Promise<{ readonly session: AssistantSessionRecord; readonly token: string }> {
    const id = `session_${randomUUID()}`;
    const token = mintSecret('nss_');
    const session: AssistantSessionRecord = {
      ...input,
      ...(input.customerRouting
        ? { customerRouting: Object.freeze({ ...input.customerRouting }) }
        : {}),
      id,
      tokenHash: digest(token),
      history: [],
      modelToolUses: [],
      turnCount: 0,
    };
    this.#sessions.set(id, session);
    return { session, token };
  }

  async elevateSession(input: {
    readonly sessionId: string;
    readonly caller: AssistantSessionRecord['caller'];
    readonly clientId: string;
    readonly origin: string;
    readonly customerRouting?: AssistantSessionRecord['customerRouting'];
    readonly boundSurface?: AssistantSessionRecord['boundSurface'];
    readonly pendingResume?: AssistantPendingResume;
    readonly now: Date;
  }): Promise<AssistantSessionElevation> {
    const session = this.#sessions.get(input.sessionId);
    if (!session) return { ok: false, reason: 'unknown_session' };
    if (session.caller.identityKind !== 'anonymous') {
      return { ok: false, reason: 'already_elevated' };
    }
    const token = mintSecret('nss_');
    // History and publicEmbedId ride along untouched: same conversation, same admitting surface for
    // admission. clientId and origin do NOT: a public session's clientId is the embed id and its
    // origin is the anonymous mint's page — but the issuer of every post-elevation delegated exchange
    // derives from clientId (ADR 0152), and CORS on every session route follows origin, which after a
    // login redirect is wherever the elevating client says the conversation continues. Customer
    // routing arrives here too: elevation is the first authenticated moment, so it is the only chance
    // a routed connector's session ever gets its backend-verified routes. The surface binding follows
    // the landing origin: signing in on the app surface lands the conversation on the app surface's
    // projection (ADR 0201 amendment 2026-08-26); absent means unchanged.
    // Suggestions describe the prior anonymous context, so elevation clears them instead of carrying
    // stale public-surface guidance into the authenticated conversation.
    const { latestSuggestions: _staleSuggestions, ...sessionWithoutSuggestions } = session;
    const elevated: AssistantSessionRecord = {
      ...sessionWithoutSuggestions,
      tokenHash: digest(token),
      caller: input.caller,
      clientId: input.clientId,
      origin: input.origin,
      ...(input.customerRouting
        ? { customerRouting: Object.freeze({ ...input.customerRouting }) }
        : {}),
      ...(input.boundSurface ? { boundSurface: input.boundSurface } : {}),
      ...(input.pendingResume ? { pendingResume: { ...input.pendingResume } } : {}),
    };
    this.#sessions.set(session.id, elevated);
    return { ok: true, session: elevated, token };
  }

  async consumePendingResume(sessionId: string): Promise<AssistantPendingResume | undefined> {
    const session = this.#sessions.get(sessionId);
    if (!session?.pendingResume) return undefined;
    const pending = session.pendingResume;
    const { pendingResume: _consumed, ...rest } = session;
    this.#sessions.set(sessionId, rest);
    return pending;
  }

  async consumeTurn(id: string, limit: number): Promise<AssistantTurnConsumption> {
    const session = this.#sessions.get(id);
    // An unknown session is refused rather than created: admission never invents the thing it admits.
    if (!session) return { allowed: false, turnCount: 0 };
    if (session.turnCount >= limit) return { allowed: false, turnCount: session.turnCount };
    const turnCount = session.turnCount + 1;
    this.#sessions.set(id, { ...session, turnCount });
    return { allowed: true, turnCount };
  }

  async claimInitialSuggestions(id: string): Promise<AssistantInitialSuggestionsClaim> {
    const session = this.#sessions.get(id);
    if (!session) return { disposition: 'unavailable' };
    const state = session.initialSuggestions;
    if (state?.status === 'ready') {
      return { disposition: 'ready', prompts: [...state.prompts] };
    }
    if (state !== undefined) return { disposition: 'unavailable' };
    this.#sessions.set(id, { ...session, initialSuggestions: { status: 'generating' } });
    return { disposition: 'generate' };
  }

  async completeInitialSuggestions(id: string, prompts: readonly string[]): Promise<boolean> {
    const session = this.#sessions.get(id);
    if (session?.initialSuggestions?.status !== 'generating') return false;
    this.#sessions.set(id, {
      ...session,
      initialSuggestions: { status: 'ready', prompts: [...prompts] },
    });
    return true;
  }

  async failInitialSuggestions(id: string): Promise<boolean> {
    const session = this.#sessions.get(id);
    if (session?.initialSuggestions?.status !== 'generating') return false;
    this.#sessions.set(id, { ...session, initialSuggestions: { status: 'failed' } });
    return true;
  }

  async replaceLatestSuggestions(
    id: string,
    suggestions: AssistantSuggestedPrompts | undefined,
  ): Promise<boolean> {
    const session = this.#sessions.get(id);
    if (!session) return false;
    if (suggestions === undefined) {
      const { latestSuggestions: _removed, ...remaining } = session;
      this.#sessions.set(id, remaining);
    } else {
      this.#sessions.set(id, {
        ...session,
        latestSuggestions: { phase: suggestions.phase, prompts: [...suggestions.prompts] },
      });
    }
    return true;
  }

  async replaceLatestView(
    id: string,
    view: AssistantRecoverableView | undefined,
  ): Promise<boolean> {
    const session = this.#sessions.get(id);
    if (!session) return false;
    const next = {
      ...session,
      ...(view === undefined ? {} : { latestView: structuredClone(view) }),
    };
    if (view === undefined) delete (next as { latestView?: AssistantRecoverableView }).latestView;
    this.#sessions.set(id, next);
    return true;
  }

  async claimModelToolUse(id: string, tool: string): Promise<boolean> {
    const session = this.#sessions.get(id);
    if (!session || session.modelToolUses.includes(tool)) return false;
    this.#sessions.set(id, { ...session, modelToolUses: [...session.modelToolUses, tool] });
    return true;
  }

  async releaseModelToolUse(id: string, tool: string): Promise<boolean> {
    const session = this.#sessions.get(id);
    if (!session?.modelToolUses.includes(tool)) return false;
    this.#sessions.set(id, {
      ...session,
      modelToolUses: session.modelToolUses.filter((candidate) => candidate !== tool),
    });
    return true;
  }

  async getSession(token: string, now: Date): Promise<AssistantSessionRecord | undefined> {
    this.#pruneInteractions(now);
    const tokenHash = digest(token);
    const session = [...this.#sessions.values()].find((candidate) =>
      safeEqual(candidate.tokenHash, tokenHash),
    );
    if (!session) return undefined;
    if (
      Date.parse(session.expiresAt) <= now.getTime() ||
      Date.parse(session.absoluteExpiresAt) <= now.getTime()
    ) {
      this.#sessions.delete(session.id);
      return undefined;
    }
    const refreshed = {
      ...session,
      expiresAt: new Date(
        Math.min(now.getTime() + ASSISTANT_SESSION_IDLE_MS, Date.parse(session.absoluteExpiresAt)),
      ).toISOString(),
    };
    this.#sessions.set(session.id, refreshed);
    return refreshed;
  }

  async appendHistory(id: string, messages: readonly AssistantHistoryMessage[]): Promise<void> {
    const session = this.#sessions.get(id);
    if (!session) return;
    session.history.push(...messages);
    if (session.history.length > ASSISTANT_HISTORY_MAX_MESSAGES) {
      session.history.splice(0, session.history.length - ASSISTANT_HISTORY_MAX_MESSAGES);
    }
  }

  async createInteraction(
    input: Extract<AssistantInteractionCreateInput, { readonly kind: 'confirmation' }>,
  ): Promise<AssistantPendingConfirmationInteractionRecord>;
  async createInteraction(
    input: Extract<AssistantInteractionCreateInput, { readonly kind: 'input' }>,
  ): Promise<AssistantPendingInputInteractionRecord>;
  async createInteraction(
    input: AssistantInteractionCreateInput,
  ): Promise<
    AssistantPendingConfirmationInteractionRecord | AssistantPendingInputInteractionRecord
  > {
    const proposalTime = new Date(input.createdAt ?? new Date());
    this.#pruneInteractions(proposalTime);
    const pendingForSession = [...this.#interactions.values()].filter(
      (interaction) =>
        interaction.sessionId === input.sessionId && interaction.status === 'pending',
    ).length;
    // Same rule as the durable path: the public envelope's bound for an anonymous visitor, the wider
    // default for a signed-in embed.
    const limit =
      this.#sessions.get(input.sessionId)?.publicEmbedId === undefined
        ? this.#maxPendingInteractionsPerSession
        : ADMISSION_DEFAULTS.pendingInteractions;
    if (pendingForSession >= limit) {
      throw new AssistantInteractionCapacityError();
    }
    const id = `interaction_${randomUUID()}`;
    const interaction =
      input.kind === 'confirmation'
        ? createPendingInteraction(id, input)
        : createPendingInteraction(id, input);
    this.#interactions.set(interaction.id, interaction);
    return cloneInteraction(interaction);
  }

  async claimInteraction(
    input: AssistantInteractionScope,
  ): Promise<AssistantInteractionClaimResult> {
    return this.#claimInteraction(input);
  }

  async completeInteraction(
    input: AssistantInteractionScope & {
      readonly completion: import('./assistant-interaction-state.js').AssistantInteractionCompletion;
    },
  ): Promise<AssistantInteractionCompletionResult> {
    this.#pruneInteractions(input.now);
    const current = this.#scopedInteraction(input);
    if (!current) return { disposition: 'unavailable' };
    if (isTerminalInteraction(current)) {
      return { disposition: 'replay', interaction: cloneInteraction(current) };
    }
    const mayCompleteExecution =
      current.status === 'executing' &&
      (input.completion.status === 'succeeded' || input.completion.status === 'failed');
    const mayResolvePending =
      current.status === 'pending' &&
      (input.completion.status === 'declined' || input.completion.status === 'cancelled');
    if (!mayCompleteExecution && !mayResolvePending) {
      return { disposition: 'conflict', interaction: cloneInteraction(current) };
    }
    const completed = completedInteraction(current, input.completion, input.now);
    this.#interactions.set(completed.id, completed);
    return { disposition: 'completed', interaction: cloneInteraction(completed) };
  }

  async transitionInteraction(
    input: AssistantInteractionTransitionInput,
  ): Promise<AssistantInteractionTransitionResult> {
    this.#pruneInteractions(input.now);
    const current = this.#scopedInteraction(input);
    if (!current) return { disposition: 'unavailable' };
    if (isTerminalInteraction(current)) {
      return { disposition: 'replay', interaction: cloneInteraction(current) };
    }
    if (current.status !== 'executing') {
      return { disposition: 'conflict', interaction: cloneInteraction(current) };
    }
    const pendingForSession = [...this.#interactions.values()].filter(
      (interaction) =>
        interaction.sessionId === current.sessionId && interaction.status === 'pending',
    ).length;
    // Same rule as the durable path: the public envelope's bound for an anonymous visitor, the wider
    // default for a signed-in embed.
    const limit =
      this.#sessions.get(input.sessionId)?.publicEmbedId === undefined
        ? this.#maxPendingInteractionsPerSession
        : ADMISSION_DEFAULTS.pendingInteractions;
    if (pendingForSession >= limit) {
      throw new AssistantInteractionCapacityError();
    }
    // Build and validate both records before mutating the map so the handoff is all-or-nothing.
    const transitioned = transitionedInteractions(current, input, `interaction_${randomUUID()}`);
    this.#interactions.set(transitioned.next.id, transitioned.next);
    this.#interactions.set(transitioned.interaction.id, transitioned.interaction);
    return {
      disposition: 'transitioned',
      interaction: cloneInteraction(transitioned.interaction),
      next: cloneInteraction(transitioned.next),
    };
  }

  async getInteraction(
    input: AssistantInteractionScope,
  ): Promise<AssistantInteractionRecord | undefined> {
    this.#pruneInteractions(input.now);
    const interaction = this.#scopedInteraction(input);
    return interaction ? cloneInteraction(interaction) : undefined;
  }

  async findPendingInteraction(input: {
    readonly sessionId: string;
    readonly deploymentId: string;
    readonly now: Date;
  }): Promise<AssistantPendingInteractionRecord | undefined> {
    this.#pruneInteractions(input.now);
    const interaction = [...this.#interactions.values()]
      .filter(
        (candidate): candidate is AssistantPendingInteractionRecord =>
          candidate.sessionId === input.sessionId &&
          candidate.deploymentId === input.deploymentId &&
          candidate.status === 'pending' &&
          Date.parse(candidate.expiresAt) > input.now.getTime(),
      )
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0];
    return interaction ? cloneInteraction(interaction) : undefined;
  }

  async consumeInteraction(
    id: string,
    sessionId: string,
    deploymentId: string,
    now: Date,
  ): Promise<
    | (import('./assistant-interaction-state.js').AssistantConfirmationInteractionRecord & {
        readonly status: 'executing';
      })
    | undefined
  > {
    const result = this.#claimInteraction({ id, sessionId, deploymentId, now }, 'confirmation');
    return result.disposition === 'claimed' && result.interaction.kind === 'confirmation'
      ? result.interaction
      : undefined;
  }

  async consumeConsoleApprovalNonce(
    nonce: string,
    subject: string,
    expiresAt: Date,
    now: Date,
  ): Promise<boolean> {
    for (const [key, value] of this.#consoleApprovalNonces) {
      if (value.expiresAt <= now.getTime()) this.#consoleApprovalNonces.delete(key);
    }
    if (expiresAt.getTime() <= now.getTime() || this.#consoleApprovalNonces.has(nonce))
      return false;
    this.#consoleApprovalNonces.set(nonce, { subject, expiresAt: expiresAt.getTime() });
    return true;
  }

  #claimInteraction(
    input: AssistantInteractionScope,
    expectedKind?: AssistantInteractionRecord['kind'],
  ): AssistantInteractionClaimResult {
    this.#pruneInteractions(input.now);
    const current = this.#scopedInteraction(input);
    if (!current || (expectedKind !== undefined && current.kind !== expectedKind)) {
      return { disposition: 'unavailable' };
    }
    if (current.status !== 'pending') {
      return { disposition: 'replay', interaction: cloneInteraction(current) };
    }
    const claimed = executingInteraction(current, input.now);
    this.#interactions.set(claimed.id, scrubExecutingInteraction(claimed));
    return { disposition: 'claimed', interaction: cloneInteraction(claimed) };
  }

  #scopedInteraction(input: AssistantInteractionScope): AssistantInteractionRecord | undefined {
    const interaction = this.#interactions.get(input.id);
    return interaction?.sessionId === input.sessionId &&
      interaction.deploymentId === input.deploymentId
      ? interaction
      : undefined;
  }

  #pruneInteractions(now: Date): void {
    for (const [id, interaction] of this.#interactions) {
      if (shouldExpireStrandedExecutingInteraction(interaction, now)) {
        this.#interactions.set(id, expireStrandedExecutingInteraction(interaction, now));
      } else if (isPrunableInteraction(interaction, now)) {
        this.#interactions.delete(id);
      }
    }
  }
}

function mintSecret(prefix: string): string {
  return `${prefix}${randomBytes(32).toString('base64url')}`;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

function sameTenant(a: TenantRef, b: TenantRef): boolean {
  return a.org === b.org && a.app === b.app && a.env === b.env;
}
