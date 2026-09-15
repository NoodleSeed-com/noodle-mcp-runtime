import { afterEach, expect, it, vi } from 'vitest';
import { GoogleCloudStorageTransport } from '../src/gcs-transport.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function credential() {
  return Response.json(
    { access_token: 'synthetic-google-token', expires_in: 3600, token_type: 'Bearer' },
    { headers: { 'metadata-flavor': 'Google' } },
  );
}
it('uses the fixed GCS API, caches metadata identity and always applies create-if-absent', async () => {
  const requests: { url: URL; init: RequestInit }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, init) => {
      const address = new URL(url);
      requests.push({ url: address, init });
      if (address.hostname === 'metadata.google.internal') return credential();
      if (init.method === 'POST') return Response.json({ generation: '1' });
      return new Response('content');
    }),
  );
  const transport = new GoogleCloudStorageTransport('private-example-assets');
  expect(await transport.create('objects/a/b', Buffer.from('bytes'))).toBe(true);
  expect((await transport.read('objects/a/b', 100))?.toString()).toBe('content');
  expect(requests).toHaveLength(3);
  expect(requests[1]?.url.origin).toBe('https://storage.googleapis.com');
  expect(requests[1]?.url.searchParams.get('ifGenerationMatch')).toBe('0');
  expect(requests[1]?.url.searchParams.get('name')).toBe('objects/a/b');
  expect(requests.every((request) => request.init.redirect === 'error')).toBe(true);
});
it('treats provider precondition failure as a conflict and bounds downloaded bytes', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, init) => {
      if (String(url).includes('metadata.google.internal')) return credential();
      if (init.method === 'POST') return new Response('', { status: 412 });
      return new Response('oversize');
    }),
  );
  const transport = new GoogleCloudStorageTransport('private-example-assets');
  expect(await transport.create('objects/a', Buffer.from('x'))).toBe(false);
  await expect(transport.read('objects/a', 2)).rejects.toThrow('exceeds limit');
});
it('does not call GCS with malformed metadata or expose provider errors', async () => {
  const fetcher = vi.fn(async () => new Response('private upstream error', { status: 500 }));
  vi.stubGlobal('fetch', fetcher);
  await expect(
    new GoogleCloudStorageTransport('private-example-assets').read('objects/a', 100),
  ).rejects.toThrow('credentials unavailable');
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('aborts a hung provider request after ten seconds', async () => {
  vi.useFakeTimers();
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (_url, init) =>
        new Promise((_resolve, reject) =>
          init.signal.addEventListener('abort', () => reject(new Error('aborted'))),
        ),
    ),
  );
  const result = new GoogleCloudStorageTransport('private-example-assets')
    .read('objects/a', 100)
    .catch((error) => error.message);
  await vi.advanceTimersByTimeAsync(10000);
  expect(await result).toBe('aborted');
});
