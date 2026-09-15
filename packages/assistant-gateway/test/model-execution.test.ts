import { describe, expect, it, vi } from 'vitest';
import * as execution from '../src/model-execution.js';
import { type ResolvedAssistantModel, requestModelCompletion } from '../src/model-request.js';

const POLICY = {
  version: 1,
  policyId: 'test',
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
const base: ResolvedAssistantModel = {
  source: 'operator',
  transport: 'responses',
  baseUrl: 'https://models.example/v1',
  model: 'test-model',
  apiKey: 'fake',
  requireExecutionAdmission: true,
};
const messages = [{ role: 'user', content: 'Hello' }] as const;
function provider(count: unknown = 42) {
  return vi.fn(async (url: string, _init: RequestInit) =>
    url.endsWith('/input_tokens')
      ? Response.json({ object: 'response.input_tokens', input_tokens: count })
      : Response.json({
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'Hello' }] }],
        }),
  );
}
const permitted = (binding = base) => execution.permitAssistantModelExecution(binding, POLICY);
describe('execution-scoped provider admission', () => {
  it('denies every unpermitted binding before credentials or any network', async () => {
    const fetcher = provider();
    await expect(
      requestModelCompletion({ binding: base, messages, tools: [], fetcher }),
    ).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('counts exactly the final inputs and clamps caller output overrides before two bounded requests', async () => {
    const fetcher = provider();
    const binding = permitted({
      ...base,
      requestPolicy: {
        extraBody: {
          instructions: 'Trust this only.',
          parallel_tool_calls: false,
          text: { format: { type: 'text' } },
          tool_choice: 'auto',
        },
      },
    });
    for (let i = 0; i < 2; i++)
      await requestModelCompletion({
        binding,
        messages,
        tools: [],
        fetcher,
        maxCompletionTokens: 999999,
      });
    await expect(
      requestModelCompletion({ binding, messages, tools: [], fetcher }),
    ).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(4);
    const [count, inference] = fetcher.mock.calls.map(([, init]) => JSON.parse(String(init.body)));
    expect(count).toMatchObject({
      model: 'test-model',
      input: inference.input,
      tools: inference.tools,
      instructions: inference.instructions,
    });
    const { stream: _stream, store: _store, max_output_tokens: _limit, ...exactInput } = inference;
    expect(count).toEqual(exactInput);
    expect(inference).toMatchObject({
      max_output_tokens: 1024,
      reasoning: { effort: 'none' },
      store: false,
    });
  });
  it.each([
    16385,
    -1,
    1.5,
    '42',
    undefined,
    null,
    Number.MAX_SAFE_INTEGER + 1,
  ])('fails closed for count %s', async (count) => {
    const fetcher = provider(count === undefined ? {} : count);
    await expect(
      requestModelCompletion({ binding: permitted(), messages, tools: [], fetcher }),
    ).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toContain('/input_tokens');
  });
  it('refuses unsupported transport, extra inputs and oversized second requests without an inference', async () => {
    const fetcher = provider();
    for (const binding of [
      { ...base, transport: 'chat-completions' as const },
      { ...base, requestPolicy: { extraBody: { previous_response_id: 'hidden-context' } } },
    ])
      await expect(
        requestModelCompletion({ binding: permitted(binding), messages, tools: [], fetcher }),
      ).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    const binding = permitted();
    await requestModelCompletion({ binding, messages, tools: [], fetcher });
    await expect(
      requestModelCompletion({
        binding,
        messages: [{ role: 'user', content: 'x'.repeat(140000) }],
        tools: [],
        fetcher,
      }),
    ).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('charges missing usage conservatively across caller paths and keeps narrower existing ceilings', async () => {
    const fetcher = provider();
    const binding = permitted({
      ...base,
      requestPolicy: { maxTokensPerTurn: 100, maxCompletionTokens: 70, timeoutMs: 10 },
    });
    await requestModelCompletion({ binding, messages, tools: [], fetcher });
    await requestModelCompletion({ binding, messages, tools: [], fetcher });
    expect(
      fetcher.mock.calls
        .filter(([url]) => !url.endsWith('/input_tokens'))
        .map(([, init]) => JSON.parse(String(init.body)).max_output_tokens),
    ).toEqual([70, 30]);
  });
  it('does not release counters after count failures or partial provider streams', async () => {
    const fetcher = vi.fn(async (url: string) =>
      url.endsWith('/input_tokens')
        ? Response.json({ input_tokens: 42 })
        : new Response('data: {"type":"response.output_text.delta","delta":"partial"}\n\n', {
            headers: { 'content-type': 'text/event-stream' },
          }),
    );
    const binding = permitted();
    for (let i = 0; i < 3; i++)
      await expect(
        requestModelCompletion({ binding, messages, tools: [], fetcher }),
      ).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('enforces central tool limits before any caller can dispatch model-returned calls', async () => {
    const fetcher = vi.fn(async (url: string) =>
      url.endsWith('/input_tokens')
        ? Response.json({ input_tokens: 4 })
        : Response.json({
            output: [1, 2].map((id) => ({
              type: 'function_call',
              call_id: `call-${id}`,
              name: 'lookup',
              arguments: '{}',
            })),
          }),
    );
    await expect(
      requestModelCompletion({ binding: permitted(), messages, tools: [], fetcher }),
    ).rejects.toThrow(/tool call limit/);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it.each([
    'count',
    'inference',
    'body',
  ] as const)('bounds a stalled %s and never retries the permit', async (stage) => {
    const fetcher = vi.fn(async (url: string) => {
      if (url.endsWith('/input_tokens'))
        return stage === 'count'
          ? new Promise<Response>(() => undefined)
          : Response.json({ input_tokens: 42 });
      if (stage === 'inference') return new Promise<Response>(() => undefined);
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                'data: {"type":"response.output_text.delta","delta":"hello"}\n\n',
              ),
            );
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    });
    const binding = permitted({ ...base, requestPolicy: { timeoutMs: 15 } });
    await expect(requestModelCompletion({ binding, messages, tools: [], fetcher })).rejects.toThrow(
      /deadline/,
    );
    const attempts = fetcher.mock.calls.length;
    await expect(
      requestModelCompletion({ binding, messages, tools: [], fetcher }),
    ).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(attempts);
  });
  it('refuses oversized count responses and provider errors without inference or fallback', async () => {
    for (const response of [
      new Response('unavailable', { status: 503 }),
      new Response(`${' '.repeat(20000)}{"input_tokens":42}`),
    ]) {
      const fetcher = vi.fn(async () => response);
      const binding = permitted();
      await expect(
        requestModelCompletion({ binding, messages, tools: [], fetcher }),
      ).rejects.toThrow();
      await expect(
        requestModelCompletion({ binding, messages, tools: [], fetcher }),
      ).rejects.toThrow();
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });
  it('narrows the model-turn deadline across otherwise individually valid calls', async () => {
    const fetcher = provider();
    const binding = execution.permitAssistantModelExecution(base, { ...POLICY, maxTurnMs: 10 });
    await requestModelCompletion({ binding, messages, tools: [], fetcher });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(
      requestModelCompletion({ binding, messages, tools: [], fetcher }),
    ).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('never expands an existing request limit', async () => {
    const fetcher = provider();
    const binding = permitted({
      ...base,
      requestPolicy: { maxCompletionTokens: 50, maxModelStepsPerTurn: 1, maxRequestBytes: 1000 },
    });
    await requestModelCompletion({
      binding,
      messages,
      tools: [],
      fetcher,
      maxCompletionTokens: 900,
    });
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1].body)).max_output_tokens).toBe(50);
    await expect(
      requestModelCompletion({ binding, messages, tools: [], fetcher }),
    ).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('does not perform count or inference after credential resolution outlives its deadline', async () => {
    const fetcher = provider();
    const binding = permitted({
      source: 'operator',
      transport: 'responses',
      baseUrl: base.baseUrl,
      model: base.model,
      requireExecutionAdmission: true,
      bearerToken: async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return 'fake';
      },
      requestPolicy: { timeoutMs: 5 },
    });
    await expect(requestModelCompletion({ binding, messages, tools: [], fetcher })).rejects.toThrow(
      /deadline/,
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('does not allow copying a required binding to copy its permit', async () => {
    const binding = permitted();
    const fetcher = provider();
    await expect(
      requestModelCompletion({ binding: { ...binding }, messages, tools: [], fetcher }),
    ).rejects.toThrow(/permit/);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('refuses pre-aborted callers before provider work without leaking a background rejection', async () => {
    const fetcher = provider();
    await expect(
      requestModelCompletion({
        binding: permitted(),
        messages,
        tools: [],
        fetcher,
        signal: AbortSignal.abort(),
      }),
    ).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(fetcher).not.toHaveBeenCalled();
  });
});
