import { compileManifest, InMemoryCatalog } from '@noodle-borg/compiler';
import type { ConnectorCall } from '@noodle-borg/runtime';
import { ACTION_CATALOG, createHttpActionConnectors } from '../src/http-actions.js';
export const valuesSchema = {
  type: 'object',
  properties: { name: { type: 'string', maxLength: 100 } },
  required: ['name'],
  additionalProperties: false,
};
export const actionManifest = {
  manifestVersion: '1',
  server: {
    name: 'contact',
    title: 'Contact',
    version: '1.0.0',
    interactions: { confirmationFallback: 'host' },
  },
  connectors: { actions: { id: 'operator_actions', version: '1.0.0' } },
  tools: [
    {
      name: 'submit_contact_form',
      description: 'Send contact details',
      annotations: { confirm: true, readOnlyHint: false },
      inputSchema: {
        type: 'object',
        properties: { values: valuesSchema },
        required: ['values'],
        additionalProperties: false,
      },
      fulfilment: { use: 'actions.submit_contact_form', args: { values: '${input.values}' } },
    },
  ],
};
export const receipt = {
  submissionId: 'ec5e845f-c5c0-4daf-8849-efcd1c156850',
  receivedAt: '2026-09-18T00:00:00.000Z',
  environment: 'test',
};
export const config = {
  url: 'http://127.0.0.1:9082/internal/runtime/contact-submissions',
  token: 'operator-secret',
  localOrigin: 'http://127.0.0.1:9082',
  runtimeInstanceId: 'runtime-one',
};
export function setup() {
  const compiled = compileManifest(actionManifest, {
    catalog: new InMemoryCatalog([ACTION_CATALOG]),
  });
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.errors));
  const bridge = createHttpActionConnectors(config);
  const connector = bridge.create({
    tenant: { org: 'acme', app: 'support', env: 'test' },
    deploymentId: 'dep-one',
    artifact: compiled.artifact,
  })[0];
  if (!connector) throw new Error('missing connector');
  const call: ConnectorCall = {
    operation: 'submit_contact_form',
    args: { values: { name: 'Visitor' } },
    credential: { token: '' },
    execution: { id: 'a'.repeat(64), toolName: 'submit_contact_form', entrypointKind: 'tool' },
  };
  return { connector, call, compiled, bridge };
}
