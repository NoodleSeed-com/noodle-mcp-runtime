#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import {
  createModule as createAssetStorageModule,
  FilesystemAssetStore,
  GcsAssetStore,
} from '@noodle-borg/asset-storage';
import {
  migratePostgresSchema,
  type RunningService,
  type ServeServiceOptions,
  serveService,
} from '@noodle-borg/service';
import { createLogger, type Logger } from '@noodle-borg/transport-http';

import { SelfHostAdminGate } from './admin-gate.js';
import { resolveSelfHostConfig, resolveSelfHostMigrationConfig } from './config.js';
import { createHttpAdmissionGate } from './http-admission.js';
import { ownerAuthOptions } from './owner-auth.js';

type SelfHostRunningService = Pick<RunningService, 'close'>;
type SigtermHandler = () => Promise<void>;

export interface SelfHostServiceDependencies {
  readonly serve: (options: ServeServiceOptions) => Promise<SelfHostRunningService>;
  readonly logger: Logger;
  readonly onSigterm: (handler: SigtermHandler) => void;
  readonly setExitCode: (code: number) => void;
}

const logger = createLogger({ base: { svc: 'noodle-self-host' } });
const defaultDependencies: SelfHostServiceDependencies = {
  serve: serveService,
  logger,
  onSigterm: (handler) => {
    process.once('SIGTERM', () => {
      const deadline = setTimeout(() => process.exit(1), 8000);
      void handler()
        .catch(() => undefined)
        .finally(() => clearTimeout(deadline));
    });
  },
  setExitCode: (code) => {
    process.exitCode = code;
  },
};

/** Validate operator configuration, compose the portable service, and register graceful shutdown. */
export async function startSelfHostService(
  env: Readonly<Record<string, string | undefined>> = process.env,
  dependencies: SelfHostServiceDependencies = defaultDependencies,
): Promise<SelfHostRunningService> {
  const config = resolveSelfHostConfig(env);
  const assetOptions: Pick<ServeServiceOptions, 'assetStore' | 'modules'> =
    config.assetStorage === 'gcs'
      ? {
          assetStore: new GcsAssetStore({
            bucket: config.assetBucket ?? '',
            keySalt: config.assetIdentitySalt,
          }),
        }
      : config.schemaMode === 'external'
        ? {
            assetStore: new FilesystemAssetStore({
              root: config.assetRoot ?? '',
              keySalt: config.assetIdentitySalt,
            }),
          }
        : {
            modules: [
              createAssetStorageModule({
                root: config.assetRoot ?? '',
                salt: config.assetIdentitySalt,
              }),
            ],
          };
  const lifecycleFields = {
    host: config.host,
    port: config.port,
    persistence: 'postgresql',
    protocolMode: 'dual',
  } as const;
  const running = await dependencies.serve({
    host: config.host,
    port: config.port,
    publicBaseUrl: config.publicBaseUrl,
    ...(config.trustProxy ? { tls: { trustProxy: true, requireHttps: true } } : {}),
    assetPublicBaseUrl: config.publicBaseUrl,
    databaseUrl: config.databaseUrl,
    ...(config.activityCaptureEnabled ? { activityCaptureEnabled: true } : {}),
    secretMasterKey: config.secretMasterKey,
    warmAll: config.schemaMode !== 'external',
    ...(config.schemaMode === 'external' ? { schemaMode: 'external' as const } : {}),
    mcpProtocolMode: 'dual',
    requireAssistantExecutionAdmission: config.requireAssistantExecutionAdmission,
    ...assetOptions,
    deployGate: new SelfHostAdminGate(config.adminToken),
    ...(config.admission === undefined
      ? {}
      : { admissionGate: createHttpAdmissionGate(config.admission) }),
    ...(await ownerAuthOptions(config.ownerAuth, config.admission !== undefined)),
    logger: dependencies.logger,
  });

  dependencies.logger.info('self_host.ready', lifecycleFields);
  let closePromise: Promise<void> | undefined;
  dependencies.onSigterm(() => {
    closePromise ??= running.close().then(
      () => dependencies.logger.info('self_host.stopped', lifecycleFields),
      (error: unknown) => {
        dependencies.logger.error('self_host.stop_failed', lifecycleFields);
        dependencies.setExitCode(1);
        throw error;
      },
    );
    return closePromise;
  });
  return running;
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  const command = process.argv[2];
  const operation =
    command === 'migrate'
      ? Promise.resolve()
          .then(() =>
            migratePostgresSchema({
              ...resolveSelfHostMigrationConfig(process.env),
              ...(process.env.NOODLE_BUILD_SHA === undefined
                ? {}
                : { buildId: process.env.NOODLE_BUILD_SHA }),
            }),
          )
          .then((result) => {
            logger.info('self_host.migrated', result);
          })
      : command === undefined
        ? startSelfHostService()
        : Promise.reject(new Error('Unknown self-host command'));
  operation.catch(() => {
    logger.error('self_host.start_failed');
    process.exitCode = 1;
  });
}
