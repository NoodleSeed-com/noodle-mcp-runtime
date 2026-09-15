import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import type { PreparedPackagedAsset } from '@noodle-borg/compiler';
import { expect, it } from 'vitest';
import { GcsAssetStore } from '../src/gcs-store.js';

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
  'base64',
);
const SCOPE = { org: 'acme', app: 'site', env: 'prod' };
interface CapturedResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

function asset(): PreparedPackagedAsset {
  return {
    logicalId: 'logo',
    sourcePath: 'assets/logo.png',
    absolutePath: '/not-used/logo.png',
    contentHash: `sha256:${createHash('sha256').update(PNG_1X1).digest('hex')}`,
    mimeType: 'image/png',
    byteLength: PNG_1X1.byteLength,
    width: 1,
    height: 1,
  };
}

async function dispatch(
  store: GcsAssetStore,
  method: string,
  pathname: string,
  headers: Record<string, string> = {},
  chunks: readonly Buffer[] = [],
): Promise<{ handled: boolean; response: CapturedResponse }> {
  const req = Object.assign(Readable.from(chunks), { method, headers }) as IncomingMessage;
  let status = 200;
  const responseHeaders: Record<string, string> = {};
  let finish!: (response: CapturedResponse) => void;
  const response = new Promise<CapturedResponse>((resolve) => {
    finish = resolve;
  });
  const res = {
    set statusCode(value: number) {
      status = value;
    },
    get statusCode() {
      return status;
    },
    setHeader(name: string, value: string | number) {
      responseHeaders[name.toLowerCase()] = String(value);
    },
    writeHead(code: number, values?: Record<string, string | number>) {
      status = code;
      for (const [name, value] of Object.entries(values ?? {})) {
        responseHeaders[name.toLowerCase()] = String(value);
      }
      return this;
    },
    end(body?: Buffer | string) {
      finish({
        status,
        headers: responseHeaders,
        body: body === undefined ? Buffer.alloc(0) : Buffer.from(body),
      });
    },
  } as unknown as ServerResponse;
  const handled = store.handleRequest(req, res, pathname);
  if (!handled) finish({ status, headers: responseHeaders, body: Buffer.alloc(0) });
  return { handled, response: await response };
}

function fixture() {
  const objects = new Map<string, Buffer>();
  let now = Date.now();
  const transport = {
    async read(key: string, maxBytes: number) {
      const data = objects.get(key);
      if (data && data.length > maxBytes) throw new Error('limit');
      return data;
    },
    async create(key: string, bytes: Buffer) {
      if (objects.has(key)) return false;
      objects.set(key, Buffer.from(bytes));
      return true;
    },
  };
  const instance = () =>
    new GcsAssetStore({
      bucket: 'example-private-assets',
      keySalt: Buffer.alloc(32, 9).toString('base64url'),
      transport,
      now: () => now,
    });
  return {
    objects,
    instance,
    advance: () => {
      now += 600001;
    },
  };
}
const input = () => ({
  scope: SCOPE,
  assets: [asset()],
  uploadBaseUrl: 'https://runtime.example',
  publicBaseUrl: 'https://runtime.example',
});
it('accepts upload on a separate instance and recovers verified bytes and reachability after replacement', async () => {
  const f = fixture();
  const plan = await f.instance().planUploads(input());
  const upload = requiredItem(plan.uploads[0]);
  expect(
    (
      await dispatch(
        f.instance(),
        'PUT',
        new URL(upload.uploadUrl).pathname,
        { ...upload.headers },
        [PNG_1X1],
      )
    ).response.status,
  ).toBe(201);
  expect(await f.instance().verifyUploadedAssets({ scope: SCOPE, assets: plan.assets })).toEqual({
    ok: true,
    assets: plan.assets,
  });
  const publicRead = await dispatch(
    f.instance(),
    'GET',
    new URL(requiredItem(plan.assets[0]).publicUrl).pathname,
  );
  expect(publicRead.response.body).toEqual(PNG_1X1);
  expect(publicRead.response.headers['content-type']).toBe('image/png');
  expect(publicRead.response.headers['cache-control']).toContain('immutable');
  await f.instance().recordReachability({
    scope: SCOPE,
    assets: plan.assets,
    deploymentId: 'one',
    deploymentVersion: 1,
  });
  expect([...f.objects.keys()].some((key) => key.startsWith('reachability/'))).toBe(true);
  expect((await f.instance().planUploads(input())).uploads).toHaveLength(0);
});
it('rejects corrupt bytes, expired or tampered capability, wrong scope and malformed persisted metadata', async () => {
  const f = fixture();
  const plan = await f.instance().planUploads(input());
  const upload = requiredItem(plan.uploads[0]);
  const path = new URL(upload.uploadUrl).pathname;
  expect(
    (
      await dispatch(f.instance(), 'PUT', path, { ...upload.headers }, [
        Buffer.alloc(PNG_1X1.length),
      ])
    ).response.status,
  ).toBe(400);
  expect(f.objects.size).toBe(0);
  expect(
    (await dispatch(f.instance(), 'PUT', `${path}x`, { ...upload.headers }, [PNG_1X1])).response
      .status,
  ).toBe(404);
  expect(
    (await dispatch(f.instance(), 'PUT', path, { ...upload.headers }, [PNG_1X1])).response.status,
  ).toBe(201);
  expect(
    await f
      .instance()
      .verifyUploadedAssets({ scope: { ...SCOPE, org: 'other' }, assets: plan.assets }),
  ).toMatchObject({ ok: false });
  f.objects.set(`objects/${requiredItem(plan.assets[0]).objectKey}`, Buffer.from('invalid'));
  expect(
    await f.instance().verifyUploadedAssets({ scope: SCOPE, assets: plan.assets }),
  ).toMatchObject({ ok: false });
  expect(
    (await dispatch(f.instance(), 'GET', new URL(requiredItem(plan.assets[0]).publicUrl).pathname))
      .response.status,
  ).toBe(404);
  f.advance();
  expect(
    (await dispatch(f.instance(), 'PUT', path, { ...upload.headers }, [PNG_1X1])).response.status,
  ).toBe(410);
});
it('allows only one immutable create across racing instances and refuses replay overwrite', async () => {
  const f = fixture();
  const plan = await f.instance().planUploads(input());
  const upload = requiredItem(plan.uploads[0]);
  const request = () =>
    dispatch(f.instance(), 'PUT', new URL(upload.uploadUrl).pathname, { ...upload.headers }, [
      PNG_1X1,
    ]);
  const responses = await Promise.all([request(), request()]);
  expect(responses.map((r) => r.response.status).sort()).toEqual([201, 409]);
  expect((await request()).response.status).toBe(409);
  expect((await f.instance().verifyUploadedAssets({ scope: SCOPE, assets: plan.assets })).ok).toBe(
    true,
  );
});

function requiredItem<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('missing fixture value');
  return value;
}
