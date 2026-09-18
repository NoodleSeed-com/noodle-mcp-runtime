const MAX_RESPONSE_BYTES = 16 * 1_024;
export interface OperatorHttpConfig {
  readonly url: string;
  readonly token: string;
  readonly googleAudience?: string;
}
/** Fixed operator destination; credentials never follow redirects or enter tool arguments. */
export function createOperatorJsonPost(
  config: OperatorHttpConfig,
): (body: unknown, signal: AbortSignal) => Promise<Response> {
  if (config.googleAudience !== undefined) {
    const policy = new URL(config.url);
    const audience = new URL(config.googleAudience);
    if (
      policy.protocol !== 'https:' ||
      !policy.hostname.endsWith('.run.app') ||
      policy.username ||
      policy.password ||
      policy.port ||
      audience.origin !== policy.origin ||
      config.googleAudience !== audience.origin
    ) {
      throw new Error('Google admission identity requires the same HTTPS Cloud Run origin');
    }
  }
  let identity: { token: string; expiresAt: number } | undefined;
  return async (body, signal) => {
    if (
      config.googleAudience !== undefined &&
      (identity === undefined || identity.expiresAt - 60_000 <= Date.now())
    ) {
      identity = await fetchGoogleIdentity(config.googleAudience, signal);
    }
    return fetch(config.url, {
      method: 'POST',
      redirect: 'error',
      signal,
      headers: {
        authorization: `Bearer ${config.token}`,
        ...(identity === undefined
          ? {}
          : { 'x-serverless-authorization': `Bearer ${identity.token}` }),
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(body),
    });
  };
}
/** Fixed metadata endpoint. Audience-bound ID tokens only reach the matching Cloud Run origin. */
async function fetchGoogleIdentity(
  audience: string,
  signal: AbortSignal,
): Promise<{ token: string; expiresAt: number }> {
  const url = new URL(
    'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity',
  );
  url.searchParams.set('audience', audience);
  url.searchParams.set('format', 'full');
  const response = await fetch(url, {
    headers: { 'metadata-flavor': 'Google' },
    redirect: 'error',
    signal,
  });
  if (
    !response.ok ||
    response.headers.get('metadata-flavor') !== 'Google' ||
    response.body === null
  )
    throw new Error('identity unavailable');
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > MAX_RESPONSE_BYTES) throw new Error('identity unavailable');
    chunks.push(chunk);
  }
  const token = Buffer.concat(chunks).toString('utf8');
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token))
    throw new Error('identity unavailable');
  const payload: unknown = JSON.parse(
    Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'),
  );
  if (
    typeof payload !== 'object' ||
    payload === null ||
    !('exp' in payload) ||
    typeof payload.exp !== 'number' ||
    !Number.isSafeInteger(payload.exp) ||
    !('aud' in payload) ||
    payload.aud !== audience ||
    payload.exp * 1000 <= Date.now() + 60_000
  )
    throw new Error('identity unavailable');
  return { token, expiresAt: payload.exp * 1000 };
}
