import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { type HostedPackagedAsset, sniffImageBytes } from '@noodle-borg/compiler';
import { AssetPlanError, type AssetScope, type AssetStore } from '@noodle-borg/module';
import { deriveHostedAsset, sha256Hex } from './asset-key.js';
import { SAFE_FILESYSTEM_ASSET_OBJECT_KEY } from './filesystem-layout.js';
import {
  normalizeHttpBase,
  sameAssetIdentity,
  sendError,
  uploadHeaders,
  validateHostedIdentity,
  validatePreparedAsset,
} from './filesystem-store-support.js';
import { type GcsObjectTransport, GoogleCloudStorageTransport } from './gcs-transport.js';

const UPLOAD = '/__noodle/asset-uploads';
const PUBLIC = '/__noodle/hosted-assets';
const MAX_METADATA = 16384;
const MAX_FILE = 10 * 1024 * 1024;
const MAX_DEPLOY = 50 * 1024 * 1024;
interface Capability {
  version: 1;
  scope: AssetScope;
  asset: HostedPackagedAsset;
  expiresAt: number;
}
export interface GcsAssetStoreConfig {
  readonly bucket: string;
  readonly keySalt: string;
  /** Trusted transport injection for hermetic tests; production uses the official GCS JSON API. */
  readonly transport?: GcsObjectTransport;
  readonly now?: () => number;
}
/** Immutable validated envelopes; upload capabilities and reads survive independent instance replacement. */
export class GcsAssetStore implements AssetStore {
  readonly #transport: GcsObjectTransport;
  readonly #salt: string;
  readonly #now: () => number;
  constructor(config: GcsAssetStoreConfig) {
    if (
      !/^[A-Za-z0-9_-]{43}$/.test(config.keySalt) ||
      Buffer.from(config.keySalt, 'base64url').toString('base64url') !== config.keySalt
    )
      throw new TypeError('asset identity salt must encode 32 bytes');
    this.#transport = config.transport ?? new GoogleCloudStorageTransport(config.bucket);
    this.#salt = config.keySalt;
    this.#now = config.now ?? Date.now;
  }
  async planUploads(
    input: Parameters<AssetStore['planUploads']>[0],
  ): ReturnType<AssetStore['planUploads']> {
    validateScope(input.scope);
    if (input.assets.length > 100) throw new AssetPlanError('too many packaged assets');
    let total = 0;
    for (const asset of input.assets) {
      validatePreparedAsset(asset);
      if (asset.byteLength > MAX_FILE)
        throw new AssetPlanError('asset exceeds per-file byte limit');
      total += asset.byteLength;
    }
    if (total > MAX_DEPLOY) throw new AssetPlanError('assets exceed per-deploy byte limit');
    const publicBase = `${normalizeHttpBase(input.publicBaseUrl)}${PUBLIC}`;
    const uploadBase = normalizeHttpBase(input.uploadBaseUrl);
    const assets = input.assets.map((asset) =>
      deriveHostedAsset(this.#salt, input.scope, asset, publicBase),
    );
    const uploads = [];
    for (const asset of assets) {
      const existing = await this.#load(asset.objectKey);
      if (existing !== undefined) {
        if (!sameAssetIdentity(existing.asset, asset))
          throw new AssetPlanError('immutable asset identity conflict');
        continue;
      }
      const expiresAt = (input.now?.getTime() ?? this.#now()) + 600000;
      const token = this.#sign({ version: 1, scope: input.scope, asset, expiresAt });
      uploads.push({
        logicalId: asset.logicalId,
        objectKey: asset.objectKey,
        uploadUrl: `${uploadBase}${UPLOAD}/${token}`,
        method: 'PUT' as const,
        headers: uploadHeaders(asset),
        expiresAt: new Date(expiresAt).toISOString(),
      });
    }
    return { assetOrigin: new URL(publicBase).origin, assets, uploads };
  }
  async verifyUploadedAssets(
    input: Parameters<AssetStore['verifyUploadedAssets']>[0],
  ): ReturnType<AssetStore['verifyUploadedAssets']> {
    try {
      validateScope(input.scope);
      if (
        input.assets.length > 100 ||
        input.assets.reduce((sum, asset) => sum + asset.byteLength, 0) > MAX_DEPLOY
      )
        throw new Error('asset limit');
      const assets: HostedPackagedAsset[] = [];
      for (const claimed of input.assets) {
        validateHostedIdentity(claimed);
        const canonical = deriveHostedAsset(
          this.#salt,
          input.scope,
          claimed,
          'https://assets.invalid',
        );
        if (canonical.objectKey !== claimed.objectKey) throw new Error('asset scope mismatch');
        const stored = await this.#load(canonical.objectKey);
        if (stored === undefined || !sameAssetIdentity(stored.asset, claimed))
          throw new Error('asset unavailable');
        assets.push(stored.asset);
      }
      return { ok: true, assets };
    } catch {
      return { ok: false, error: 'packaged asset integrity or scope verification failed' };
    }
  }
  async recordReachability(
    input: Parameters<NonNullable<AssetStore['recordReachability']>>[0],
  ): Promise<void> {
    validateScope(input.scope);
    if (
      !input.deploymentId ||
      input.deploymentId.length > 256 ||
      !Number.isSafeInteger(input.deploymentVersion) ||
      input.deploymentVersion < 0
    )
      throw new TypeError('invalid deployment reachability');
    const checked = await this.verifyUploadedAssets(input);
    if (!checked.ok) throw new Error(checked.error);
    for (const asset of checked.assets) {
      const record = Buffer.from(
        JSON.stringify({
          version: 1,
          objectKey: asset.objectKey,
          deploymentId: input.deploymentId,
          deploymentVersion: input.deploymentVersion,
        }),
      );
      const key = createHmac('sha256', this.#salt)
        .update('reachability\0')
        .update(record)
        .digest('hex');
      await this.#transport.create(`reachability/${key}`, record);
    }
  }
  handleRequest(req: IncomingMessage, res: ServerResponse, pathname: string): boolean {
    if (pathname === UPLOAD || pathname.startsWith(`${UPLOAD}/`)) {
      if (req.method !== 'PUT') {
        sendError(res, 405, 'method not allowed', { allow: 'PUT' });
        return true;
      }
      void this.#upload(pathname.slice(UPLOAD.length + 1), req, res);
      return true;
    }
    if (pathname === PUBLIC || pathname.startsWith(`${PUBLIC}/`)) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendError(res, 405, 'method not allowed', { allow: 'GET, HEAD' });
        return true;
      }
      void this.#serve(pathname.slice(PUBLIC.length + 1), req, res);
      return true;
    }
    return false;
  }
  #sign(capability: Capability): string {
    const payload = Buffer.from(JSON.stringify(capability)).toString('base64url');
    const signature = createHmac('sha256', this.#salt)
      .update('gcs-upload-v1\0')
      .update(payload)
      .digest('base64url');
    return `${payload}.${signature}`;
  }
  #verify(token: string): Capability {
    if (token.length > MAX_METADATA * 2 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token))
      throw new Error('invalid capability');
    const [payload, signature] = token.split('.') as [string, string];
    const expected = createHmac('sha256', this.#salt)
      .update('gcs-upload-v1\0')
      .update(payload)
      .digest();
    const supplied = Buffer.from(signature, 'base64url');
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
      throw new Error('invalid capability');
    const value: Capability = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (value.version !== 1 || !Number.isSafeInteger(value.expiresAt))
      throw new Error('invalid capability');
    validateScope(value.scope);
    validateHostedIdentity(value.asset);
    if (
      deriveHostedAsset(this.#salt, value.scope, value.asset, 'https://assets.invalid')
        .objectKey !== value.asset.objectKey ||
      value.asset.byteLength > MAX_FILE
    )
      throw new Error('invalid capability');
    return value;
  }
  async #upload(token: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    let capability: Capability;
    try {
      capability = this.#verify(token);
    } catch {
      sendError(res, 404, 'not found');
      return;
    }
    if (capability.expiresAt <= this.#now()) {
      sendError(res, 410, 'upload target expired');
      return;
    }
    for (const [name, value] of Object.entries(uploadHeaders(capability.asset))) {
      if (String(req.headers[name] ?? '') !== value) {
        sendError(res, 400, 'upload header mismatch');
        return;
      }
    }
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for await (const chunk of req) {
        const bytes = Buffer.from(chunk);
        size += bytes.length;
        if (size > capability.asset.byteLength || size > MAX_FILE) {
          sendError(res, 413, 'asset upload too large');
          return;
        }
        chunks.push(bytes);
      }
      const bytes = Buffer.concat(chunks, size);
      assertBytes(capability.asset, bytes);
      if (capability.expiresAt <= this.#now()) {
        sendError(res, 410, 'upload target expired');
        return;
      }
      const metadata = Buffer.from(JSON.stringify(capability.asset));
      if (metadata.length > MAX_METADATA) throw new Error('metadata limit');
      const length = Buffer.alloc(4);
      length.writeUInt32BE(metadata.length);
      const created = await this.#transport.create(
        `objects/${capability.asset.objectKey}`,
        Buffer.concat([length, metadata, bytes]),
      );
      if (!created) {
        sendError(res, 409, 'immutable asset already exists');
        return;
      }
      res.writeHead(201, { etag: `"${sha256Hex(capability.asset.contentHash)}"` });
      res.end();
    } catch {
      sendError(res, 400, 'asset upload failed validation or storage');
    }
  }
  async #load(key: string): Promise<{ asset: HostedPackagedAsset; bytes: Buffer } | undefined> {
    if (!SAFE_FILESYSTEM_ASSET_OBJECT_KEY.test(key)) throw new Error('invalid object key');
    const envelope = await this.#transport.read(`objects/${key}`, MAX_FILE + MAX_METADATA + 4);
    if (envelope === undefined) return undefined;
    if (envelope.length < 4) throw new Error('invalid object envelope');
    const length = envelope.readUInt32BE();
    if (length < 1 || length > MAX_METADATA || length + 4 >= envelope.length)
      throw new Error('invalid object envelope');
    const asset: HostedPackagedAsset = JSON.parse(
      envelope.subarray(4, 4 + length).toString('utf8'),
    );
    validateHostedIdentity(asset);
    if (asset.objectKey !== key || asset.byteLength > MAX_FILE)
      throw new Error('invalid asset metadata');
    const bytes = envelope.subarray(4 + length);
    assertBytes(asset, bytes);
    return { asset, bytes };
  }
  async #serve(key: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (req.headers.range !== undefined) {
        sendError(res, 416, 'ranges unsupported');
        return;
      }
      const stored = await this.#load(key);
      if (stored === undefined) {
        sendError(res, 404, 'not found');
        return;
      }
      res.writeHead(200, {
        'content-type': stored.asset.mimeType,
        'content-length': String(stored.bytes.length),
        'cache-control': 'public, max-age=31536000, immutable',
        'x-content-type-options': 'nosniff',
        etag: `"${sha256Hex(stored.asset.contentHash)}"`,
      });
      res.end(req.method === 'HEAD' ? undefined : stored.bytes);
    } catch {
      sendError(res, 404, 'not found');
    }
  }
}
function validateScope(scope: AssetScope): void {
  if (
    typeof scope !== 'object' ||
    scope === null ||
    [scope.org, scope.app, scope.env].some(
      (value) => typeof value !== 'string' || value.length < 1 || value.length > 256,
    )
  )
    throw new AssetPlanError('invalid asset scope');
}
function assertBytes(asset: HostedPackagedAsset, bytes: Buffer): void {
  if (
    bytes.length !== asset.byteLength ||
    createHash('sha256').update(bytes).digest('hex') !== sha256Hex(asset.contentHash)
  )
    throw new Error('asset integrity mismatch');
  const image = sniffImageBytes(bytes);
  if (
    image === undefined ||
    image.mimeType !== asset.mimeType ||
    image.width !== asset.width ||
    image.height !== asset.height
  )
    throw new Error('asset image metadata mismatch');
}
