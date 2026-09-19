import {
  type CatalogConnector,
  type OperationSignature,
  requiresToolConfirmation,
  validateJsonSchema,
} from '@noodle-borg/compiler';
import { type ConnectorCall, ConnectorInvocationError } from '@noodle-borg/runtime';
import type { DeploymentConnectors } from '@noodle-borg/service';
import { type HttpActionConfig, validateActionConfig } from './http-actions.js';
import { createOperatorJsonPost } from './operator-http.js';

const writes = new Set([
  'square_add_cart_item',
  'square_update_cart_item',
  'square_remove_cart_item',
  'square_prepare_checkout',
]);
const names = [
  'square_browse_menu',
  'square_get_menu_item',
  'square_get_cart',
  'square_add_cart_item',
  'square_update_cart_item',
  'square_remove_cart_item',
  'square_review_order',
  'square_prepare_checkout',
  'square_get_order_status',
] as const;
const operations: Record<string, OperationSignature> = Object.fromEntries(
  names.map((name) => [
    name,
    {
      type: writes.has(name) ? 'action' : 'read',
      input: {
        type: 'object',
        properties: { values: { type: 'object', additionalProperties: true } },
        required: ['values'],
        additionalProperties: false,
      },
      output: {
        type: 'object',
        properties: { data: { type: 'object', additionalProperties: true } },
        required: ['data'],
        additionalProperties: false,
      },
    },
  ]),
);
export const SQUARE_CATALOG: CatalogConnector = {
  id: 'operator_square',
  version: '1.0.0',
  kind: 'builtin',
  operations,
};

/** Operator-controlled sandbox bridge. Provider credentials never enter an authored artifact. */
export function createHttpSquareConnectors(config: HttpActionConfig): DeploymentConnectors {
  validateActionConfig(config);
  const post = createOperatorJsonPost({
    ...config,
    url: new URL('/internal/runtime/square', config.url).href,
  });
  return {
    catalog: [SQUARE_CATALOG],
    create(input) {
      if (input.deploymentId === undefined) return [];
      const tools = new Map(
        input.artifact.tools
          .filter((tool) => names.some((name) => name === tool.name))
          .map((tool) => [tool.name, tool]),
      );
      if (!tools.size) return [];
      for (const tool of tools.values()) {
        const properties = tool.inputSchema.properties;
        if (
          !isObject(properties) ||
          Object.keys(properties).length !== 1 ||
          !isObject(properties.values) ||
          properties.values.type !== 'object' ||
          properties.values.additionalProperties !== false ||
          tool.inputSchema.additionalProperties !== false ||
          !Array.isArray(tool.inputSchema.required) ||
          !tool.inputSchema.required.includes('values')
        )
          throw new Error('Square tools require a strict values object');
        if (tool.name === 'square_prepare_checkout' && !requiresToolConfirmation(tool.annotations))
          throw new Error('Square checkout requires confirmation');
      }
      const environment = input.tenant.env;
      if (environment !== 'test' && environment !== 'live')
        throw new Error('Square requires test or live environment');
      const target = {
        org: input.tenant.org,
        app: input.tenant.app,
        environment,
        deploymentId: input.deploymentId,
      };
      return [
        {
          id: SQUARE_CATALOG.id,
          version: SQUARE_CATALOG.version,
          signature: (operation) =>
            Object.hasOwn(operations, operation) ? operations[operation] : undefined,
          executionBoundMs: () => config.timeoutMs ?? 10000,
          async invoke(call: ConnectorCall): Promise<unknown> {
            const tool = tools.get(call.operation);
            const signature = Object.hasOwn(operations, call.operation)
              ? operations[call.operation]
              : undefined;
            if (
              !tool ||
              !signature ||
              !call.assistantSessionId ||
              call.assistantSessionId.length > 256 ||
              !/^[a-f0-9]{64}$/.test(call.execution?.id ?? '') ||
              call.execution?.entrypointKind !== 'tool' ||
              call.execution.toolName !== call.operation
            )
              return reject(call, 'Trusted Square session execution required');
            if (
              validateJsonSchema(signature.input, call.args).length ||
              validateJsonSchema(tool.inputSchema, call.args).length
            )
              return reject(call, 'Invalid Square values');
            if (call.signal?.aborted)
              return reject(call, 'Square request cancelled before dispatch');
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
                  tool: call.operation,
                  customerSessionId: call.assistantSessionId,
                  values: call.args.values,
                },
                signal,
              );
              if (!response.ok) {
                if ([400, 401, 403, 409, 422, 429].includes(response.status))
                  return reject(call, 'Square request is not currently permitted', response.status);
                throw new Error('unavailable');
              }
              if (response.body === null) throw new Error('unavailable');
              let size = 0;
              const chunks: Uint8Array[] = [];
              for await (const chunk of response.body) {
                size += chunk.byteLength;
                if (size > 131072) throw new Error('oversized');
                chunks.push(chunk);
              }
              const result: unknown = JSON.parse(
                new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size)),
              );
              if (validateJsonSchema(signature.output, result).length)
                throw new Error('invalid response');
              call.reportOutcome?.({ outcome: 'completed' });
              return result;
            } catch (error) {
              if (error instanceof ConnectorInvocationError) throw error;
              call.reportOutcome?.({ outcome: 'unknown' });
              throw new ConnectorInvocationError(
                'Square outcome is unknown; check the current cart or order before trying again.',
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
function reject(call: ConnectorCall, message: string, status = 400): never {
  call.reportOutcome?.({ outcome: 'rejected' });
  throw new ConnectorInvocationError(message, { status, retryable: false });
}
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
