import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { POSTGRES_SCHEMA_CONTRACT } from '../src/schema-contract.js';

// Conservative whole-file lock: all portable schema-bearing source, including future profile owners.
// A schema change requires review of generation/epoch/profile and updating this fingerprint together.
const OWNERS = [
  'packages/admission-limits/src/postgres-counter-store.ts',
  'packages/assistant-gateway/src/postgres-assistant-appearance-store.ts',
  'packages/assistant-gateway/src/postgres-assistant-interactions.ts',
  'packages/assistant-gateway/src/postgres-assistant.ts',
  'packages/assistant-gateway/src/postgres-assistant-client-ensure.ts',
  'packages/assistant-gateway/src/postgres-assistant-operations.ts',
  'packages/assistant-gateway/src/postgres-continuity-store.ts',
  'packages/assistant-gateway/src/postgres-elevation-store.ts',
  'packages/assistant-gateway/src/postgres-embed-store.ts',
  'packages/control-plane/src/postgres-app-purge-reconciliation-schema.ts',
  'packages/control-plane/src/postgres-mcp-subdomain-schema.ts',
  'packages/control-plane/src/postgres-organization-agreements.ts',
  'packages/control-plane/src/postgres-schema.ts',
  'packages/knowledge-operations/src/postgres-crawl-state.ts',
  'packages/knowledge-operations/src/postgres-service-wiring.ts',
  'packages/knowledge-operations/src/postgres-staging-store.ts',
  'packages/knowledge/src/postgres-budget-store.ts',
  'packages/knowledge/src/postgres-revision-store.ts',
  'packages/module-audit/src/postgres-audit.ts',
  'packages/observability/src/intent-capture.ts',
  'packages/observability/src/request-events-postgres.ts',
  'packages/runtime/src/postgres-state-handles.ts',
  'packages/service/src/business-information/postgres-business-notice.ts',
  'packages/service/src/business-information/postgres-schema.ts',
  'packages/service/src/business-information/postgres-storage-budget.ts',
  'packages/service/src/business-information/source-custody-postgres.ts',
  'packages/service/src/business-information/source-ingestion-postgres-schema.ts',
  'packages/service/src/connections/store.ts',
  'packages/service/src/google-workload-identity-postgres.ts',
  'packages/service/src/mcp-confirmation-nonce-postgres.ts',
  'packages/service/src/migrate.ts',
  'packages/service/src/oauth/device-store-postgres-schema.ts',
  'packages/service/src/oauth/service-principal-store-postgres-schema.ts',
  'packages/service/src/oauth/store-postgres-schema.ts',
  'packages/service/src/oauth/token-exchange-jti-store.ts',
  'packages/service/src/operation-coordination-postgres.ts',
  'packages/service/src/operation-evidence-postgres.ts',
  'packages/service/src/postgres-schema-startup.ts',
  'packages/service/src/serve-assistant-stores.ts',
  'packages/service/src/store/postgres-alerts.ts',
  'packages/service/src/store/postgres-customer-auth-audience-schema.ts',
  'packages/service/src/store/postgres-deployment-lock.ts',
  'packages/service/src/store/postgres-schema.ts',
];
it('requires an explicit schema generation and compatibility decision when canonical owners change', () => {
  const root = new URL('../../../', import.meta.url);
  const hash = createHash('sha256');
  for (const file of OWNERS)
    hash
      .update(file)
      .update('\0')
      .update(readFileSync(new URL(file, root)))
      .update('\0');
  expect(POSTGRES_SCHEMA_CONTRACT).toEqual({
    generation: 3,
    epoch: 1,
    profile: 'self-host-external-owner-v1',
    plan: 'core-schema-3',
  });
  expect(
    hash.digest('hex'),
    'Review schema generation and compatibility epoch before updating this lock',
  ).toBe('52cc43dfc1f4821a3a7ae4dfe28ccabe4cffd7b4969bd5314b478dbb3ce3929c');
});
