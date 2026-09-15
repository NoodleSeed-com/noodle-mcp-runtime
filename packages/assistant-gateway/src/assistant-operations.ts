import { createHash, randomUUID } from 'node:crypto';
import type { TenantRef } from './tenant-ref.js';

export interface AssistantOperationScope {
  readonly sessionId: string;
  readonly clientId: string;
  readonly tenant: TenantRef;
  readonly deploymentId: string;
  readonly serverVersion: string;
  readonly origin: string;
}
export interface AssistantOperation {
  readonly operationId: string;
  readonly status: 'prepared' | 'executing' | 'completed' | 'denied' | 'unknown';
}
export interface AssistantOperationInput extends AssistantOperationScope {
  readonly requestKey: string;
  readonly requestDigest: string;
}
export type AssistantOperationTerminal = 'completed' | 'denied' | 'unknown';
export interface AssistantOperationStore {
  prepare(input: AssistantOperationInput): Promise<AssistantOperation | undefined>;
  get(id: string, scope: AssistantOperationScope): Promise<AssistantOperation | undefined>;
  claim(
    id: string,
    input: AssistantOperationScope & { readonly requestDigest: string },
  ): Promise<boolean>;
  finish(
    id: string,
    scope: AssistantOperationScope,
    status: AssistantOperationTerminal,
  ): Promise<void>;
}

/** Canonical object ordering; arrays and all string content retain their meaning. */
export function assistantOperationDigest(value: unknown): string {
  return createHash('sha256')
    .update(
      JSON.stringify(value, (_key, item) => {
        if (typeof item !== 'object' || item === null || Array.isArray(item)) return item;
        return Object.fromEntries(
          Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        );
      }),
    )
    .digest('hex');
}
export function assistantOperationScopeKey(scope: AssistantOperationScope): string {
  return assistantOperationDigest({
    sessionId: scope.sessionId,
    clientId: scope.clientId,
    tenant: scope.tenant,
    deploymentId: scope.deploymentId,
    serverVersion: scope.serverVersion,
    origin: scope.origin,
  });
}

/** No lease: a lost executor remains active until a new conversation is explicitly started. */
export class InMemoryAssistantOperations implements AssistantOperationStore {
  readonly #records = new Map<
    string,
    { input: AssistantOperationInput; operation: AssistantOperation; scope: string }
  >();
  async prepare(input: AssistantOperationInput): Promise<AssistantOperation | undefined> {
    const scope = assistantOperationScopeKey(input);
    for (const record of this.#records.values()) {
      if (record.input.sessionId !== input.sessionId) continue;
      if (record.input.requestKey === input.requestKey)
        return record.scope === scope && record.input.requestDigest === input.requestDigest
          ? { ...record.operation }
          : undefined;
      if (['prepared', 'executing', 'unknown'].includes(record.operation.status)) return undefined;
    }
    const operation: AssistantOperation = { operationId: randomUUID(), status: 'prepared' };
    this.#records.set(operation.operationId, { input: structuredClone(input), operation, scope });
    return { ...operation };
  }
  async get(id: string, scope: AssistantOperationScope): Promise<AssistantOperation | undefined> {
    const record = this.#records.get(id);
    return record?.scope === assistantOperationScopeKey(scope)
      ? { ...record.operation }
      : undefined;
  }
  async claim(
    id: string,
    input: AssistantOperationScope & { readonly requestDigest: string },
  ): Promise<boolean> {
    const record = this.#records.get(id);
    if (
      record?.scope !== assistantOperationScopeKey(input) ||
      record.input.requestDigest !== input.requestDigest ||
      record.operation.status !== 'prepared'
    )
      return false;
    record.operation = { operationId: id, status: 'executing' };
    return true;
  }
  async finish(
    id: string,
    scope: AssistantOperationScope,
    status: AssistantOperationTerminal,
  ): Promise<void> {
    const record = this.#records.get(id);
    if (
      record?.scope === assistantOperationScopeKey(scope) &&
      record.operation.status === 'executing'
    )
      record.operation = { operationId: id, status };
  }
}
