import { afterEach, expect, it, vi } from 'vitest';
import { createHttpAdmissionGate } from '../src/http-admission.js';

const context = {
  method: 'tools/list',
  category: 'discover',
  routeId: 'a/b/c',
  requestId: 'one',
} as Parameters<ReturnType<typeof createHttpAdmissionGate>>[0];
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it('separates Google service identity from the business bearer and refreshes before expiry', async () => {
  let now = 100000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const calls: { url: string; headers: Headers }[] = [];
  let issued = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, init) => {
      calls.push({ url: String(url), headers: new Headers(init?.headers) });
      if (String(url).startsWith('http://metadata.google.internal/')) {
        issued++;
        return new Response(
          `a.${Buffer.from(JSON.stringify({ exp: now / 1000 + 120, aud: 'https://policy-test.run.app' })).toString('base64url')}.token${issued}`,
          { headers: { 'metadata-flavor': 'Google' } },
        );
      }
      return Response.json({ allow: true });
    }),
  );
  const gate = createHttpAdmissionGate({
    url: 'https://policy-test.run.app/admit',
    token: 'business-secret',
    googleAudience: 'https://policy-test.run.app',
  });
  expect(await gate(context)).toEqual({ allow: true });
  expect(await gate(context)).toEqual({ allow: true });
  expect(issued).toBe(1);
  expect(calls[1]?.headers.get('authorization')).toBe('Bearer business-secret');
  expect(calls[1]?.headers.get('x-serverless-authorization')).toMatch(/^Bearer a\./);
  now += 61000;
  expect(await gate(context)).toEqual({ allow: true });
  expect(issued).toBe(2);
  vi.restoreAllMocks();
});
it('fails closed without calling policy when metadata cannot provide identity', async () => {
  const fetcher = vi.fn(async () => new Response('private provider error', { status: 500 }));
  vi.stubGlobal('fetch', fetcher);
  const gate = createHttpAdmissionGate({
    url: 'https://policy-test.run.app/admit',
    token: 'business-secret',
    googleAudience: 'https://policy-test.run.app',
  });
  expect(await gate(context)).toEqual({
    allow: false,
    reason: 'admission_unavailable',
    status: 403,
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('bounds the metadata and policy operation with one configured deadline', async () => {
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
  const gate = createHttpAdmissionGate({
    url: 'https://policy-test.run.app/admit',
    token: 'secret',
    googleAudience: 'https://policy-test.run.app',
    timeoutMs: 10000,
  });
  let settled = false;
  const pending = gate(context).finally(() => {
    settled = true;
  });
  await vi.advanceTimersByTimeAsync(2000);
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(7999);
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(await pending).toMatchObject({ allow: false, reason: 'admission_unavailable' });
});

it.each([
  { exp: 1, aud: 'https://policy-test.run.app' },
  { exp: 9999999999, aud: 'https://wrong.run.app' },
  {},
])('rejects expired or malformed identity claims', async (claims) => {
  const fetcher = vi.fn(
    async () =>
      new Response(`a.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`, {
        headers: { 'metadata-flavor': 'Google' },
      }),
  );
  vi.stubGlobal('fetch', fetcher);
  expect(
    await createHttpAdmissionGate({
      url: 'https://policy-test.run.app/admit',
      token: 'business-secret',
      googleAudience: 'https://policy-test.run.app',
    })(context),
  ).toMatchObject({ allow: false });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
