import type { RuntimeArtifact } from '@noodle-borg/compiler';
import type { AssistantAppearanceSettingsStore } from './assistant-appearance-store.js';
import { effectiveAssistantBrowserConfiguration } from './assistant-configuration.js';
import {
  isAssistantPageContext,
  isAssistantVerifiedClaims,
  parseAssistantContextPreferences,
} from './assistant-context.js';
import { parseAssistantCustomerRouting } from './assistant-customer-routing.js';
import {
  ASSISTANT_SESSION_IDLE_MS,
  type AssistantClientRecord,
  type AssistantSessionRecord,
} from './assistant-store.js';
import { surfaceBindingForOrigin } from './public-surface.js';

interface PrivateSessionIdentityInput {
  readonly origin: string;
  readonly user: { readonly id: string; readonly email?: unknown; readonly name?: unknown };
  readonly claims?: unknown;
  readonly preferences?: unknown;
  readonly context?: unknown;
  readonly routing?: unknown;
}
/** Prepare the same verified identity and surface authority for fresh mint and elevation. */
export function prepareAssistantSessionIdentity(
  artifact: RuntimeArtifact,
  input: PrivateSessionIdentityInput,
  authorization: {
    readonly audience: string;
    readonly roles: readonly string[];
    readonly scopes: readonly string[];
  },
) {
  const assistant = artifact.server.assistant;
  const surface = surfaceBindingForOrigin(assistant, input.origin);
  if (!assistant?.allowedOrigins.includes(input.origin) || surface.kind === 'unowned')
    return { ok: false as const, error: 'origin is not allowed' };
  const routing = parseAssistantCustomerRouting(artifact.customerEndpoints, input.routing);
  if (!routing.ok)
    return {
      ok: false as const,
      error: 'invalid assistant routing',
      ...(routing.endpoint ? { endpoint: routing.endpoint } : {}),
    };
  if (input.claims !== undefined && !isAssistantVerifiedClaims(input.claims))
    return {
      ok: false as const,
      error: 'claims must be flat scalars (<=32 keys, values <=240 chars)',
    };
  const preferences =
    input.preferences === undefined
      ? undefined
      : parseAssistantContextPreferences(input.preferences);
  if (preferences?.ok === false) return { ok: false as const, error: 'invalid preferences' };
  // Undeclared claims never gain authority merely by arriving from the backend.
  const declared = assistant.sessionClaims ?? {};
  const claims = Object.fromEntries(
    Object.entries(isAssistantVerifiedClaims(input.claims) ? input.claims : {}).filter(
      ([key]) => key in declared,
    ),
  );
  const caller = {
    subject: input.user.id,
    ...(typeof input.user.email === 'string' ? { email: input.user.email } : {}),
    ...(typeof input.user.name === 'string' && input.user.name.length <= 240
      ? { name: input.user.name }
      : {}),
    ...(preferences?.ok && preferences.value.locale ? { locale: preferences.value.locale } : {}),
    ...(preferences?.ok && preferences.value.timeZone
      ? { timeZone: preferences.value.timeZone }
      : {}),
    ...(authorization.roles.length === 0 ? {} : { roles: authorization.roles }),
    ...(authorization.scopes.length === 0 ? {} : { scopes: authorization.scopes }),
    ...(Object.keys(claims).length > 0 ? { claims } : {}),
    identityKind: 'customer' as const,
    audience: authorization.audience,
  };
  return {
    ok: true as const,
    origin: input.origin,
    caller,
    surface: surface.kind,
    ...(routing.customerRouting ? { customerRouting: routing.customerRouting } : {}),
    ...(preferences?.ok ? { preferences: preferences.value } : {}),
    ...(isAssistantPageContext(input.context) ? { context: input.context } : {}),
  };
}

type PreparedIdentity = Extract<ReturnType<typeof prepareAssistantSessionIdentity>, { ok: true }>;
type PrivateSessionRecordInput = Omit<
  AssistantSessionRecord,
  'id' | 'tokenHash' | 'history' | 'modelToolUses' | 'turnCount'
>;
/** Portable session record and appearance preparation; persistence and admission stay with the host. */
export async function prepareAssistantSessionRecord(input: {
  readonly client: AssistantClientRecord;
  readonly deploymentId: string;
  readonly artifact: RuntimeArtifact;
  readonly identity: PreparedIdentity;
  readonly appearance: AssistantAppearanceSettingsStore | undefined;
  readonly businessNotice: Parameters<typeof effectiveAssistantBrowserConfiguration>[4];
  readonly now: Date;
}): Promise<{
  readonly authentication: Pick<
    PrivateSessionRecordInput,
    'origin' | 'caller' | 'boundSurface' | 'customerRouting'
  >;
  readonly record: PrivateSessionRecordInput;
}> {
  const { identity, client, artifact } = input;
  const authentication = {
    origin: identity.origin,
    caller: identity.caller,
    ...(identity.surface === 'pre-surfaces' ? {} : { boundSurface: identity.surface }),
    ...(identity.customerRouting ? { customerRouting: identity.customerRouting } : {}),
  };
  const configuration = (
    await effectiveAssistantBrowserConfiguration(
      artifact.server,
      client.tenant,
      input.appearance,
      authentication.boundSurface,
      input.businessNotice,
    )
  ).effective;
  const record: PrivateSessionRecordInput = {
    ...authentication,
    clientId: client.id,
    tenant: client.tenant,
    deploymentId: input.deploymentId,
    modelSource:
      artifact.server.assistant?.model.kind === 'noodle-managed' ? 'noodle-managed' : 'operator',
    ...(identity.context ? { context: identity.context } : {}),
    ...(identity.preferences ? { preferences: identity.preferences } : {}),
    ...(configuration ? { configuration } : {}),
    createdAt: input.now.toISOString(),
    expiresAt: new Date(input.now.getTime() + ASSISTANT_SESSION_IDLE_MS).toISOString(),
    absoluteExpiresAt: new Date(input.now.getTime() + 2 * 60 * 60 * 1000).toISOString(),
  };
  return { authentication, record };
}
