import { Client, Pool } from 'pg';
import { initializePostgresCoreSchema } from './postgres-schema-startup.js';
import { POSTGRES_SCHEMA_CONTRACT, readPostgresSchemaContract } from './schema-contract.js';

export interface MigratePostgresOptions {
  readonly databaseUrl: string;
  /** Nonsecret immutable build identity recorded for operator evidence. */
  readonly buildId?: string;
}

/** Schema-only lifecycle: no server, asset adapter, module initialization or background work. */
export async function migratePostgresSchema(
  options: MigratePostgresOptions,
): Promise<{ applied: boolean; generation: number }> {
  const pool = new Pool({
    connectionString: options.databaseUrl,
    max: 5,
    application_name: 'noodle-schema-migration',
    connectionTimeoutMillis: 5000,
    statement_timeout: 60000,
  });
  let lost = false;
  let closing: Promise<void> | undefined;
  const sessions = new Set<Client>();
  const onLost = () => {
    if (lost) return;
    lost = true;
    // Pool.end() only drains checked-out clients. End their actual connections first:
    // this interrupts active SQL, rolls back open transactions and rejects later COMMITs.
    const terminated = [...sessions].map((client) => client.end().catch(() => undefined));
    closing = Promise.all(terminated).then(() => pool.end());
    void closing.catch(() => undefined);
  };
  pool.on('connect', (client) => {
    if (!(client instanceof Client)) throw new Error('Unexpected migration database client');
    sessions.add(client);
    client.once('end', () => sessions.delete(client));
    // A connection already being established when cancellation began must also stop.
    if (lost) void client.end().catch(() => undefined);
  });
  pool.on('error', onLost);
  const lock = await pool.connect().catch(async (error) => {
    await (closing ?? pool.end());
    throw error;
  });
  lock.on('error', onLost);
  const deadline = setTimeout(onLost, 600000);
  let locked = false;
  try {
    await lock.query("SET lock_timeout = '10s'");
    await lock.query('SELECT pg_advisory_lock(184728395, 1)');
    locked = true;
    await pool.query(`CREATE TABLE IF NOT EXISTS public.noodle_schema_contract (
      singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
      generation integer NOT NULL CHECK (generation > 0),
      epoch integer NOT NULL CHECK (epoch > 0),
      profile text NOT NULL,
      plan text NOT NULL,
      build_id text NOT NULL,
      completed_at timestamptz NOT NULL DEFAULT now()
    )`);
    const previous = await readPostgresSchemaContract(pool);
    const next = POSTGRES_SCHEMA_CONTRACT;
    if (previous !== undefined) {
      if (previous.generation > next.generation)
        throw new Error('Refusing an older schema migration');
      if (previous.generation === next.generation) {
        if (
          previous.epoch !== next.epoch ||
          previous.profile !== next.profile ||
          previous.plan !== next.plan
        )
          throw new Error('Schema generation has conflicting migration identity');
        if (lost) throw new Error('Schema migration lock was lost');
        return { applied: false, generation: next.generation };
      }
      if (previous.epoch !== next.epoch || previous.profile !== next.profile)
        throw new Error(
          'Schema profile or epoch transition requires an explicit upgrade procedure',
        );
    }
    await initializePostgresCoreSchema(pool, { schemaMode: 'external' });
    if (lost) throw new Error('Schema migration lock was lost');
    await pool.query(
      `INSERT INTO public.noodle_schema_contract(singleton,generation,epoch,profile,plan,build_id)
      VALUES(true,$1,$2,$3,$4,$5) ON CONFLICT(singleton) DO UPDATE SET generation=EXCLUDED.generation,
      epoch=EXCLUDED.epoch, profile=EXCLUDED.profile, plan=EXCLUDED.plan, build_id=EXCLUDED.build_id, completed_at=now()`,
      [next.generation, next.epoch, next.profile, next.plan, options.buildId ?? next.plan],
    );
    if (lost) throw new Error('Schema migration lock was lost');
    return { applied: true, generation: next.generation };
  } finally {
    clearTimeout(deadline);
    if (locked && !lost)
      await lock.query('SELECT pg_advisory_unlock(184728395, 1)').catch(() => undefined);
    lock.off('error', onLost);
    lock.release(lost);
    await (closing ?? pool.end());
  }
}
