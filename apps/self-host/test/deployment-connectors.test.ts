import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { buildMcpServer } from '@noodle-borg/protocol';
import { InMemoryArtifactStore, ServerRegistry } from '@noodle-borg/service';
import { afterEach, expect, it, vi } from 'vitest';
import { createHttpActionConnectors } from '../src/http-actions.js';
import { actionManifest, config, receipt } from './http-actions.fixture.js';

const tenant = { org: 'acme', app: 'support', env: 'test' };
afterEach(() => vi.unstubAllGlobals());
async function setupDeployment() {
  const store = new InMemoryArtifactStore();
  const bridge = createHttpActionConnectors(config);
  const registry = new ServerRegistry(store, undefined, undefined, {
    deploymentConnectors: bridge,
  });
  const deployed = await registry.deploy(tenant, JSON.stringify(actionManifest), {
    accessMode: 'public',
  });
  expect(deployed).toMatchObject({ ok: true });
  if (!deployed.ok) throw new Error(JSON.stringify(deployed));
  return { store, registry, deployed, bridge };
}
it('survives native port rebinding and cold recovery with the persisted deployment identity', async () => {
  const { store, registry, deployed, bridge } = await setupDeployment();
  registry.setPlatformConnectors({});
  const recovered = new ServerRegistry(store, undefined, undefined, {
    deploymentConnectors: bridge,
  });
  expect(await recovered.recover()).toMatchObject({ recovered: 1, failed: [] });
  const fetcher = vi.fn(async () => Response.json(receipt));
  vi.stubGlobal('fetch', fetcher);
  for (const host of [registry, recovered]) {
    const target = await host.getServing(deployed.deploymentId);
    expect(target).toBeDefined();
    const connector = target?.served.deps.connectors.resolve({
      connectorId: 'operator_actions',
      connectorVersion: '1.0.0',
    });
    expect(connector).toBeDefined();
    await connector?.invoke({
      operation: 'submit_contact_form',
      args: { values: { name: 'Visitor' } },
      credential: { token: '' },
      execution: { id: 'a'.repeat(64), toolName: 'submit_contact_form', entrypointKind: 'tool' },
    });
  }
  for (const args of fetcher.mock.calls)
    expect(JSON.parse(String((args as unknown as [string, RequestInit])[1].body)).target).toEqual({
      org: 'acme',
      app: 'support',
      environment: 'test',
      deploymentId: deployed.deploymentId,
    });
});
it('sends no payload before real MCP confirmation and returns only the receipt after acceptance', async () => {
  const { registry, deployed } = await setupDeployment();
  const target = await registry.getServing(deployed.deploymentId);
  if (!target) throw new Error('missing target');
  const fetcher = vi.fn(async () => Response.json(receipt));
  vi.stubGlobal('fetch', fetcher);
  const server = buildMcpServer(target.served);
  const client = new Client(
    { name: 'contact-test', version: '1.0.0' },
    { capabilities: { elicitation: { form: {} } } },
  );
  let accept = false;
  client.setRequestHandler(ElicitRequestSchema, () => {
    expect(fetcher).not.toHaveBeenCalled();
    return accept ? { action: 'accept', content: { confirm: true } } : { action: 'decline' };
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  try {
    const declined = await client.callTool({
      name: 'submit_contact_form',
      arguments: { values: { name: 'Visitor' } },
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(JSON.stringify(declined)).not.toContain(receipt.submissionId);
    accept = true;
    const result = await client.callTool({
      name: 'submit_contact_form',
      arguments: { values: { name: 'Visitor' } },
    });
    expect(result).toMatchObject({ structuredContent: receipt });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const body = JSON.parse(
      String((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].body),
    );
    expect(body.executionId).toMatch(/^[a-f0-9]{64}$/);
    expect(body.tool).toBe('submit_contact_form');
  } finally {
    await client.close();
    await server.close();
  }
});
