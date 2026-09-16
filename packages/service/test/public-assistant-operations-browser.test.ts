import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { InMemoryDailyCounterStore } from '@noodle-borg/admission-limits';
import type { AdmissionContext } from '@noodle-borg/module';
import { chromium } from 'playwright';
import { describe, expect, it } from 'vitest';
import {
  createServiceHandler,
  InMemoryAssistantStore,
  InMemoryPublicEmbedStore,
  ServerRegistry,
} from '../src/index.js';

class DurableCounters extends InMemoryDailyCounterStore {
  override readonly durable = true;
}
const TENANT = { org: 'acme', app: 'site', env: 'live' };
const POLICY = {
  version: 1,
  policyId: 'public-test',
  maxModelRequests: 2,
  maxInputTokens: 16384,
  maxCompletionTokens: 1024,
  maxTokensPerTurn: 2048,
  maxRequestBytes: 131072,
  maxToolCallsPerTurn: 1,
  timeoutMs: 30000,
  maxTurnMs: 90000,
  reasoningEffort: 'none',
} as const;
function origin(server: Server) {
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
}

// The shipped script, actual browser CORS and service work together; only the external model is synthetic.
describe('admitted public embed browser', () => {
  it('uses the pasted script for a counted model/tool/card turn and revokes existing sessions', async () => {
    const requests: AdmissionContext[] = [];
    let live = true;
    let calls = 0;
    let counts = 0;
    let snippet = '';
    const site = createServer((_req, res) => {
      res.setHeader('content-type', 'text/html');
      res.end(`<!doctype html><title>Acme</title>${snippet}`);
    });
    await listen(site);
    const siteOrigin = origin(site);
    const registry = new ServerRegistry();
    await registry.configStore.setConfigValue({
      kind: 'secret',
      scope: { level: 'env', ...TENANT },
      name: 'MODEL_KEY',
      value: 'synthetic-model-key',
    });
    const manifest = `manifestVersion: "1"
server:
  name: public_site
  title: Public site
  version: 1.0.0
  assistant:
    model: { kind: openai-compatible, transport: responses, baseUrl: https://models.example/v1, model: test-model, apiKey: MODEL_KEY }
    allowedOrigins: ["${siteOrigin}"]
    suggestedPrompts: []
    surfaces:
      - mode: public
        origins: ["${siteOrigin}"]
        capabilities: [{ kind: tool, name: lookup }]
tools:
  - name: lookup
    description: Read public product information.
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    inputSchema: { type: object, properties: {}, additionalProperties: false }
    fulfilment:
      steps: []
      output: { answer: Public product details }
widgets:
  - name: product_card
    tool: lookup
    title: Product details
    html: '<!doctype html><main>Public product card</main>'
`;
    const deployed = await registry.deploy(TENANT, manifest, {
      accessMode: 'public',
      serverVersion: '1',
    });
    expect(deployed.ok, JSON.stringify(deployed)).toBe(true);
    if (!deployed.ok) throw new Error('fixture deployment failed');
    const embeds = new InMemoryPublicEmbedStore();
    const embed = await embeds.ensure({ ...TENANT, surfaceMode: 'public', now: new Date() });
    const service = createServer(
      createServiceHandler(registry, {
        assistantStore: new InMemoryAssistantStore(),
        publicEmbeds: embeds,
        admissionCounters: new DurableCounters(),
        requireAssistantExecutionAdmission: true,
        admissionGate: async (context) => {
          requests.push(context);
          if (!live) return { allow: false, reason: 'disabled' };
          return context.assistantExecution
            ? { allow: true, assistantExecution: POLICY }
            : { allow: true };
        },
        assistantModelFetch: async (url) => {
          if (String(url).endsWith('/input_tokens')) {
            counts++;
            return Response.json({ input_tokens: 40 });
          }
          calls++;
          return Response.json({
            output:
              calls === 1
                ? [
                    {
                      type: 'function_call',
                      call_id: 'public-call',
                      name: 'lookup',
                      arguments: '{}',
                    },
                  ]
                : [
                    {
                      type: 'message',
                      content: [
                        { type: 'output_text', text: 'Here are the public product details.' },
                      ],
                    },
                  ],
          });
        },
      }),
    );
    await listen(service);
    snippet = `<script src="${origin(service)}/v1/assistant/embed.js" data-embed-id="${embed.embedId}" async></script>`;
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const turns: string[] = [];
      page.on('response', (response) => {
        if (response.url().endsWith('/turns'))
          void response
            .text()
            .then((text) => turns.push(text))
            .catch(() => {});
      });
      await page.goto(siteOrigin);
      await page.waitForFunction(() => customElements.get('noodle-assistant') !== undefined);
      await page.evaluate(async () => {
        const element = document.querySelector('noodle-assistant') as HTMLElement & {
          sendMessage(message: string): Promise<void>;
        };
        await element.sendMessage('Tell me about the product');
      });
      await expect.poll(() => turns.length).toBe(1);
      expect(turns[0]).toContain('event: view_available');
      expect(turns[0]).toContain('ui://public_site/product_card');
      expect(turns[0]).toContain('Here are the public product details.');
      expect(calls).toBe(2);
      expect(counts).toBe(2);
      const execution = requests.filter((context) => context.assistantExecution);
      expect(execution).toHaveLength(1);
      expect(execution[0]).toMatchObject({
        ...TENANT,
        deploymentId: deployed.deploymentId,
        serverVersion: '1',
        assistantSurface: { kind: 'public', origin: siteOrigin, publicEmbedId: embed.embedId },
        assistantExecution: {
          clientId: embed.embedId,
          operationId: expect.any(String),
          requestDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      });
      expect(requests.every((context) => context.subject === undefined)).toBe(true);
      expect(
        requests.every(
          (context) => context.accessMode === 'public' && context.serverVersion === '1',
        ),
      ).toBe(true);
      expect(
        requests.every((context) => context.assistantSurface?.publicEmbedId === embed.embedId),
      ).toBe(true);
      expect(requests.some((context) => context.method === 'assistant/operations')).toBe(true);
      live = false;
      await page.evaluate(async () => {
        const element = document.querySelector('noodle-assistant') as HTMLElement & {
          sendMessage(message: string): Promise<void>;
        };
        try {
          await element.sendMessage('Try again');
        } catch {
          /* visible refusal is expected */
        }
      });
      expect(calls).toBe(2);
      const denied = await fetch(`${origin(service)}/v1/assistant/public-sessions`, {
        method: 'POST',
        headers: { origin: siteOrigin, 'content-type': 'application/json' },
        body: JSON.stringify({ embedId: embed.embedId }),
      });
      expect(denied.status).toBe(403);
    } finally {
      await browser.close();
      await Promise.all(
        [site, service].map(
          (server) =>
            new Promise<void>((resolve) => {
              server.closeAllConnections();
              server.close(() => resolve());
            }),
        ),
      );
    }
  }, 30000);
});
