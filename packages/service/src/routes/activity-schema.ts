import { searchHitSchema, searchRequestSchema } from '@noodle-borg/knowledge/portable';
import { ACTIVITY_MAX_EVENT_BYTES, ACTIVITY_RETENTION_MS } from '@noodle-borg/module';
import { z } from 'zod';

const id = z.string().min(1).max(512);
const instant = z.iso.datetime().refine((value) => new Date(value).toISOString() === value);
const channel = z.enum(['website_embed', 'private_test', 'external_mcp', 'unknown']);
const text = z.string().refine((value) => Buffer.byteLength(value, 'utf8') <= 65536);
const turn = {
  sessionId: id,
  turnId: id,
  ordinal: z.number().int().min(1),
  startedAt: instant,
  channel,
};
const base = {
  schemaVersion: z.literal(1),
  id: z.uuid(),
  occurredAt: instant,
  expiresAt: instant,
  tenant: z.strictObject({ org: id, app: id, env: id }),
  deploymentId: id,
  requestId: id.optional(),
};
export const activityEnvelopeSchema = z
  .discriminatedUnion('kind', [
    z.strictObject({
      ...base,
      kind: z.literal('assistant.turn.started'),
      payload: z.strictObject({
        ...turn,
        userText: text,
        userTextTruncated: z.boolean(),
        embedId: id.optional(),
      }),
    }),
    z.strictObject({
      ...base,
      kind: z.literal('assistant.turn.finished'),
      payload: z.strictObject({
        ...turn,
        outcome: z.enum(['completed', 'failed', 'interrupted', 'unknown']),
        assistantText: text,
        assistantTextTruncated: z.boolean(),
        durationMs: z.number().finite().nonnegative(),
        errorCode: id.optional(),
      }),
    }),
    z.strictObject({
      ...base,
      kind: z.literal('knowledge.search.finished'),
      payload: z.strictObject({
        invocationId: id,
        componentName: id,
        toolName: id,
        query: searchRequestSchema.shape.query,
        limit: searchRequestSchema.shape.limit.removeDefault().optional(),
        hits: z.array(searchHitSchema).max(20),
        durationMs: z.number().finite().nonnegative(),
        outcome: z.enum(['success', 'empty', 'error']),
        channel,
        sessionId: id.optional(),
        turnId: id.optional(),
        turnStartedAt: instant.optional(),
        revisionId: id.optional(),
        errorCode: id.optional(),
        clientName: id.optional(),
        clientVersion: id.optional(),
      }),
    }),
  ])
  .refine((value) => Buffer.byteLength(JSON.stringify(value), 'utf8') <= ACTIVITY_MAX_EVENT_BYTES)
  .refine((value) => {
    if (value.kind !== 'knowledge.search.finished') return true;
    const p = value.payload;
    return (
      (p.turnId === undefined) === (p.turnStartedAt === undefined) &&
      (p.turnId === undefined || p.sessionId !== undefined) &&
      (p.outcome === 'success' ? p.hits.length > 0 : p.hits.length === 0)
    );
  })
  .refine((value) => {
    const start =
      value.kind === 'knowledge.search.finished'
        ? (value.payload.turnStartedAt ?? value.occurredAt)
        : value.payload.startedAt;
    return (
      Date.parse(start) <= Date.parse(value.occurredAt) &&
      Date.parse(value.expiresAt) === Date.parse(start) + ACTIVITY_RETENTION_MS
    );
  });
export function boundActivityText(value: string): { text: string; truncated: boolean } {
  if (Buffer.byteLength(value, 'utf8') <= 65536) return { text: value, truncated: false };
  let bytes = 0,
    result = '';
  for (const character of value) {
    const size = Buffer.byteLength(character, 'utf8');
    if (bytes + size > 65536) break;
    result += character;
    bytes += size;
  }
  return { text: result, truncated: true };
}
