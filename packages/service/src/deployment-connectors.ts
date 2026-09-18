import type { CatalogConnector, RuntimeArtifact } from '@noodle-borg/compiler';
import type { Connector } from '@noodle-borg/runtime';
import type { TenantRef } from './store.js';

/** Operator-only dependency injection. Authored definitions cannot replace these connector IDs. */
export interface DeploymentConnectors {
  readonly catalog: readonly CatalogConnector[];
  readonly create: (input: {
    readonly tenant: TenantRef;
    readonly artifact: RuntimeArtifact;
    readonly deploymentId?: string;
  }) => readonly Connector[];
}
