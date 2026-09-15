import { createHash } from 'node:crypto';
import type { AssistantClientRecord } from './assistant-store.js';
import type { TenantRef } from './tenant-ref.js';

export interface EnsureAssistantClientInput {
  readonly id: string;
  readonly name: string;
  readonly clientSecret: string;
  readonly idempotencyKey: string;
  readonly tenant: TenantRef;
  /** Omit to recover a receipt before resolving mutable deployment availability. */
  readonly creation?:
    | { readonly deploymentId: string; readonly allowedOrigins: readonly string[] }
    | undefined;
  readonly now: Date;
}
export type EnsureAssistantClientResult =
  | { readonly disposition: 'created' | 'replayed'; readonly client: AssistantClientRecord }
  | { readonly disposition: 'conflict' | 'unavailable' | 'missing' };
export interface AssistantClientProvisioning {
  readonly keyHash: string;
  readonly fingerprint: string;
  readonly secretHash: string;
}
export function assistantClientProvisioning(
  input: EnsureAssistantClientInput,
): AssistantClientProvisioning {
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  const secretHash = hash(input.clientSecret);
  return {
    keyHash: hash(input.idempotencyKey),
    secretHash,
    fingerprint: hash(
      JSON.stringify([
        'assistant-client-v1',
        input.tenant.org,
        input.tenant.app,
        input.tenant.env,
        input.id,
        input.name.trim(),
        secretHash,
      ]),
    ),
  };
}
export function replayAssistantClient(
  input: EnsureAssistantClientInput,
  requested: AssistantClientProvisioning,
  client: AssistantClientRecord,
  stored: Pick<AssistantClientProvisioning, 'keyHash' | 'fingerprint'> | undefined,
): EnsureAssistantClientResult {
  if (
    client.id !== input.id ||
    client.tenant.org !== input.tenant.org ||
    client.tenant.app !== input.tenant.app ||
    client.tenant.env !== input.tenant.env ||
    stored?.keyHash !== requested.keyHash ||
    stored.fingerprint !== requested.fingerprint
  )
    return { disposition: 'conflict' };
  if (client.revokedAt || client.secretHash !== requested.secretHash)
    return { disposition: 'unavailable' };
  return { disposition: 'replayed', client };
}

export class InMemoryAssistantClientProvisioning {
  readonly #provisioning = new Map<string, AssistantClientProvisioning>();
  readonly #provisioningKeys = new Map<string, string>();
  ensure(
    input: EnsureAssistantClientInput,
    clients: Map<string, AssistantClientRecord>,
  ): EnsureAssistantClientResult {
    const provisioning = assistantClientProvisioning(input);
    const key = JSON.stringify([
      input.tenant.org,
      input.tenant.app,
      input.tenant.env,
      provisioning.keyHash,
    ]);
    const winner = this.#provisioningKeys.get(key);
    const current = clients.get(winner ?? input.id);
    if (current)
      return replayAssistantClient(
        input,
        provisioning,
        current,
        this.#provisioning.get(current.id),
      );
    if (!input.creation) return { disposition: 'missing' };
    const client: AssistantClientRecord = {
      id: input.id,
      name: input.name.trim(),
      tenant: { ...input.tenant },
      deploymentId: input.creation.deploymentId,
      allowedOrigins: [...input.creation.allowedOrigins],
      secretHash: provisioning.secretHash,
      createdAt: input.now.toISOString(),
    };
    clients.set(client.id, client);
    this.#provisioning.set(client.id, provisioning);
    this.#provisioningKeys.set(key, client.id);
    return { disposition: 'created', client };
  }
}
