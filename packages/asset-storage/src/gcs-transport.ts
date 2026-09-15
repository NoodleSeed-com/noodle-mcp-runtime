/** Official GCS JSON API transport. The bucket stays private; no redirects or provider URLs escape. */
export interface GcsObjectTransport {
  read(key: string, maxBytes: number): Promise<Buffer | undefined>;
  create(key: string, bytes: Buffer): Promise<boolean>;
}
const API = 'https://storage.googleapis.com';
export class GoogleCloudStorageTransport implements GcsObjectTransport {
  readonly #bucket: string;
  #credential: { token: string; expiresAt: number } | undefined;
  constructor(bucket: string) {
    if (!/^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/.test(bucket))
      throw new TypeError('invalid asset bucket');
    this.#bucket = bucket;
  }
  async #token(signal: AbortSignal): Promise<string> {
    if (this.#credential !== undefined && this.#credential.expiresAt > Date.now() + 60000)
      return this.#credential.token;
    const response = await fetch(
      'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
      { headers: { 'metadata-flavor': 'Google' }, redirect: 'error', signal },
    );
    if (!response.ok || response.headers.get('metadata-flavor') !== 'Google')
      throw new Error('asset storage credentials unavailable');
    const data: unknown = JSON.parse((await boundedBody(response, 16384)).toString('utf8'));
    if (
      typeof data !== 'object' ||
      data === null ||
      !('access_token' in data) ||
      typeof data.access_token !== 'string' ||
      !/^[^\s]{1,8192}$/.test(data.access_token) ||
      !('expires_in' in data) ||
      typeof data.expires_in !== 'number' ||
      !Number.isFinite(data.expires_in) ||
      data.expires_in <= 60 ||
      data.expires_in > 3600 ||
      !('token_type' in data) ||
      data.token_type !== 'Bearer'
    )
      throw new Error('asset storage credentials unavailable');
    this.#credential = { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
    return data.access_token;
  }
  async read(key: string, maxBytes: number): Promise<Buffer | undefined> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const token = await this.#token(controller.signal);
      const response = await fetch(
        `${API}/storage/v1/b/${encodeURIComponent(this.#bucket)}/o/${encodeURIComponent(key)}?alt=media`,
        {
          headers: { authorization: `Bearer ${token}` },
          redirect: 'error',
          signal: controller.signal,
        },
      );
      if (response.status === 404) return undefined;
      if (!response.ok) throw new Error('asset storage read failed');
      return await boundedBody(response, maxBytes);
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }
  async create(key: string, bytes: Buffer): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const token = await this.#token(controller.signal);
      const url = new URL(`${API}/upload/storage/v1/b/${encodeURIComponent(this.#bucket)}/o`);
      url.searchParams.set('uploadType', 'media');
      url.searchParams.set('name', key);
      url.searchParams.set('ifGenerationMatch', '0');
      const response = await fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' },
        body: new Uint8Array(bytes),
        redirect: 'error',
        signal: controller.signal,
      });
      if (response.status === 412) return false;
      if (!response.ok) throw new Error('asset storage write failed');
      await boundedBody(response, 16384);
      return true;
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }
}
async function boundedBody(response: Response, maxBytes: number): Promise<Buffer> {
  if (response.body === null) throw new Error('asset storage response missing');
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > maxBytes) throw new Error('asset storage response exceeds limit');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}
