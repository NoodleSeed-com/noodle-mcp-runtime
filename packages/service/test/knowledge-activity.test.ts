import type { ActivityEnvelope } from '@noodle-borg/module';
import { expect, it } from 'vitest';
import { captureKnowledgePort } from '../src/routes/knowledge-activity.js';

it('captures the exact response once for each invocation and does not alter answers on archive failure', async () => {
  const events: ActivityEnvelope[] = [];
  const hits = [
    {
      id: 'doc',
      title: 'Title',
      excerpt: 'Exact evidence',
      sourceKind: 'document' as const,
      uri: 'https://example.com',
    },
  ];
  const port = captureKnowledgePort(
    { enabled: async () => true, search: async () => ({ ok: true, hits }) },
    {
      tenant: { org: 'o', app: 'a', env: 'test' },
      deploymentId: 'd',
      channel: 'private_test',
      sessionId: 's',
      turnId: 't',
      turnStartedAt: new Date(Date.now() - 1000).toISOString(),
    },
    [{ name: 'docs', generatedTool: { name: 'search_docs' } }],
    async (e) => {
      events.push(e);
    },
  );
  await port.search('docs', { query: 'SOC 2' });
  await port.search('docs', { query: 'data hosting' });
  expect(events).toHaveLength(2);
  expect(events[0]?.payload).toMatchObject({ query: 'SOC 2', hits, turnId: 't' });
  expect(events[0]?.id).not.toBe(events[1]?.id);
  const failing = captureKnowledgePort(
    port,
    { tenant: { org: 'o', app: 'a', env: 'test' }, deploymentId: 'd', channel: 'external_mcp' },
    [],
    async () => {
      throw new Error('offline');
    },
  );
  expect(await failing.search('docs', { query: 'x' })).toEqual({ ok: true, hits });
});
