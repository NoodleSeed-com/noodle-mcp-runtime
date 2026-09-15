import { createPostgresKnowledgeStores } from '@noodle-borg/knowledge-operations';
import { ensureIntentCaptureSchema } from '@noodle-borg/observability';
import type { SecretBox } from '@noodle-borg/runtime';
import type { Pool } from 'pg';
import {
  ensureBusinessInformationSchema,
  ensureSourceIngestionSchema,
} from './business-information/postgres.js';
import { PostgresConnectionStore } from './connections/store.js';
import { PostgresGoogleWorkloadIdentityStore } from './google-workload-identity-postgres.js';
import { ensureMcpConfirmationNonceSchema } from './mcp-confirmation-nonce-postgres.js';
import { ensureOperationCoordinationSchema } from './operation-coordination-postgres.js';
import { ensureOperationEvidenceSchema } from './operation-evidence-postgres.js';
import { createPostgresAssistantStores } from './serve-assistant-stores.js';
import type { ServeServiceOptions } from './serve-options.js';
import { PostgresArtifactStore } from './store/postgres.js';

/** Canonical core schema owners, shared by ordinary initialization and the schema-only job. */
export async function initializePostgresCoreSchema(
  pool: Pool,
  options: ServeServiceOptions,
  secretBox?: SecretBox,
) {
  await ensureMcpConfirmationNonceSchema(pool);
  const report = await new PostgresArtifactStore(pool).ensureSchemaWithCustomerAuthAudienceReport();
  await createPostgresKnowledgeStores(pool, secretBox);
  if (options.googleWorkloadIdentity === undefined && options.oauth !== undefined)
    await new PostgresGoogleWorkloadIdentityStore(pool).ensureSchema();
  await ensureIntentCaptureSchema(pool);
  const businessEnabled = options.businessInformationEnabled ?? options.dataDir === undefined;
  if (businessEnabled) {
    if (options.businessInformationStore === undefined) {
      await ensureBusinessInformationSchema(pool);
      if (
        options.businessInformationSourceStore === undefined &&
        (options.businessInformationSourceIdentityKey !== undefined ||
          options.secretMasterKey !== undefined ||
          options.schemaMode === 'external')
      )
        await ensureSourceIngestionSchema(pool);
    }
    await ensureOperationEvidenceSchema(pool);
    await ensureOperationCoordinationSchema(pool);
  }
  if (options.applicationConnections) {
    if (secretBox === undefined) throw new Error('Connections require service key custody');
    await new PostgresConnectionStore(pool, secretBox).ensureSchema();
  }
  await createPostgresAssistantStores(pool, options);
  return report;
}
