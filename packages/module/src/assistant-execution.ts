/** Trusted generic context for one durably claimed assistant model operation. */
export interface AssistantExecutionContext {
  readonly sessionId: string;
  readonly clientId: string;
  readonly operationId: string;
  readonly requestDigest: string;
  readonly model: {
    readonly source: 'operator' | 'noodle-managed';
    readonly transport: string;
    readonly baseUrl: string;
    readonly model: string;
  };
}
export interface AssistantExecutionPolicy {
  readonly version: 1;
  readonly policyId: string;
  readonly maxModelRequests: number;
  readonly maxInputTokens: number;
  readonly maxCompletionTokens: number;
  readonly maxTokensPerTurn: number;
  readonly maxRequestBytes: number;
  readonly maxToolCallsPerTurn: number;
  readonly timeoutMs: number;
  readonly maxTurnMs: number;
  readonly reasoningEffort: 'none';
}
const numeric = [
  'maxModelRequests',
  'maxInputTokens',
  'maxCompletionTokens',
  'maxTokensPerTurn',
  'maxRequestBytes',
  'maxToolCallsPerTurn',
  'timeoutMs',
  'maxTurnMs',
] as const;
/** Invalid and unknown allow-side fields fail closed, including fractional and unsafe bounds. */
export function parseAssistantExecutionPolicy(
  value: unknown,
): AssistantExecutionPolicy | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const keys: readonly string[] = ['version', 'policyId', 'reasoningEffort', ...numeric];
  if (
    Object.keys(record).length !== keys.length ||
    Object.keys(record).some((key) => !keys.includes(key)) ||
    record.version !== 1 ||
    record.reasoningEffort !== 'none' ||
    typeof record.policyId !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(record.policyId)
  )
    return undefined;
  for (const key of numeric) {
    const bound = record[key];
    if (
      typeof bound !== 'number' ||
      !Number.isSafeInteger(bound) ||
      bound < (key === 'maxToolCallsPerTurn' ? 0 : 1)
    )
      return undefined;
    if ((key === 'timeoutMs' || key === 'maxTurnMs') && bound > 2_147_483_647) return undefined;
  }
  return { ...record } as unknown as AssistantExecutionPolicy;
}
