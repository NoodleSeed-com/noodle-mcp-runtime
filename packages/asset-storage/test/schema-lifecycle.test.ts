import { createHash } from 'node:crypto';
import { assetReference } from '@noodle-borg/compiler';
import { migratePostgresSchema, serveService } from '@noodle-borg/service';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GcsAssetStore } from '../src/gcs-store.js';

const databaseUrl = process.env.RUNTIME_SCHEMA_TEST_DATABASE_URL;
const key = Buffer.alloc(32, 7).toString('base64');
describe.skipIf(!databaseUrl)('isolated external schema lifecycle', () => {
  let admin: Pool;
  let migratorUrl: string;
  let applicationUrl: string;
  beforeAll(async () => {
    const url = new URL(databaseUrl ?? '');
    if (
      url.pathname !== '/runtime_hosted_test' ||
      !['localhost', '127.0.0.1'].includes(url.hostname)
    )
      throw new Error('requires isolated local runtime_hosted_test');
    admin = new Pool({ connectionString: url.toString() });
    await admin.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
    await admin.query('REVOKE TEMP ON DATABASE runtime_hosted_test FROM PUBLIC');
    await admin.query('GRANT USAGE ON SCHEMA public TO runtime_hosted_app');
    await admin.query(
      'ALTER DEFAULT PRIVILEGES FOR ROLE runtime_hosted_migrator IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO runtime_hosted_app',
    );
    await admin.query(
      'ALTER DEFAULT PRIVILEGES FOR ROLE runtime_hosted_migrator IN SCHEMA public GRANT USAGE ON SEQUENCES TO runtime_hosted_app',
    );
    url.username = 'runtime_hosted_migrator';
    url.password = 'runtime_hosted_migrator-local-test-only';
    migratorUrl = url.toString();
    url.username = 'runtime_hosted_app';
    url.password = 'runtime_hosted_app-local-test-only';
    applicationUrl = url.toString();
    if (
      (await admin.query("SELECT to_regclass('public.noodle_schema_contract') AS ledger")).rows[0]
        .ledger !== null
    )
      await admin.query('DELETE FROM public.noodle_schema_contract');
  });
  afterAll(async () => {
    await admin?.end();
  });
  it('migrates once under concurrent starts and skips the exact repeated plan', async () => {
    const options = { databaseUrl: migratorUrl };
    const results = await Promise.all([
      migratePostgresSchema(options),
      migratePostgresSchema(options),
    ]);
    expect(results.filter((result) => result.applied)).toHaveLength(1);
    expect(await migratePostgresSchema(options)).toEqual({ applied: false, generation: 1 });
    await admin.query(
      'REVOKE INSERT, UPDATE, DELETE ON public.noodle_schema_contract FROM runtime_hosted_app',
    );
  }, 60000);
  it('starts two DML-only instances and a replacement without schema permissions', async () => {
    const app = new Pool({ connectionString: applicationUrl });
    try {
      await expect(app.query('CREATE TABLE public.must_not_exist(id integer)')).rejects.toThrow();
      await expect(
        app.query('UPDATE public.noodle_schema_contract SET generation=99'),
      ).rejects.toThrow();
      await app.query("INSERT INTO orgs(slug) VALUES('schema-test-org') ON CONFLICT DO NOTHING");
      const options = {
        databaseUrl: applicationUrl,
        secretMasterKey: key,
        schemaMode: 'external' as const,
        port: 0,
        warmAll: false,
      };
      const first = await serveService(options);
      const second = await serveService(options);
      try {
        expect((await fetch(`${first.url}/readyz`)).status).toBe(200);
        expect((await fetch(`${second.url}/readyz`)).status).toBe(200);
      } finally {
        await first.close();
        await second.close();
      }
      const replacement = await serveService(options);
      try {
        expect((await fetch(`${replacement.url}/readyz`)).status).toBe(200);
      } finally {
        await replacement.close();
      }
    } finally {
      await app.end();
    }
  }, 30000);
  it('recovers a persisted deployment, generated widget and asset bytes on independent DML-only instances', async () => {
    const objects = new Map<string, Buffer>();
    const transport = {
      async read(name: string, limit: number) {
        const value = objects.get(name);
        if (value && value.length > limit) throw new Error('limit');
        return value;
      },
      async create(name: string, bytes: Buffer) {
        if (objects.has(name)) return false;
        objects.set(name, Buffer.from(bytes));
        return true;
      },
    };
    const create = () =>
      serveService({
        databaseUrl: applicationUrl,
        secretMasterKey: key,
        schemaMode: 'external',
        port: 0,
        warmAll: false,
        mcpProtocolMode: 'dual',
        assetStore: new GcsAssetStore({
          bucket: 'test-private-assets',
          keySalt: Buffer.alloc(32, 9).toString('base64url'),
          transport,
        }),
        assetPublicBaseUrl: 'https://assets.example.test',
        deployGate: {
          authorize: async () => ({
            ok: true,
            identity: { subject: 'test-owner', superAdmin: true },
          }),
        },
        verifyOwnerToken: async () => ({ caller: { subject: 'test-owner' } }),
        authServerIssuer: 'https://identity.example.test',
      });
    const a = await create();
    const b = await create();
    const image = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
      'base64',
    );
    const ref = assetReference('./assets/logo.png');
    const asset = {
      logicalId: ref.logicalId,
      sourcePath: 'assets/logo.png',
      contentHash: `sha256:${createHash('sha256').update(image).digest('hex')}`,
      mimeType: 'image/png',
      byteLength: image.length,
      width: 1,
      height: 1,
    };
    let publicPath = '';
    try {
      const preflight = await fetch(
        `${a.url}/v1/orgs/schema-test-org/apps/cloud-proof/envs/prod/assets/preflight`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ assets: [asset] }),
        },
      );
      expect(preflight.status).toBe(200);
      const plan = await preflight.json();
      const upload = plan.uploads[0];
      expect(
        (
          await fetch(`${b.url}${new URL(upload.uploadUrl).pathname}`, {
            method: 'PUT',
            headers: upload.headers,
            body: image,
          })
        ).status,
      ).toBe(201);
      const manifest = {
        manifestVersion: '1',
        server: {
          name: 'cloud_proof',
          version: '1.0.0',
          title: 'Cloud Proof',
          branding: { logo: { uri: ref, alt: 'Logo' } },
        },
        tools: [
          {
            name: 'greet',
            description: 'Say hello.',
            inputSchema: { type: 'object' },
            fulfilment: { steps: [], output: { message: 'hello' } },
          },
        ],
        widgets: [
          {
            name: 'greet_widget',
            tool: 'greet',
            view: { component: 'FixtureWidget', entry: './views/FixtureWidget.tsx' },
          },
        ],
      };
      const deployed = await fetch(
        `${a.url}/v1/orgs/schema-test-org/apps/cloud-proof/envs/prod/deploy`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ manifest: JSON.stringify(manifest), hostedAssets: plan.assets }),
        },
      );
      expect(deployed.status, JSON.stringify(await deployed.json())).toBe(201);
      publicPath = new URL(plan.assets[0].publicUrl).pathname;
      const rpc = async (base: string, method: string, params: unknown) => {
        const response = await fetch(`${base}/o/schema-test-org/cloud-proof/mcp`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            'mcp-protocol-version': '2025-11-25',
            authorization: 'Bearer local-test',
          },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        });
        const body = await response.json();
        expect(response.status, JSON.stringify(body)).toBe(200);
        return body;
      };
      expect(
        JSON.stringify(await rpc(b.url, 'tools/call', { name: 'greet', arguments: {} })),
      ).toContain('hello');
      const widget = await rpc(b.url, 'resources/read', { uri: 'ui://cloud_proof/greet_widget' });
      expect(widget.result.contents[0].text).toContain(plan.assets[0].publicUrl);
      expect(Buffer.from(await (await fetch(`${b.url}${publicPath}`)).arrayBuffer())).toEqual(
        image,
      );
    } finally {
      await a.close();
      await b.close();
    }
    const replacement = await create();
    try {
      const listed = await fetch(`${replacement.url}/o/schema-test-org/cloud-proof/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': '2025-11-25',
          authorization: 'Bearer local-test',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      });
      expect(JSON.stringify(await listed.json())).toContain('greet');
      expect(
        Buffer.from(await (await fetch(`${replacement.url}${publicPath}`)).arrayBuffer()),
      ).toEqual(image);
    } finally {
      await replacement.close();
    }
  }, 30000);
  it('rejects stale app markers and older migration plans', async () => {
    await admin.query('UPDATE public.noodle_schema_contract SET epoch=2');
    await expect(
      serveService({
        databaseUrl: applicationUrl,
        secretMasterKey: key,
        schemaMode: 'external',
        port: 0,
      }),
    ).rejects.toThrow('incompatible');
    await admin.query('UPDATE public.noodle_schema_contract SET epoch=1,generation=2');
    await expect(migratePostgresSchema({ databaseUrl: migratorUrl })).rejects.toThrow('older');
    await admin.query('UPDATE public.noodle_schema_contract SET generation=1');
  });
  it('rolls back a checked-out canonical transaction on advisory-lock loss and recovers', async () => {
    await admin.query('DELETE FROM public.noodle_schema_contract');
    await admin.query(`CREATE OR REPLACE FUNCTION reject_external_operation_resolution_change() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'migration-lock-loss-sentinel'; END
      $$ LANGUAGE plpgsql`);
    const blocker = await admin.connect();
    await blocker.query('BEGIN');
    await blocker.query(
      'LOCK TABLE external_operation_coordination_resolutions IN ACCESS EXCLUSIVE MODE',
    );
    const outcome = migratePostgresSchema({ databaseUrl: migratorUrl }).then(
      () => 'unexpected success',
      () => 'failed',
    );
    try {
      let workerPid: number | undefined;
      for (let attempt = 0; attempt < 1000 && workerPid === undefined; attempt++) {
        const rows = await admin.query(
          `SELECT pid FROM pg_stat_activity WHERE application_name='noodle-schema-migration'
           AND wait_event_type='Lock' AND query LIKE '%CREATE OR REPLACE FUNCTION reject_external_operation_resolution_change%'`,
        );
        workerPid = rows.rows[0]?.pid;
        if (workerPid === undefined) await new Promise<void>((resolve) => setImmediate(resolve));
      }
      if (workerPid === undefined)
        throw new Error('canonical transaction did not reach blocked trigger replacement');
      const locks = await admin.query(
        "SELECT pid FROM pg_locks WHERE locktype='advisory' AND classid=184728395 AND objid=1 AND granted",
      );
      const lockPid = locks.rows[0]?.pid;
      expect(lockPid).toBeTypeOf('number');
      expect(lockPid).not.toBe(workerPid);
      await admin.query('SELECT pg_terminate_backend($1)', [lockPid]);
      // Let the lock-loss event reach the runner before releasing the blocked transaction.
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
    }
    expect(await outcome).toBe('failed');
    const definition = await admin.query(
      "SELECT pg_get_functiondef('reject_external_operation_resolution_change()'::regprocedure) AS body",
    );
    // The canonical transaction changed this function before blocking on DROP TRIGGER.
    // Retaining the sentinel proves rollback rather than a later, unmarked COMMIT.
    expect(definition.rows[0].body).toContain('migration-lock-loss-sentinel');
    expect(
      (await admin.query('SELECT count(*)::int AS count FROM public.noodle_schema_contract'))
        .rows[0].count,
    ).toBe(0);
    expect((await migratePostgresSchema({ databaseUrl: migratorUrl })).applied).toBe(true);
    const recovered = await admin.query(
      "SELECT pg_get_functiondef('reject_external_operation_resolution_change()'::regprocedure) AS body",
    );
    expect(recovered.rows[0].body).toContain('operation coordination resolutions are append-only');
  }, 30000);
});
