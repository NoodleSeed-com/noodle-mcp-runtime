import {
  AssistantModelError,
  managedSponsorshipExhausted,
  managedSponsorshipUnavailable,
  modelFetchError,
  modelHttpError,
  modelRequestError,
  modelResponseError,
} from './model-error.js';
import {
  assistantExecutionRequest,
  countAssistantExecutionInput,
  finishAssistantExecutionRequest,
  withinAssistantDeadline,
} from './model-execution.js';
import { readResponsesCompletion, responsesInput, responsesTools } from './model-responses.js';
import { type ModelCompletion, type ModelToolCall, readModelCompletion } from './model-stream.js';

export type AssistantModelSource = 'operator' | 'noodle-managed';
export type AssistantModelTransport = 'chat-completions' | 'responses';

export interface AssistantModelRequestPolicy {
  readonly maxCompletionTokens?: number;
  readonly maxTokensPerTurn?: number;
  readonly maxRequestBytes?: number;
  /**
   * Per-tenant agent-loop bounds. The deployment-wide admission envelope still wins whenever it is
   * lower — these narrow a turn for one tenant, they never widen it for anyone.
   */
  readonly maxModelStepsPerTurn?: number;
  readonly maxToolCallsPerTurn?: number;
  readonly timeoutMs?: number;
  readonly maxTurnMs?: number;
  /** Trusted operator-selected OpenAI-compatible request extensions. */
  readonly extraBody?: Readonly<Record<string, unknown>>;
}

interface ResolvedAssistantModelBase {
  readonly requireExecutionAdmission?: boolean;
  readonly source: AssistantModelSource;
  readonly transport?: AssistantModelTransport;
  readonly baseUrl: string;
  readonly model: string;
  readonly requestPolicy?: AssistantModelRequestPolicy;
  /**
   * Private hosted sponsorship admission. It is deliberately attached to the resolved binding so
   * every path that reaches provider I/O passes the same gate, including suggestions, interaction
   * narration, authenticated assistants, and doctor probes.
   */
  readonly sponsorship?: {
    readonly accountKey: string;
    readonly allowance: number;
    readonly units: number;
    admit(): Promise<boolean>;
  };
  readonly publicAdmission?: {
    readonly defaults: {
      readonly turnsPerSession: number;
      readonly turnsPerDay: number;
      readonly mintsPerDay: number;
    };
    readonly ceiling: {
      readonly turnsPerDay: number;
      readonly mintsPerDay: number;
    };
    /**
     * Platform spend accounting, present only when someone other than the customer is paying. Passed
     * through to `SurfaceBudgetBounds` unchanged, which is why the shape is declared identically
     * here rather than imported — the two contracts stay independent by design.
     */
    readonly spend?: {
      readonly key: string;
      readonly units: number;
      readonly allowance: number;
    };
  };
}

export type ResolvedAssistantModel = ResolvedAssistantModelBase &
  (
    | { readonly apiKey: string; readonly bearerToken?: never }
    | { readonly apiKey?: never; readonly bearerToken: () => Promise<string> }
  );

export interface ManagedAssistantModelResolver {
  resolve(input: {
    readonly tenant: { readonly org: string; readonly app: string; readonly env: string };
    readonly deploymentId: string;
  }): Promise<ResolvedAssistantModel | undefined>;
}

export type AssistantModelMessage =
  | {
      readonly role: 'system' | 'user' | 'assistant';
      readonly content: string;
      readonly tool_calls?: readonly ModelToolCall[];
    }
  | { readonly role: 'tool'; readonly tool_call_id: string; readonly content: string };

export interface AssistantModelTool {
  readonly type: 'function';
  readonly function: {
    readonly name: string;
    readonly description?: string;
    readonly parameters: unknown;
  };
}

export async function requestModelCompletion(input: {
  readonly binding: ResolvedAssistantModel;
  readonly messages: readonly AssistantModelMessage[];
  readonly tools: readonly AssistantModelTool[];
  readonly toolChoice?: 'auto' | 'none' | 'required';
  readonly jsonOutput?: boolean;
  readonly fetcher: (url: string, init: RequestInit) => Promise<Response>;
  readonly onContent?: (delta: string) => void;
  readonly maxResponseBytes?: number;
  readonly maxCompletionTokens?: number;
  readonly signal?: AbortSignal;
}): Promise<ModelCompletion> {
  const { binding } = input;
  const transport = binding.transport ?? 'chat-completions';
  const url = new URL(
    `${binding.baseUrl.replace(/\/$/, '')}/${transport === 'responses' ? 'responses' : 'chat/completions'}`,
  );
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw modelRequestError('unsafe model endpoint');
  }
  const execution = assistantExecutionRequest(binding, input.maxCompletionTokens);
  const completionLimit =
    execution?.completionLimit ??
    Math.min(
      input.maxCompletionTokens ?? Infinity,
      binding.requestPolicy?.maxCompletionTokens ?? Infinity,
    );
  const body = JSON.stringify(
    transport === 'responses'
      ? {
          ...binding.requestPolicy?.extraBody,
          model: binding.model,
          stream: true,
          store: false,
          ...(execution ? { reasoning: { effort: 'none' } } : {}),
          input: responsesInput(input.messages),
          tools: responsesTools(input.tools),
          ...(input.jsonOutput ? { text: { format: { type: 'json_object' } } } : {}),
          ...(input.toolChoice === undefined ? {} : { tool_choice: input.toolChoice }),
          ...(!Number.isFinite(completionLimit) ? {} : { max_output_tokens: completionLimit }),
        }
      : {
          ...binding.requestPolicy?.extraBody,
          model: binding.model,
          stream: true,
          messages: input.messages,
          tools: input.tools,
          ...(input.jsonOutput ? { response_format: { type: 'json_object' } } : {}),
          ...(input.toolChoice === undefined ? {} : { tool_choice: input.toolChoice }),
          ...(!Number.isFinite(completionLimit) ? {} : { max_completion_tokens: completionLimit }),
        },
  );
  const requestBytes = new TextEncoder().encode(body).byteLength;
  const maxRequestBytes = binding.requestPolicy?.maxRequestBytes;
  if (maxRequestBytes !== undefined && requestBytes > maxRequestBytes) {
    throw modelRequestError('model request too large');
  }
  const timeoutSignal =
    execution?.signal ?? AbortSignal.timeout(binding.requestPolicy?.timeoutMs ?? 30_000);
  const signal =
    input.signal === undefined ? timeoutSignal : AbortSignal.any([input.signal, timeoutSignal]);
  try {
    signal.throwIfAborted();
    return await withinAssistantDeadline(
      (async () => {
        await admitSponsorship(binding);
        signal.throwIfAborted();
        const bearerToken = binding.apiKey ?? (await binding.bearerToken());
        if (!/^[^\s]{1,8192}$/.test(bearerToken))
          throw modelRequestError('invalid model bearer token');
        signal.throwIfAborted();
        const headers = {
          Authorization: `Bearer ${bearerToken}`,
          'content-type': 'application/json',
        };
        await countAssistantExecutionInput(binding, body, input.fetcher, headers, signal);
        signal.throwIfAborted();
        let response: Response;
        try {
          response = await input.fetcher(url.href, {
            method: 'POST',
            headers,
            body,
            redirect: 'manual',
            signal,
          });
        } catch (error) {
          throw modelFetchError(error);
        }
        if (!response.ok) throw modelHttpError(response.status);
        try {
          const completion = await (transport === 'responses'
            ? readResponsesCompletion
            : readModelCompletion)(
            response,
            (delta) => {
              if (!signal.aborted) input.onContent?.(delta);
            },
            Math.min(input.maxResponseBytes ?? 1 << 20, 1 << 20),
          );
          finishAssistantExecutionRequest(binding, completion);
          return completion;
        } catch (error) {
          if (error instanceof AssistantModelError) throw error;
          throw modelResponseError(error);
        }
      })(),
      signal,
    );
  } catch (error) {
    finishAssistantExecutionRequest(binding);
    throw error;
  }
}

/** One resolved binding represents one bounded model operation, even when its agent loop has steps. */
const sponsorshipAdmissions = new WeakMap<ResolvedAssistantModel, Promise<boolean>>();

async function admitSponsorship(binding: ResolvedAssistantModel): Promise<void> {
  if (binding.source !== 'noodle-managed' || binding.sponsorship === undefined) return;
  let admission = sponsorshipAdmissions.get(binding);
  if (admission === undefined) {
    admission = binding.sponsorship.admit();
    sponsorshipAdmissions.set(binding, admission);
  }
  let allowed: boolean;
  try {
    allowed = await admission;
  } catch (error) {
    throw managedSponsorshipUnavailable(error);
  }
  if (!allowed) throw managedSponsorshipExhausted();
}
