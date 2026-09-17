import { expect, it } from 'vitest';
import { Bm25KnowledgeIndex } from '../src/bm25.js';

it('preserves original punctuation and casing in returned business facts', async () => {
  const index = new Bm25KnowledgeIndex();
  const scope = { org: 'proof', app: 'proof', env: 'test' };
  const text =
    'Email hello@example.com. Price is $49.99.\nCall +44 20 1234 5678. A 45-minute setup session.';
  const revision = await index.stage(scope, 'business', [
    {
      descriptor: {
        path: 'faqs.md',
        title: 'FAQs',
        sha256: 'a'.repeat(64),
        bytes: Buffer.byteLength(text),
      },
      text,
    },
  ]);
  await index.activate(revision.revisionId);
  const hits = await index.search(scope, 'business', { query: 'Email', limit: 8 });
  expect(hits[0]?.excerpt).toBe(text.replaceAll(/\s+/g, ' '));
});
