import type { ArtifactServer } from '@noodle-borg/compiler';
import type { CallerIdentity } from '@noodle-borg/runtime';
import type { ASSISTANT_BROWSER_UI_FIELDS } from './assistant-browser-fields.js';
import type {
  EnsureAssistantClientInput,
  EnsureAssistantClientResult,
} from './assistant-client-ensure.js';
import type { AssistantContextPreferences } from './assistant-context.js';
import type { AssistantCustomerRouting } from './assistant-customer-routing.js';
import type {
  AssistantInteractionClaimResult,
  AssistantInteractionCompletionResult,
  AssistantInteractionCreateInput,
  AssistantInteractionRecord,
  AssistantInteractionScope,
  AssistantInteractionTransitionInput,
  AssistantInteractionTransitionResult,
  AssistantPendingConfirmationInteractionRecord,
  AssistantPendingInputInteractionRecord,
  AssistantPendingInteractionRecord,
} from './assistant-interaction-state.js';
import type { AssistantOperationStore } from './assistant-operations.js';
import type { AssistantRecoverableView } from './assistant-view-availability.js';
import type { TenantRef } from './tenant-ref.js';

export {
  ASSISTANT_INTERACTION_EXECUTION_LIMIT_MS,
  ASSISTANT_INTERACTION_OUTCOME_RETENTION_MS,
  type AssistantConfirmationInteractionRecord,
  AssistantInteractionCapacityError,
  type AssistantInteractionClaimResult,
  type AssistantInteractionCompletion,
  type AssistantInteractionCompletionResult,
  type AssistantInteractionCreateInput,
  type AssistantInteractionKind,
  type AssistantInteractionPublicArray,
  type AssistantInteractionPublicObject,
  type AssistantInteractionPublicOutcome,
  type AssistantInteractionPublicValue,
  type AssistantInteractionRecord,
  type AssistantInteractionScope,
  type AssistantInteractionStatus,
  type AssistantInteractionTransitionInput,
  type AssistantInteractionTransitionNext,
  type AssistantInteractionTransitionResult,
  type AssistantPendingConfirmationInteractionRecord,
  type AssistantPendingInputInteractionRecord,
  type AssistantPendingInteractionRecord,
  DEFAULT_MAX_PENDING_INTERACTIONS_PER_SESSION,
} from './assistant-interaction-state.js';

export const ASSISTANT_SESSION_IDLE_MS = 30 * 60 * 1000;
export { ASSISTANT_BROWSER_UI_FIELDS } from './assistant-browser-fields.js';

export interface AssistantClientRecord {
  readonly id: string;
  readonly name: string;
  readonly tenant: TenantRef;
  readonly deploymentId: string;
  readonly allowedOrigins: readonly string[];
  readonly secretHash: string;
  readonly createdAt: string;
  readonly revokedAt?: string;
}

export interface AssistantSessionRecord {
  readonly id: string;
  readonly tokenHash: string;
  readonly clientId: string;
  readonly tenant: TenantRef;
  readonly deploymentId: string;
  /** Model funding boundary pinned with the deployment that minted this session. */
  readonly modelSource?: 'operator' | 'noodle-managed';
  readonly origin: string;
  readonly caller: CallerIdentity;
  /** Canonical customer endpoint routes; private session authority, never caller or response data. */
  readonly customerRouting?: AssistantCustomerRouting;
  readonly context?: Readonly<Record<string, string | number | boolean | null>>;
  readonly preferences?: AssistantContextPreferences;
  readonly configuration?: {
    readonly branding?: ArtifactServer['branding'];
    readonly assistant?: Pick<
      NonNullable<ArtifactServer['assistant']>,
      (typeof ASSISTANT_BROWSER_UI_FIELDS)[number]
    >;
  };
  /**
   * The public surface this session was minted from, when it was minted anonymously from a page rather
   * than exchanged through a customer backend. It is the key admission spends against, so it stays on
   * the record for the session's whole life — including after a mixed surface elevates the caller, whose
   * turns still belong to the surface that admitted them.
   */
  readonly publicEmbedId?: string;
  /**
   * The exact authored surface this session is bound to: 'public' is the deployment's one
   * public-audience surface (public or mixed mode), 'authenticated' its authenticated surface. Written
   * at mint from the origin that admitted the session; absent only on records minted before binding
   * existed and on pre-surfaces artifacts, where the projection derives the surface from the pinned
   * deployment and the session's origin instead. Never a deployment-wide union.
   */
  readonly boundSurface?: 'public' | 'authenticated';
  /**
   * The intercepted tool a successful elevation may re-attempt as the session's first elevated
   * turn. Armed only in the same statement that elevates; consumed (or mooted by the visitor's
   * first typed turn) exactly once via {@link AssistantStore.consumePendingResume}.
   */
  readonly pendingResume?: AssistantPendingResume;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly absoluteExpiresAt: string;
  readonly history: AssistantHistoryMessage[];
  /** Successful model-selected tools carrying the typed once-per-session visibility contract. */
  readonly modelToolUses: readonly string[];
  /**
   * Model turns already spent. Durable and separate from `history`, which keeps a bounded recent
   * prompt window and is never the admission bound.
   */
  readonly turnCount: number;
  /** At-most-once initial model generation state; absent is the unclaimed state. */
  readonly initialSuggestions?: AssistantInitialSuggestionsState;
  /** Latest validated follow-up suggestions, replayed with the visible transcript. */
  readonly latestSuggestions?: AssistantSuggestedPrompts;
  /** Latest renderer descriptor; HTML is re-resolved from the current surface artifact on recovery. */
  readonly latestView?: AssistantRecoverableView;
}

export interface AssistantSuggestedPrompts {
  readonly phase: 'initial' | 'follow_up';
  readonly prompts: readonly string[];
}

export type AssistantInitialSuggestionsState =
  | { readonly status: 'generating' }
  | { readonly status: 'ready'; readonly prompts: readonly string[] }
  | { readonly status: 'failed' };

export type AssistantInitialSuggestionsClaim =
  | { readonly disposition: 'generate' }
  | { readonly disposition: 'ready'; readonly prompts: readonly string[] }
  | { readonly disposition: 'unavailable' };

/** The intercepted call a spent sign-in ticket left pending, resumable at most once. */
export interface AssistantPendingResume {
  readonly tool: string;
  readonly requestedAt: string;
}

/** One consumed turn slot, or the refusal that the session has spent its allowance. */
export interface AssistantTurnConsumption {
  readonly allowed: boolean;
  readonly turnCount: number;
}

export interface AssistantHistoryMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string;
  /**
   * Whether this row ever appeared in the visible panel (`visible`) or is model-facing scaffolding —
   * resolution summaries carrying tool output, `[platform]` resume prompts (`narration`). Only rows
   * explicitly tagged `visible` may be replayed to a browser (ADR 0141/0201 amendments 2026-08-26);
   * an untagged legacy row is treated as narration, fail closed.
   */
  readonly kind?: 'visible' | 'narration';
}

/** Latest prompt messages retained for model continuity; turn admission is tracked separately. */
export const ASSISTANT_HISTORY_MAX_MESSAGES = 40;

export type AssistantSessionElevation =
  | {
      readonly ok: true;
      readonly session: AssistantSessionRecord;
      /** The replacement token. The value it replaces is dead the moment this returns. */
      readonly token: string;
    }
  | { readonly ok: false; readonly reason: 'unknown_session' | 'already_elevated' };

export interface AssistantStore {
  readonly operations: AssistantOperationStore;
  ensureClient(input: EnsureAssistantClientInput): Promise<EnsureAssistantClientResult>;
  createClient(input: {
    readonly name: string;
    readonly tenant: TenantRef;
    readonly deploymentId: string;
    readonly allowedOrigins: readonly string[];
    readonly now: Date;
  }): Promise<{ readonly client: AssistantClientRecord; readonly secret: string }>;
  listClients(tenant: TenantRef): Promise<readonly AssistantClientRecord[]>;
  rotateClient(
    id: string,
    now: Date,
  ): Promise<{ readonly client: AssistantClientRecord; readonly secret: string } | undefined>;
  revokeClient(id: string, now: Date): Promise<boolean>;
  authenticateClient(id: string, secret: string): Promise<AssistantClientRecord | undefined>;
  createSession(
    input: Omit<
      AssistantSessionRecord,
      'id' | 'tokenHash' | 'history' | 'modelToolUses' | 'turnCount'
    >,
  ): Promise<{ readonly session: AssistantSessionRecord; readonly token: string }>;
  /**
   * Spend one turn if the session has one left, atomically. This is one seam rather than a
   * read-then-write in the route because two turns arriving together at the last slot is precisely the
   * race a read-then-write loses. A refused turn does not advance the count.
   */
  consumeTurn(id: string, limit: number): Promise<AssistantTurnConsumption>;
  /** Atomically claim the sole initial-suggestion model attempt for this session. */
  claimInitialSuggestions(id: string): Promise<AssistantInitialSuggestionsClaim>;
  completeInitialSuggestions(id: string, prompts: readonly string[]): Promise<boolean>;
  failInitialSuggestions(id: string): Promise<boolean>;
  replaceLatestSuggestions(
    id: string,
    suggestions: AssistantSuggestedPrompts | undefined,
  ): Promise<boolean>;
  replaceLatestView(id: string, view: AssistantRecoverableView | undefined): Promise<boolean>;
  /** Atomically reserve one once-per-session model tool use. */
  claimModelToolUse(id: string, tool: string): Promise<boolean>;
  /** Release a reservation only when execution failed before a usable result or interaction existed. */
  releaseModelToolUse(id: string, tool: string): Promise<boolean>;
  /**
   * Bind an already-open conversation to a signed-in caller (ADR 0201, 5.6b).
   *
   * One seam, and one row: the session is **mutated in place** rather than replaced, so the visitor
   * keeps the conversation they were having. The old token dies with the same statement that installs
   * the new one, which is why this is not a read-then-write — an elevation that left the anonymous
   * token briefly alive would be a window in which both identities could act.
   *
   * `publicEmbedId` is deliberately retained: admission keeps charging the surface that admitted the
   * visitor, exactly as 5.4 designed when it chose to key sessions on the embed rather than on being
   * anonymous. Refuses when the session is already non-anonymous, which is what makes a second
   * elevation impossible without a separate check to forget.
   */
  elevateSession(input: {
    readonly sessionId: string;
    readonly caller: AssistantSessionRecord['caller'];
    /** The elevating client: becomes the session's delegated-credential issuer basis (ADR 0152). */
    readonly clientId: string;
    /** Allowlist-validated by the route: becomes the session's CORS pin, where the conversation continues. */
    readonly origin: string;
    /** Backend-verified customer routes; absent means unchanged, never cleared. */
    readonly customerRouting?: AssistantSessionRecord['customerRouting'];
    /**
     * The surface that owns the elevation origin: the session lands on that surface's projection —
     * capabilities, instructions, budgets, attribution — in the same statement that elevates
     * (ADR 0201 amendment 2026-08-26). Absent means unchanged, the pre-surfaces artifact case.
     */
    readonly boundSurface?: AssistantSessionRecord['boundSurface'];
    /** Arms the one-shot resume of the intercepted tool, in the same statement that elevates. */
    readonly pendingResume?: AssistantPendingResume;
    readonly now: Date;
  }): Promise<AssistantSessionElevation>;

  /**
   * Clear and return the pending resume exactly once, atomically — the turn route calls this both
   * to run the resume and to moot it when the visitor types first, and two requests racing the
   * same arm must not both see it.
   */
  consumePendingResume(sessionId: string): Promise<AssistantPendingResume | undefined>;

  getSession(token: string, now: Date): Promise<AssistantSessionRecord | undefined>;
  nextActivityOrdinal?(id: string): Promise<number>;
  appendHistory(
    id: string,
    messages: readonly AssistantHistoryMessage[],
    activity?: (transaction?: import('@noodle-borg/module').ModuleSqlTransaction) => Promise<void>,
  ): Promise<void>;
  createInteraction(
    input: Extract<AssistantInteractionCreateInput, { readonly kind: 'confirmation' }>,
  ): Promise<AssistantPendingConfirmationInteractionRecord>;
  createInteraction(
    input: Extract<AssistantInteractionCreateInput, { readonly kind: 'input' }>,
  ): Promise<AssistantPendingInputInteractionRecord>;
  claimInteraction(input: AssistantInteractionScope): Promise<AssistantInteractionClaimResult>;
  completeInteraction(
    input: AssistantInteractionScope & {
      readonly completion: import('./assistant-interaction-state.js').AssistantInteractionCompletion;
    },
  ): Promise<AssistantInteractionCompletionResult>;
  transitionInteraction(
    input: AssistantInteractionTransitionInput,
  ): Promise<AssistantInteractionTransitionResult>;
  getInteraction(input: AssistantInteractionScope): Promise<AssistantInteractionRecord | undefined>;
  findPendingInteraction(input: {
    readonly sessionId: string;
    readonly deploymentId: string;
    readonly now: Date;
  }): Promise<AssistantPendingInteractionRecord | undefined>;
  /** @deprecated Temporary compatibility for the accept-only route while it moves to claim/complete. */
  consumeInteraction(
    id: string,
    sessionId: string,
    deploymentId: string,
    now: Date,
  ): Promise<
    | (import('./assistant-interaction-state.js').AssistantConfirmationInteractionRecord & {
        readonly status: 'executing';
      })
    | undefined
  >;
  consumeConsoleApprovalNonce(
    nonce: string,
    subject: string,
    expiresAt: Date,
    now: Date,
  ): Promise<boolean>;
}
