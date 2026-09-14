import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { compileLocalInput } from '../../../packages/cli/dist/local-compile.js';
import {
  executeResource,
  executeTool,
  InMemoryConnectorRegistry,
  StaticServiceBroker,
} from '../../../packages/runtime/dist/index.js';

const repository = fileURLToPath(new URL('../../../', import.meta.url));
const entrypoint = fileURLToPath(new URL('../src/server.ts', import.meta.url));

async function compiled() {
  const result = await compileLocalInput({ manifestPath: entrypoint });
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.compiled;
}

function dependencies() {
  return {
    connectors: new InMemoryConnectorRegistry([]),
    broker: new StaticServiceBroker({ kind: 'none' }),
    caller: { subject: 'synthetic-reader', scopes: ['proof:read'] },
  };
}

test('the checked-out CLI validates the proof and discovers its packaged image', () => {
  const result = spawnSync(
    process.execPath,
    ['packages/cli/dist/bin.js', 'validate', entrypoint, '--json'],
    { cwd: repository, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true);
  assert.ok(result.stdout.includes('assets/proof-pixel.png'));
});

test('greet returns a synthetic greeting with no connector or model dependency', async () => {
  const { artifact } = await compiled();
  const result = await executeTool(artifact, 'greet', { name: 'Ada' }, dependencies());
  assert.deepEqual(result, {
    ok: true,
    output: { message: 'Hello, Ada!', fixture: 'Synthetic deployment proof; no external service.' },
  });
  const greet = artifact.tools.find((tool) => tool.name === 'greet');
  assert.deepEqual(greet.authorization, { requiredScopes: ['proof:read'] });
  assert.equal(greet.annotations.readOnlyHint, true);
  assert.equal(greet.inputSchema.properties.name.default, 'world');
  assert.ok(!(greet.inputSchema.required ?? []).includes('name'));
});

test('the linked MCP App resource contains an independently fetchable packaged asset URL', async () => {
  const result = await compiled();
  const { artifact } = result;
  const greet = artifact.tools.find((tool) => tool.name === 'greet');
  assert.equal(greet._meta.ui.resourceUri, 'ui://runtime_proof/card');
  assert.equal(greet._meta['openai/outputTemplate'], 'ui://runtime_proof/card');
  const card = artifact.resources.find((resource) => resource.uri === 'ui://runtime_proof/card');
  assert.equal(card.mimeType, 'text/html;profile=mcp-app');
  const rendered = await executeResource(artifact, card.name, {}, dependencies());
  assert.equal(rendered.ok, true);
  assert.match(rendered.output.value, /Synthetic deployment proof/);
  assert.equal(result.localAssets.length, 1);
  const asset = result.localAssets[0];
  assert.equal(asset.sourcePath, 'assets/proof-pixel.png');
  assert.equal(asset.mimeType, 'image/png');
  assert.match(asset.publicUrl, /^http:\/\/127\.0\.0\.1\/__noodle\/assets\//);
  assert.ok(rendered.output.value.includes(asset.publicUrl));
  const bytes = await readFile(asset.absolutePath);
  assert.equal(bytes.length, 68);
  assert.equal(bytes.subarray(1, 4).toString(), 'PNG');
});

test('the assistant enables only the authenticated local origin with placeholder model bindings', async () => {
  const { artifact } = await compiled();
  assert.deepEqual(artifact.server.assistant.allowedOrigins, ['http://127.0.0.1:9080']);
  assert.deepEqual(artifact.server.assistant.surfaces, [
    { mode: 'authenticated', origins: ['http://127.0.0.1:9080'] },
  ]);
  assert.deepEqual(artifact.server.assistant.model, {
    kind: 'openai-compatible',
    baseUrl: '${env.PROOF_MODEL_BASE_URL}',
    model: '${env.PROOF_MODEL}',
    apiKey: 'PROOF_MODEL_API_KEY',
  });
});
