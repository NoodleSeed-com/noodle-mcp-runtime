import { type AssistantExecutionPolicy, parseAssistantExecutionPolicy } from '@noodle-borg/module';
import { modelRequestError } from './model-error.js';
import type { ResolvedAssistantModel } from './model-request.js';
import { readBoundedText } from './model-response-values.js';
import type { ModelCompletion } from './model-stream.js';

interface ExecutionPermit {
  readonly policy: AssistantExecutionPolicy;
  readonly deadline: number;
  requests: number;
  outputReserved: number;
  tools: number;
  failed: boolean;
}
const permits = new WeakMap<ResolvedAssistantModel, ExecutionPermit>();

/** A fresh object is one execution, never a reusable admission decision or a shared tenant binding. */
export function permitAssistantModelExecution(
  binding: ResolvedAssistantModel,
  value: AssistantExecutionPolicy,
): ResolvedAssistantModel {
  const policy = parseAssistantExecutionPolicy(value);
  if (!policy) throw modelRequestError('invalid assistant execution policy');
  const old = binding.requestPolicy;
  const narrower = (next: number, previous?: number) => Math.min(next, previous ?? next);
  const requestPolicy = {
    ...old,
    maxCompletionTokens: narrower(policy.maxCompletionTokens, old?.maxCompletionTokens),
    maxTokensPerTurn: narrower(policy.maxTokensPerTurn, old?.maxTokensPerTurn),
    maxRequestBytes: narrower(policy.maxRequestBytes, old?.maxRequestBytes),
    maxModelStepsPerTurn: narrower(policy.maxModelRequests, old?.maxModelStepsPerTurn),
    maxToolCallsPerTurn: narrower(policy.maxToolCallsPerTurn, old?.maxToolCallsPerTurn),
    timeoutMs: narrower(policy.timeoutMs, old?.timeoutMs),
    maxTurnMs: narrower(policy.maxTurnMs, old?.maxTurnMs),
  };
  const resolved = Object.freeze({
    ...binding,
    requireExecutionAdmission: true,
    requestPolicy: Object.freeze(requestPolicy),
  });
  permits.set(resolved, {
    policy,
    deadline: performance.now() + requestPolicy.maxTurnMs,
    requests: 0,
    outputReserved: 0,
    tools: 0,
    failed: false,
  });
  return resolved;
}

export function assistantExecutionRequest(
  binding: ResolvedAssistantModel,
  requested?: number,
): { readonly completionLimit: number; readonly signal: AbortSignal } | undefined {
  const permit = permits.get(binding);
  if (!permit) {
    if (binding.requireExecutionAdmission)
      throw modelRequestError('assistant execution permit required');
    return undefined;
  }
  const bounds = binding.requestPolicy;
  if (
    binding.transport !== 'responses' ||
    permit.failed ||
    performance.now() >= permit.deadline ||
    permit.requests >=
      Math.min(permit.policy.maxModelRequests, bounds?.maxModelStepsPerTurn ?? Infinity)
  )
    throw modelRequestError('assistant execution limit reached');
  // Only documented countable inputs; remote conversation state and provider-specific inputs refuse.
  if (
    Object.keys(bounds?.extraBody ?? {}).some(
      (key) =>
        ![
          'instructions',
          'text',
          'tool_choice',
          'parallel_tool_calls',
          'reasoning',
          'truncation',
        ].includes(key),
    )
  )
    throw modelRequestError('unsupported protected model input');
  const completionLimit = Math.min(
    requested ?? Infinity,
    bounds?.maxCompletionTokens ?? Infinity,
    (bounds?.maxTokensPerTurn ?? permit.policy.maxTokensPerTurn) - permit.outputReserved,
  );
  if (!Number.isSafeInteger(completionLimit) || completionLimit < 1)
    throw modelRequestError('assistant output limit reached');
  permit.requests += 1;
  // Reserve the entire requested ceiling, even if usage is missing, truncated, or unavailable.
  // This is conservative execution accounting, never financial settlement.
  permit.outputReserved += completionLimit;
  return {
    completionLimit,
    signal: AbortSignal.timeout(
      Math.max(
        1,
        Math.ceil(
          Math.min(
            bounds?.timeoutMs ?? permit.policy.timeoutMs,
            permit.deadline - performance.now(),
          ),
        ),
      ),
    ),
  };
}

export async function countAssistantExecutionInput(
  binding: ResolvedAssistantModel,
  body: string,
  fetcher: (url: string, init: RequestInit) => Promise<Response>,
  headers: NonNullable<RequestInit['headers']>,
  signal: AbortSignal,
): Promise<void> {
  const permit = permits.get(binding);
  if (!permit) return;
  const payload: Record<string, unknown> = JSON.parse(body);
  const counted = Object.fromEntries(
    Object.entries(payload).filter(([key]) =>
      [
        'model',
        'input',
        'tools',
        'instructions',
        'text',
        'tool_choice',
        'parallel_tool_calls',
        'reasoning',
        'truncation',
      ].includes(key),
    ),
  );
  const response = await fetcher(`${binding.baseUrl.replace(/\/$/, '')}/responses/input_tokens`, {
    method: 'POST',
    headers,
    body: JSON.stringify(counted),
    redirect: 'manual',
    signal,
  });
  if (!response.ok) throw modelRequestError('model input count unavailable');
  const result: unknown = JSON.parse(await readBoundedText(response, 16_384));
  if (
    typeof result !== 'object' ||
    result === null ||
    !('input_tokens' in result) ||
    typeof result.input_tokens !== 'number' ||
    !Number.isSafeInteger(result.input_tokens) ||
    result.input_tokens < 0 ||
    result.input_tokens > permit.policy.maxInputTokens
  )
    throw modelRequestError('model input count exceeds policy or is invalid');
}

export function finishAssistantExecutionRequest(
  binding: ResolvedAssistantModel,
  completion?: ModelCompletion,
): void {
  const permit = permits.get(binding);
  if (!permit) return;
  if (!completion) {
    permit.failed = true;
    return;
  }
  const calls = completion.choices.reduce(
    (count, choice) => count + (choice.message?.tool_calls?.length ?? 0),
    0,
  );
  permit.tools += calls;
  if (
    permit.tools > (binding.requestPolicy?.maxToolCallsPerTurn ?? permit.policy.maxToolCallsPerTurn)
  ) {
    permit.failed = true;
    throw modelRequestError('assistant tool call limit reached');
  }
}

/** Enforce deadlines even when a custom fetcher ignores AbortSignal or stalls while reading a body. */
export async function withinAssistantDeadline<T>(
  work: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  let abort: (() => void) | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    abort = () => reject(modelRequestError('assistant model deadline exceeded'));
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    return await Promise.race([work, expired]);
  } finally {
    if (abort) signal.removeEventListener('abort', abort);
  }
}
