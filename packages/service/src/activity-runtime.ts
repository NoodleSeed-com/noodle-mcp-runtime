import type { ActivityOutbox } from '@noodle-borg/module';
import { PostgresActivityOutbox } from '@noodle-borg/observability';
import type { Pool } from 'pg';
import type { ExpiredContentStore } from './business-information/retention-sweeper.js';
import type { ServeServiceOptions } from './serve-options.js';
/** Adapt the independently owned activity deadline to the existing bounded maintenance pass. */
export function activityRetentionStore(
  outbox: ActivityOutbox | undefined,
): ExpiredContentStore | undefined {
  return outbox ? { purgeExpired: (input) => outbox.purgeExpired(input.limit) } : undefined;
}

export function configuredActivityStores(
  options: ServeServiceOptions,
  pool?: Pool,
): { capture: ActivityOutbox | undefined; retention: ExpiredContentStore | undefined } {
  const durable =
    options.activityOutbox ??
    (pool && options.schemaMode === 'external' ? new PostgresActivityOutbox(pool) : undefined);
  return {
    capture: options.activityOutbox ?? (options.activityCaptureEnabled ? durable : undefined),
    retention: activityRetentionStore(durable),
  };
}
