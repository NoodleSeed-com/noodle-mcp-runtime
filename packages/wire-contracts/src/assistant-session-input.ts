import { normalizeServerVersion } from '@noodle-borg/module';
import { z } from 'zod';

/** Backend exchange envelope; optional fields retain their legacy downstream validation. */
const privateAssistantSessionInputSchema = z.object({
  origin: z.string(),
  user: z.object({
    id: z.string().min(1).max(240),
    email: z.unknown().optional(),
    name: z.unknown().optional(),
    roles: z.unknown().optional(),
    scopes: z.unknown().optional(),
  }),
  serverVersion: z.unknown().optional(),
  claims: z.unknown().optional(),
  signInTicket: z.unknown().optional(),
  context: z.unknown().optional(),
  preferences: z.unknown().optional(),
  routing: z.unknown().optional(),
  resume: z.unknown().optional(),
});
export function parsePrivateAssistantSessionInput(value: unknown) {
  const result = privateAssistantSessionInputSchema.safeParse(value);
  if (result.success) {
    const value = result.data;
    if (value.serverVersion !== undefined && value.signInTicket !== undefined)
      return {
        ok: false as const,
        error: 'serverVersion only applies to a fresh session' as const,
      };
    let serverVersion: string | undefined;
    if (value.serverVersion !== undefined) {
      try {
        if (typeof value.serverVersion !== 'string' || value.serverVersion.length > 80)
          throw new Error('invalid');
        serverVersion = normalizeServerVersion(value.serverVersion);
        if (serverVersion !== value.serverVersion) throw new Error('noncanonical');
      } catch {
        return { ok: false as const, error: 'invalid serverVersion' as const };
      }
    }
    return { ok: true as const, value: { ...value, serverVersion } };
  }
  return {
    ok: false as const,
    error:
      result.error.issues[0]?.path[0] === 'user'
        ? ('user.id is required' as const)
        : ('origin is not allowed' as const),
  };
}

/** Supplied credential encoding is exactly 32 bytes; trailing base64url padding bits must be zero. */
export const ensureAssistantClientRequestSchema = z.object({
  id: z
    .string()
    .regex(/^embed_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
  idempotencyKey: z.string().regex(/^[\x21-\x7e]{1,256}$/),
  body: z.object({
    name: z.string().max(80).trim().min(1),
    clientSecret: z.string().regex(/^nsa_[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/),
  }),
});
