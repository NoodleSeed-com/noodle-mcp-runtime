import {
  annotations,
  asset,
  authenticatedWebsite,
  embeddedAssistant,
  openAICompatible,
  secret,
  server,
  tool,
  variable,
  z,
} from '@noodleseed/one';
import { cardHtml } from './card.js';

export default server(
  'runtime_proof',
  {
    title: 'Runtime proof',
    version: '1.0.0',
    branding: {
      name: 'Runtime proof',
      logo: { uri: asset('assets/proof-pixel.png'), alt: 'Synthetic one-pixel fixture' },
    },
    assistant: embeddedAssistant({
      model: openAICompatible({
        baseUrl: variable('PROOF_MODEL_BASE_URL'),
        model: variable('PROOF_MODEL'),
        apiKey: secret('PROOF_MODEL_API_KEY'),
      }),
      access: authenticatedWebsite({ origins: ['http://127.0.0.1:9080'] }),
    }),
  },
  [
    tool('greet', {
      title: 'Read a synthetic greeting',
      description:
        'Return a synthetic greeting and a deployment proof card. No external service or model is called.',
      input: z.object({ name: z.string().default('world') }),
      output: z.object({ message: z.string(), fixture: z.string() }),
      authorization: { requiredScopes: ['proof:read'] },
      annotations: annotations.readOnly(),
      fulfil: ({ input }) => ({
        message: `Hello, ${input.name}!`,
        fixture: 'Synthetic deployment proof; no external service.',
      }),
      viewName: 'card',
      viewTitle: 'Runtime proof card',
      viewDescription: 'A synthetic fixture for checking resource and packaged asset persistence.',
      view: { html: cardHtml },
      csp: { connectDomains: [], resourceDomains: [], frameDomains: [] },
    }),
  ],
);
