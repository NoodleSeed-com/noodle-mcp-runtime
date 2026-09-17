import type { ModuleSqlTransaction } from './sql-transaction.js';
export type ActivityChannel = 'website_embed' | 'private_test' | 'external_mcp' | 'unknown';
export interface ActivityTurnIdentity {
  readonly sessionId: string;
  readonly turnId: string;
  readonly ordinal: number;
  readonly startedAt: string;
  readonly channel: ActivityChannel;
}
export interface ActivityStarted extends ActivityTurnIdentity {
  readonly userText: string;
  readonly userTextTruncated: boolean;
  readonly embedId?: string | undefined;
}
export interface ActivityFinished extends ActivityTurnIdentity {
  readonly outcome: 'completed' | 'failed' | 'interrupted' | 'unknown';
  readonly assistantText: string;
  readonly assistantTextTruncated: boolean;
  readonly durationMs: number;
  readonly errorCode?: string | undefined;
}
export interface ActivitySearch {
  readonly invocationId: string;
  readonly componentName: string;
  readonly toolName: string;
  readonly query: string;
  readonly limit?: number | undefined;
  readonly hits: readonly {
    readonly id: string;
    readonly title: string;
    readonly excerpt: string;
    readonly sourceKind: 'document' | 'site';
    readonly uri?: string | undefined;
  }[];
  readonly durationMs: number;
  readonly outcome: 'success' | 'empty' | 'error';
  readonly channel: ActivityChannel;
  readonly sessionId?: string | undefined;
  readonly turnId?: string | undefined;
  readonly turnStartedAt?: string | undefined;
  readonly revisionId?: string | undefined;
  readonly errorCode?: string | undefined;
  readonly clientName?: string | undefined;
  readonly clientVersion?: string | undefined;
}
interface ActivityBase {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly occurredAt: string;
  readonly expiresAt: string;
  readonly tenant: { readonly org: string; readonly app: string; readonly env: string };
  readonly deploymentId: string;
  readonly requestId?: string | undefined;
}
export type ActivityEnvelope = ActivityBase &
  (
    | { readonly kind: 'assistant.turn.started'; readonly payload: ActivityStarted }
    | { readonly kind: 'assistant.turn.finished'; readonly payload: ActivityFinished }
    | { readonly kind: 'knowledge.search.finished'; readonly payload: ActivitySearch }
  );
export interface ActivityLease {
  readonly leaseToken: string;
  readonly leaseExpiresAt: string;
  readonly events: readonly ActivityEnvelope[];
}
export interface ActivityOutbox {
  append(event: ActivityEnvelope, transaction?: ModuleSqlTransaction): Promise<void>;
  claim(org: string, limit: number): Promise<ActivityLease>;
  ack(org: string, leaseToken: string, eventIds: readonly string[]): Promise<number>;
  purgeExpired(limit?: number): Promise<number>;
}
export const ACTIVITY_MAX_EVENT_BYTES = 256 * 1024;
export const ACTIVITY_MAX_BATCH_BYTES = 1024 * 1024;
export const ACTIVITY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
