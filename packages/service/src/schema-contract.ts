import type { Pool } from 'pg';
import type { ServeServiceOptions } from './serve-options.js';

/** Change generation for every canonical schema change; incompatible changes must change epoch. */
export const POSTGRES_SCHEMA_CONTRACT = {
  generation: 1,
  epoch: 1,
  profile: 'self-host-external-owner-v1',
  plan: 'core-schema-1',
} as const;
export interface SchemaContractRow {
  generation: number;
  epoch: number;
  profile: string;
  plan: string;
}

export function assertExternalSchemaProfile(options: ServeServiceOptions): void {
  if (
    (options.databaseUrl === undefined && options.postgresPool === undefined) ||
    options.dataDir !== undefined ||
    options.oauth !== undefined ||
    (options.modules?.length ?? 0) > 0 ||
    options.moduleImporter !== undefined ||
    options.applicationConnections !== undefined ||
    options.businessInformationEnabled === false ||
    options.assistantStore !== undefined ||
    options.assistantAppearance !== undefined ||
    options.publicEmbeds !== undefined ||
    options.admissionCounters !== undefined ||
    options.elevations !== undefined ||
    options.recoveryMode === 'quarantined'
  ) {
    throw new Error(
      'External schema mode requires the canonical PostgreSQL self-host profile without integrated OAuth, custom modules or store overrides',
    );
  }
}

export async function readPostgresSchemaContract(
  pool: Pick<Pool, 'query'>,
): Promise<SchemaContractRow | undefined> {
  const result = await pool.query<SchemaContractRow>(
    'SELECT generation, epoch, profile, plan FROM public.noodle_schema_contract WHERE singleton = true',
  );
  return result.rows[0];
}

/** SELECT-only startup admission: the running role cannot attest its own schema compatibility. */
export async function verifyPostgresSchemaContract(pool: Pool): Promise<void> {
  const row = await readPostgresSchemaContract(pool);
  const expected = POSTGRES_SCHEMA_CONTRACT;
  if (
    row === undefined ||
    !Number.isInteger(row.generation) ||
    row.generation < expected.generation ||
    row.epoch !== expected.epoch ||
    row.profile !== expected.profile
  )
    throw new Error(
      'PostgreSQL schema is missing or incompatible; run the matching migration command',
    );
}
