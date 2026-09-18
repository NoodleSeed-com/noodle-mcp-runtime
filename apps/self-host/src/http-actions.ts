import { createHash } from 'node:crypto';
import {
  type CatalogConnector,
  type OperationSignature,
  requiresToolConfirmation,
  validateJsonSchema,
} from '@noodle-borg/compiler';
import { type ConnectorCall, ConnectorInvocationError } from '@noodle-borg/runtime';
import type { DeploymentConnectors } from '@noodle-borg/service';
import { createOperatorJsonPost, type OperatorHttpConfig } from './operator-http.js';

export interface HttpActionConfig extends OperatorHttpConfig {
  readonly runtimeInstanceId: string;
  readonly localOrigin?: string;
  readonly timeoutMs?: number;
}
const TOOL = 'submit_contact_form';
const signature: OperationSignature = {
  type: 'action',
  input: {
    type: 'object',
    properties: { values: { type: 'object', additionalProperties: true } },
    required: ['values'],
    additionalProperties: false,
  },
  output: {
    type: 'object',
    properties: {
      submissionId: { type: 'string' },
      receivedAt: { type: 'string' },
      environment: { type: 'string', enum: ['test', 'live'] },
    },
    required: ['submissionId', 'receivedAt', 'environment'],
    additionalProperties: false,
  },
};
export const ACTION_CATALOG: CatalogConnector = {
  id: 'operator_actions',
  version: '1.0.0',
  kind: 'builtin',
  operations: { [TOOL]: signature },
};

/** Only the operator can enable this adapter or choose its destination and credentials. */
export function createHttpActionConnectors(config: HttpActionConfig): DeploymentConnectors {
  validateActionConfig(config);
  const post = createOperatorJsonPost(config);
  return {
    catalog: [ACTION_CATALOG],
    create: (input) => {
      if (input.deploymentId === undefined) return [];
      const tool = input.artifact.tools.find((entry) => entry.name === TOOL);
      if (tool === undefined) return [];
      if (!requiresToolConfirmation(tool.annotations))
        throw new Error('Operator actions require confirmation');
      const properties = tool.inputSchema.properties;
      const schema = isObject(properties) ? properties.values : undefined;
      if (
        !isObject(schema) ||
        schema.type !== 'object' ||
        !isObject(properties) ||
        Object.keys(properties).length !== 1 ||
        tool.inputSchema.additionalProperties !== false
      )
        throw new Error('Operator action input must contain only values');
      const schemaDigest = `sha256:${createHash('sha256').update(canonical(schema)).digest('hex')}`;
      const environment = input.tenant.env;
      if (environment !== 'test' && environment !== 'live')
        throw new Error('Operator actions require test or live environment');
      const target = {
        org: input.tenant.org,
        app: input.tenant.app,
        environment,
        deploymentId: input.deploymentId,
      };
      return [
        {
          id: ACTION_CATALOG.id,
          version: ACTION_CATALOG.version,
          signature: (operation) => (operation === TOOL ? signature : undefined),
          executionBoundMs: () => config.timeoutMs ?? 10000,
          invoke: async (call: ConnectorCall): Promise<unknown> => {
            if (
              call.operation !== TOOL ||
              !/^[a-f0-9]{64}$/.test(call.execution?.id ?? '') ||
              call.execution?.entrypointKind !== 'tool' ||
              call.execution?.toolName !== TOOL
            )
              return fail(call, 'Trusted action execution required');
            if (
              validateJsonSchema(signature.input, call.args).length ||
              validateJsonSchema(tool.inputSchema, call.args).length ||
              !isObject(call.args.values) ||
              Object.values(call.args.values).some(
                (value) =>
                  !['string', 'number', 'boolean'].includes(typeof value) ||
                  (typeof value === 'number' && !Number.isFinite(value)),
              )
            )
              return fail(call, 'Invalid action values');
            if (call.signal?.aborted) return fail(call, 'Action cancelled before dispatch');
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), config.timeoutMs ?? 10000);
            const signal =
              call.signal === undefined
                ? controller.signal
                : AbortSignal.any([controller.signal, call.signal]);
            try {
              const response = await post(
                {
                  version: 1,
                  runtimeInstanceId: config.runtimeInstanceId,
                  executionId: call.execution.id,
                  target,
                  tool: TOOL,
                  schemaDigest,
                  values: call.args.values,
                },
                signal,
              );
              if (!response.ok) {
                if ([400, 403, 409, 422, 429].includes(response.status)) {
                  call.reportOutcome?.({ outcome: 'rejected' });
                  const message =
                    response.status === 409
                      ? 'The contact form changed or this execution conflicts with its previous submission. Reopen the form before continuing.'
                      : response.status === 400 || response.status === 422
                        ? 'The contact details did not match the current form. Review the fields before trying again.'
                        : response.status === 429
                          ? 'Contact submission limit reached. Try again later.'
                          : 'Contact submission is not currently permitted.';
                  throw new ConnectorInvocationError(message, {
                    status: response.status,
                    retryable: false,
                  });
                }
                throw new Error('unavailable');
              }
              if (response.body === null) throw new Error('unavailable');
              let size = 0;
              const chunks: Uint8Array[] = [];
              for await (const chunk of response.body) {
                size += chunk.byteLength;
                if (size > 16384) throw new Error('oversized');
                chunks.push(chunk);
              }
              const receipt: unknown = JSON.parse(
                new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size)),
              );
              if (
                !isObject(receipt) ||
                validateJsonSchema(signature.output, receipt).length ||
                typeof receipt.submissionId !== 'string' ||
                !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
                  receipt.submissionId,
                ) ||
                typeof receipt.receivedAt !== 'string' ||
                !/^\d{4}-\d{2}-\d{2}T/.test(receipt.receivedAt) ||
                !Number.isFinite(Date.parse(receipt.receivedAt)) ||
                receipt.environment !== environment
              )
                throw new Error('invalid receipt');
              call.reportOutcome?.({ outcome: 'completed', reference: receipt.submissionId });
              return receipt;
            } catch (error) {
              if (error instanceof ConnectorInvocationError) throw error;
              // A lost reply can follow a committed write. Do not classify an ambiguous transport failure as rejection.
              throw new ConnectorInvocationError(
                'Action submission unavailable; do not start a new submission until its status is resolved.',
                { status: 503, retryable: false },
              );
            } finally {
              clearTimeout(timeout);
              controller.abort();
            }
          },
        },
      ];
    },
  };
}
function fail(call: ConnectorCall, message: string): never {
  call.reportOutcome?.({ outcome: 'rejected' });
  throw new ConnectorInvocationError(message, { status: 400, retryable: false });
}
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isObject(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
export function validateActionConfig(config: HttpActionConfig): void {
  const url = new URL(config.url);
  if (
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    !config.token ||
    /\s/.test(config.token) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(config.runtimeInstanceId)
  )
    throw new Error('Invalid operator action configuration');
  if (config.googleAudience !== undefined) {
    if (config.localOrigin !== undefined)
      throw new Error('Choose one action transport authentication mode');
    // Validate even when no deployment uses the bridge.
    createOperatorJsonPost(config);
  } else if (
    url.protocol !== 'http:' ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    config.localOrigin !== url.origin
  ) {
    throw new Error('Actions require Google Cloud Run identity or an explicit local HTTP origin');
  }
  const timeout = config.timeoutMs ?? 10000;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 10000)
    throw new Error('Action timeout must be 1 through 10000');
}
