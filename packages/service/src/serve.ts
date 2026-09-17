import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { DailyCounterStore } from '@noodle-borg/admission-limits/portable';
import type {
  AssistantAppearanceSettingsStore,
  AssistantElevationCoordinator,
  AssistantElevationStore,
  AssistantStore,
  PublicEmbedStore,
} from '@noodle-borg/assistant-gateway/portable';
import { PostgresAssistantElevationCoordinator } from '@noodle-borg/assistant-gateway/postgres';
import { InMemoryControlPlaneStore } from '@noodle-borg/control-plane/portable';
import { createPostgresKnowledgeStores } from '@noodle-borg/knowledge-operations';
import type { IntentEventStore, RequestEventStore } from '@noodle-borg/module';
import {
  createTelemetryRuntime,
  InMemoryIntentCaptureSettingsStore,
  InMemoryIntentEventStore,
  InMemoryRequestEventStore,
  type IntentCaptureSettingsStore,
  PostgresIntentCaptureSettingsStore,
  PostgresIntentEventStore,
  PostgresRequestEventStore,
} from '@noodle-borg/observability';
import { SecretBox, staticMasterKeyProvider } from '@noodle-borg/runtime';
import { PostgresStateHandleStore } from '@noodle-borg/runtime/postgres';
import { noopLogger } from '@noodle-borg/transport-http';
import { configuredActivityStores } from './activity-runtime.js';
import { ALERT_EVALUATION_INTERVAL_MS, AlertEvaluator } from './alert-evaluator.js';
import { createApplicationConnections } from './application-connections.js';
import { resolveApplicationRuntimeTarget } from './application-runtime-target.js';
import { type AssetStore, InMemoryAssetStore } from './assets.js';
import { resolveBuildInfo } from './build-info.js';
import {
  type BusinessInformationStore,
  InMemoryBusinessInformationStore,
  InMemorySourceIngestionStore,
  RegistrySourceReadExecutor,
  SourceIngestionCoordinator,
  type SourceIngestionStore,
  validateManagedPayload,
} from './business-information/portable.js';
import {
  PostgresBusinessInformationStore,
  PostgresSourceIngestionStore,
} from './business-information/postgres.js';
import { retentionSweepTrigger } from './business-information/retention-sweeper.js';
import { fenceSourceStore } from './business-information/source-credential-fence.js';
import { drainSourceIngestion } from './business-information/source-ingestion-coordinator.js';
import { SecretBoxPayloadCipher } from './business-information-cipher.js';
import { InMemoryConnectionStore, PostgresConnectionStore } from './connections/store.js';
import type { ConnectionStore } from './connections/types.js';
import { createDefaultControlPlaneGate } from './control-plane-auth-bootstrap.js';
import { warnCustomerAuthAudienceQuarantine } from './customer-auth-audience-quarantine.js';
import { createLocalDevtoolsCustomerVerifierFactory } from './customer-verifier.js';
import { PostgresGoogleWorkloadIdentityStore } from './google-workload-identity-postgres.js';
import { InMemoryGoogleWorkloadIdentityStore } from './google-workload-identity-store.js';
import { createLocalDevtoolsDelegatedCredentialSource } from './local-devtools-delegated-credentials.js';
import { PostgresMcpConfirmationNonceLedger } from './mcp-confirmation-nonce-postgres.js';
import { createHostedMcpRequestStateManager } from './mcp-protocol-runtime.js';
import { bootstrapServiceModules } from './modules/bootstrap.js';
import type { ModuleHost } from './modules/host.js';
import { resolveServiceOAuthBootstrap } from './oauth/service-bootstrap.js';
import type { ServiceOptions } from './options.js';
import { assertPostgresStoreOwnership } from './persistence-options.js';
import { initializePostgresCoreSchema } from './postgres-schema-startup.js';
import { resolveRecoveryMode, serveRecoveryQuarantine } from './recovery-quarantine.js';
import { ServerRegistry } from './registry.js';
import { assertExternalSchemaProfile, verifyPostgresSchemaContract } from './schema-contract.js';
import { assistantStoreOptions, createPostgresAssistantStores } from './serve-assistant-stores.js';
import {
  createLocalOperationStores,
  createPostgresOperationStores,
} from './serve-operation-stores.js';
import type { RunningService, ServeServiceOptions } from './serve-options.js';
import {
  assertLocalDevtoolsServiceBoundary,
  isLoopbackHost,
  openCustomerCredential,
  sealCustomerCredential,
} from './serve-resource-auth.js';
import { createServiceHandler } from './service.js';
import { resolveServiceConfigSource } from './service-config.js';
import {
  closeHttpServer,
  closeServiceResources,
  listenHttpServer,
} from './service-resource-cleanup.js';
import { sourceConfigurationAuthority } from './source-configuration-authority.js';
import { type AlertRuleStore, InMemoryAlertRuleStore } from './store/alert-rules.js';
import { JsonFileAlertRuleStore } from './store/alert-rules-json-file.js';
import { type AuditSink, InMemoryAuditStore } from './store/audit.js';
import type { PostgresPool } from './store/cloudsql-pool.js';
import { PostgresAlertRuleStore } from './store/postgres-alerts.js';
import { InMemoryUserAppLogStore } from './store/user-app-logs.js';
import {
  type ArtifactStore,
  type ConfigStore,
  type ControlPlaneStore,
  InMemoryConfigStore,
  JsonFileArtifactStore,
  type SecretEnvelope,
} from './store.js';
import { startWelcomeEmailWorker } from './welcome-email.js';

export type { RunningService } from './serve-options.js';

export async function serveService(options: ServeServiceOptions = {}): Promise<RunningService> {
  if (options.schemaMode === 'external') assertExternalSchemaProfile(options);
  const recoveryMode = resolveRecoveryMode(options.recoveryMode);
  if (recoveryMode === 'quarantined') return serveRecoveryQuarantine(options);
  if (recoveryMode === 'reopened' && options.operationEvidenceEpoch === undefined)
    throw new Error('Reopened recovery requires an explicit operation evidence epoch');
  const retentionDays = options.requestEventRetentionDays ?? 30;
  if (!Number.isInteger(retentionDays) || retentionDays < 1) {
    throw new Error('requestEventRetentionDays must be a positive integer number of days');
  }
  const buildInfo = options.buildInfo ?? resolveBuildInfo();
  const serviceConfigSource = resolveServiceConfigSource({
    ...(options.serviceConfigDir !== undefined ? { dir: options.serviceConfigDir } : {}),
    ...(options.serviceConfigSource !== undefined ? { explicit: options.serviceConfigSource } : {}),
  });
  if (!serviceConfigSource.ok) throw new Error(serviceConfigSource.error);

  const host = options.host ?? '127.0.0.1';
  assertLocalDevtoolsServiceBoundary(host, options);
  let gate = options.deployGate;

  const durableStoreRequested =
    options.dataDir !== undefined ||
    options.databaseUrl !== undefined ||
    options.postgresPool !== undefined;
  const postgresStoreRequested =
    options.databaseUrl !== undefined || options.postgresPool !== undefined;
  if (options.databaseUrl !== undefined && options.postgresPool !== undefined) {
    throw new Error('configure either databaseUrl or postgresPool, not both');
  }
  assertPostgresStoreOwnership(options, postgresStoreRequested);

  // Durable stores require a master-key custodian; an injected custodian takes precedence.
  let secretBox: SecretBox | undefined;
  let knowledge: ServiceOptions['knowledge'];
  if (durableStoreRequested) {
    if (options.wrappingMasterKey !== undefined) {
      secretBox = new SecretBox(options.wrappingMasterKey);
    } else if (options.secretMasterKey !== undefined) {
      secretBox = new SecretBox(staticMasterKeyProvider(options.secretMasterKey));
    } else {
      throw new Error(
        'persistence requires a secret master-key custodian; configure a wrappingMasterKey or NOODLE_SECRET_MASTER_KEY',
      );
    }
  }
  const mcpRequestState =
    options.mcpRequestState ??
    createHostedMcpRequestStateManager({
      ...(options.wrappingMasterKey === undefined && options.secretMasterKey !== undefined
        ? { secretMasterKey: options.secretMasterKey }
        : {}),
      ...(secretBox === undefined ? {} : { secretBox }),
    });
  let mcpConfirmationNonceLedger = options.mcpConfirmationNonceLedger;

  // Select exactly one durable backend: Postgres (cloud, ADR 0035) > file (local) > in-memory. The
  // Postgres modules are loaded lazily so `pg` is never pulled in on the file/in-memory paths.
  let store: ArtifactStore | undefined;
  let controlPlaneStore: ControlPlaneStore | undefined = options.controlPlaneStore;
  let configStore: ConfigStore | undefined = options.configStore;
  // Audit/event system of record (Phase 0): the Postgres module when persistence is on, else the configured
  // sink or in-memory. Under Postgres a configured sink is an additive mirror, never a replacement for the
  // transaction-capable SoR. The handler also adds the stdout mirror behind the same fan-out port.
  let auditStore: AuditSink | undefined = options.audit;
  let activityStores = configuredActivityStores(options);
  let requestEventStore: RequestEventStore | undefined = options.requestEventStore;
  let intentCaptureSettingsStore: IntentCaptureSettingsStore | undefined =
    options.intentCaptureSettingsStore;
  let intentEventStore: IntentEventStore | undefined = options.intentEventStore;
  let alertRuleStore: AlertRuleStore | undefined = options.alertRuleStore;
  let businessInformationStore: BusinessInformationStore | undefined =
    options.businessInformationStore;
  let businessInformationSourceStore: SourceIngestionStore | undefined =
    options.businessInformationSourceStore;
  const businessInformationEnabled =
    options.businessInformationEnabled ?? options.dataDir === undefined;
  const operationEvidenceEpoch =
    options.operationEvidenceEpoch ??
    options.applicationConnections?.credentialEpoch ??
    'operation-evidence-initial-v1';
  if (
    !/^[A-Za-z0-9_-]{16,128}$/.test(operationEvidenceEpoch) ||
    (options.operationEvidenceIdentityKey !== undefined &&
      Buffer.byteLength(options.operationEvidenceIdentityKey, 'utf8') < 32)
  )
    throw new Error('Invalid operation evidence configuration');
  if (
    postgresStoreRequested &&
    businessInformationEnabled &&
    options.businessInformationSourceIdentityKey === undefined &&
    options.secretMasterKey === undefined
  ) {
    throw new Error(
      'Postgres business information sources require a stable identity key; configure businessInformationSourceIdentityKey or NOODLE_BUSINESS_SOURCE_IDENTITY_KEY',
    );
  }
  if (
    options.applicationConnections &&
    (options.dataDir !== undefined ||
      !businessInformationEnabled ||
      options.connectionRuntime !== undefined)
  ) {
    throw new Error(
      'Application connections require managed application storage and exactly one service-owned runtime',
    );
  }
  if (
    options.applicationConnections &&
    options.externalCredentialExchange &&
    !('localProvider' in options.externalCredentialExchange)
  ) {
    throw new Error(
      'Application connections cannot be combined with a remote exchange unless explicitly composed through localProvider',
    );
  }
  let connectionStore: ConnectionStore | undefined;
  let operationStores = createLocalOperationStores();
  let assistantStore: AssistantStore | undefined = options.assistantStore;
  let assistantAppearance: AssistantAppearanceSettingsStore | undefined =
    options.assistantAppearance;
  let publicEmbeds: PublicEmbedStore | undefined = options.publicEmbeds;
  let admissionCounters: DailyCounterStore | undefined = options.admissionCounters;
  let elevations: AssistantElevationStore | undefined = options.elevations;
  let elevationCoordinator: AssistantElevationCoordinator | undefined =
    options.elevationCoordinator;
  let pgPool: PostgresPool | undefined = options.postgresPool;
  let moduleHost: ModuleHost | undefined;
  let googleWorkloadIdentity = options.googleWorkloadIdentity;
  let appPurgeReconciliationOperator: ServiceOptions['appPurgeReconciliationOperator'];
  const runPostgresSchemaStartupPhase = <T>(
    phase: 'core' | 'modules' | 'oauth',
    work: () => Promise<T>,
  ): Promise<T> => pgPool?.serializeSchemaStartup?.(phase, work) ?? work();
  if (postgresStoreRequested) {
    const { PostgresArtifactStore } = await import('./store/postgres.js');
    if (pgPool === undefined) {
      const { createPostgresPool } = await import('./store/cloudsql-pool.js');
      const databaseUrl = options.databaseUrl;
      if (databaseUrl === undefined) throw new Error('Postgres configuration is unavailable');
      pgPool = await createPostgresPool({ databaseUrl });
    }
    const postgresPool = pgPool.pool;
    try {
      await runPostgresSchemaStartupPhase('core', async () => {
        if (options.schemaMode === 'external') {
          await verifyPostgresSchemaContract(postgresPool);
        } else {
          const report = await initializePostgresCoreSchema(postgresPool, options, secretBox);
          warnCustomerAuthAudienceQuarantine(options.logger ?? noopLogger, report);
        }
        mcpConfirmationNonceLedger =
          mcpConfirmationNonceLedger ?? new PostgresMcpConfirmationNonceLedger(postgresPool);
        const postgres = new PostgresArtifactStore(postgresPool, {
          ...(secretBox === undefined ? {} : { secretBox }),
          deploymentActivation: () => moduleHost?.deploymentActivation ?? [],
          organizationProvisioning: () => moduleHost?.organizationProvisioning,
        });
        const { PostgresAppPurgeReconciliationOperator } = await import(
          '@noodle-borg/control-plane'
        );
        appPurgeReconciliationOperator = new PostgresAppPurgeReconciliationOperator(postgresPool);
        knowledge = await createPostgresKnowledgeStores(postgresPool, secretBox, 'external');
        if (googleWorkloadIdentity === undefined && options.oauth !== undefined) {
          const identities = new PostgresGoogleWorkloadIdentityStore(postgresPool);
          googleWorkloadIdentity = {
            issuer: options.oauth.issuer,
            signer: options.oauth.signer,
            store: identities,
          };
        }
        store = postgres;
        controlPlaneStore = controlPlaneStore ?? postgres;
        configStore = configStore ?? postgres;
        activityStores = configuredActivityStores(options, postgresPool);
        requestEventStore = requestEventStore ?? new PostgresRequestEventStore(postgresPool);
        intentCaptureSettingsStore =
          intentCaptureSettingsStore ?? new PostgresIntentCaptureSettingsStore(postgresPool);
        intentEventStore = intentEventStore ?? new PostgresIntentEventStore(postgresPool);
        alertRuleStore = alertRuleStore ?? new PostgresAlertRuleStore(postgresPool);
        if (businessInformationEnabled && businessInformationStore === undefined) {
          if (secretBox === undefined) {
            throw new Error('Postgres business information requires the service key custodian');
          }
          const payloadCipher = new SecretBoxPayloadCipher(secretBox);
          const postgresBusinessInformation = new PostgresBusinessInformationStore(
            postgresPool,
            payloadCipher,
            options.clock === undefined ? {} : { now: options.clock },
          );
          businessInformationStore = postgresBusinessInformation;
          const sourceIdentityKey =
            options.businessInformationSourceIdentityKey ?? options.secretMasterKey;
          if (businessInformationSourceStore === undefined && sourceIdentityKey !== undefined) {
            const postgresSources = new PostgresSourceIngestionStore(postgresPool, payloadCipher, {
              identityKey: sourceIdentityKey,
            });
            businessInformationSourceStore = postgresSources;
          }
        }
        if (businessInformationEnabled) {
          if (!secretBox) throw new Error('Operation evidence requires encrypted storage');
          operationStores = await createPostgresOperationStores(
            postgresPool,
            secretBox,
            'external',
          );
        }
        if (options.applicationConnections) {
          if (!secretBox) throw new Error('Connections require encrypted storage');
          const connections = new PostgresConnectionStore(postgresPool, secretBox);
          connectionStore = connections;
        }
        const assistantStores = await createPostgresAssistantStores(
          postgresPool,
          {
            assistantStore,
            assistantAppearance,
            publicEmbeds,
            admissionCounters,
            elevations,
          },
          'external',
        );
        assistantStore = assistantStores.assistantStore;
        assistantAppearance = assistantStores.assistantAppearance;
        publicEmbeds = assistantStores.publicEmbeds;
        admissionCounters = assistantStores.admissionCounters;
        elevations = assistantStores.elevations;
        if (
          elevationCoordinator === undefined &&
          options.assistantStore === undefined &&
          options.elevations === undefined
        ) {
          elevationCoordinator = new PostgresAssistantElevationCoordinator(postgresPool, {
            ...(options.clock === undefined ? {} : { now: options.clock }),
          });
        }
      });
    } catch (error) {
      await pgPool.close();
      throw error;
    }
  } else if (options.dataDir !== undefined) {
    store = new JsonFileArtifactStore(options.dataDir);
    alertRuleStore = alertRuleStore ?? new JsonFileAlertRuleStore(options.dataDir);
  }
  controlPlaneStore = controlPlaneStore ?? new InMemoryControlPlaneStore();
  configStore = configStore ?? new InMemoryConfigStore();
  if (pgPool === undefined) auditStore = auditStore ?? new InMemoryAuditStore();
  requestEventStore = requestEventStore ?? new InMemoryRequestEventStore();
  intentCaptureSettingsStore =
    intentCaptureSettingsStore ?? new InMemoryIntentCaptureSettingsStore();
  intentEventStore = intentEventStore ?? new InMemoryIntentEventStore();
  alertRuleStore = alertRuleStore ?? new InMemoryAlertRuleStore();
  if (businessInformationEnabled && businessInformationStore === undefined) {
    businessInformationStore = new InMemoryBusinessInformationStore(
      options.clock === undefined ? {} : { now: options.clock },
    );
  }
  if (
    businessInformationEnabled &&
    businessInformationStore !== undefined &&
    businessInformationSourceStore === undefined &&
    pgPool === undefined
  ) {
    businessInformationSourceStore = new InMemorySourceIngestionStore({
      identityKey: 'local-business-source-identity-key-v1',
      ...(options.clock === undefined ? {} : { now: options.clock }),
    });
  }

  // Owned telemetry buffers and timers drain through closeResources.
  const telemetry = createTelemetryRuntime(requestEventStore, intentEventStore, retentionDays, {
    ...(options.logger === undefined ? {} : { heartbeatLogger: options.logger }),
  });
  const { requestEventBuffer, intentEventBuffer } = telemetry;

  // Periodic edge-triggered alert delivery owns one timer.
  const alertEvaluator = new AlertEvaluator({
    alertRules: alertRuleStore,
    requestEvents: requestEventStore,
    allowLoopbackWebhooks: options.alertWebhookAllowLoopback === true,
    logger: options.logger ?? noopLogger,
    ...(options.clock !== undefined ? { clock: options.clock } : {}),
  });
  alertEvaluator.maybeSweep();
  const alertTimer = setInterval(() => alertEvaluator.maybeSweep(), ALERT_EVALUATION_INTERVAL_MS);
  alertTimer.unref?.();

  const operationEvidence = businessInformationEnabled
    ? {
        store: operationStores.evidence,
        coordination: operationStores.coordination,
        epoch: operationEvidenceEpoch,
        identityKey: createHash('sha256')
          .update('operation-evidence\0')
          .update(
            options.operationEvidenceIdentityKey ??
              options.businessInformationSourceIdentityKey ??
              options.secretMasterKey ??
              randomBytes(32),
          )
          .digest('hex'),
        ...(options.clock === undefined
          ? {}
          : { now: () => options.clock?.().getTime() ?? Date.now() }),
      }
    : undefined;
  let businessInformationTimer: NodeJS.Timeout | undefined;
  let stopBusinessInformationSweep: (() => void) | undefined;
  let businessInformationSourceTimer: NodeJS.Timeout | undefined;
  if (businessInformationStore !== undefined || activityStores.retention !== undefined) {
    const sweep = retentionSweepTrigger(
      [
        businessInformationStore,
        activityStores.retention,
        businessInformationSourceStore,
        operationEvidence === undefined
          ? undefined
          : {
              purgeExpired: async () => {
                await operationEvidence.store.sweep(options.clock?.().getTime() ?? Date.now());
                return 0;
              },
            },
      ],
      options.logger ?? noopLogger,
    );
    stopBusinessInformationSweep = sweep.close;
    sweep();
    businessInformationTimer = setInterval(sweep, 15 * 60 * 1000);
    businessInformationTimer.unref?.();
  }

  let welcomeEmailTimer: NodeJS.Timeout | undefined;
  if (options.welcomeEmailSender !== undefined) {
    welcomeEmailTimer = startWelcomeEmailWorker({
      store: controlPlaneStore,
      sender: options.welcomeEmailSender,
      logger: options.logger ?? noopLogger,
      ...(options.clock !== undefined ? { clock: options.clock } : {}),
    });
  }
  // Durable hosts must supply an asset adapter; only local operation has an in-memory fallback.
  const assetStore: AssetStore | undefined =
    options.assetStore ?? (durableStoreRequested ? undefined : new InMemoryAssetStore());
  const assetPublicBaseUrl = options.assetPublicBaseUrl;

  let cleanup: Promise<void> | undefined;
  const closeResources = (): Promise<void> =>
    (cleanup ??= closeServiceResources({
      telemetry,
      ...(welcomeEmailTimer === undefined ? {} : { welcomeEmailTimer }),
      ...(businessInformationTimer === undefined ? {} : { businessInformationTimer }),
      ...(stopBusinessInformationSweep === undefined ? {} : { stopBusinessInformationSweep }),
      ...(businessInformationSourceTimer === undefined ? {} : { businessInformationSourceTimer }),
      alertTimer,
      ...(moduleHost === undefined ? {} : { moduleHost }),
      ...(pgPool === undefined ? {} : { postgresPool: pgPool }),
    }));
  try {
    const bootedModules = await runPostgresSchemaStartupPhase('modules', () =>
      bootstrapServiceModules({
        inputs: options.modules,
        allowlist: options.moduleAllowlist,
        importer: options.moduleImporter,
        logger: options.logger ?? noopLogger,
        postgresPool: pgPool?.pool,
        audit: auditStore,
        ...(options.schemaMode === undefined ? {} : { schemaMode: options.schemaMode }),
        ...(options.clock === undefined ? {} : { clock: options.clock }),
      }),
    );
    const activeModuleHost = bootedModules.host;
    moduleHost = activeModuleHost;
    const loadedModules = bootedModules.loaded;

    for (const domain of options.signupAllowedDomains ?? []) {
      await controlPlaneStore.allowSignup({ kind: 'domain', value: domain });
    }
    for (const subject of options.signupAllowedSubjects ?? []) {
      await controlPlaneStore.allowSignup({ kind: 'subject', value: subject });
    }

    let registry: ServerRegistry | undefined;
    // Self-hosted authorization server (OA-2) and upstream-human boot are isolated from the service graph.
    const oauthControlPlaneStore = controlPlaneStore;
    const oauthBootstrap = await runPostgresSchemaStartupPhase('oauth', () =>
      resolveServiceOAuthBootstrap({
        options:
          activeModuleHost.authVerifier === undefined
            ? options
            : { ...options, verifyOwnerToken: activeModuleHost.authVerifier },
        ...(pgPool === undefined ? {} : { pool: pgPool.pool }),
        ...(secretBox === undefined ? {} : { secretBox }),
        controlPlaneStore: oauthControlPlaneStore,
        ...(activeModuleHost.platformHumanIdentity === undefined
          ? {}
          : { platformHumanIdentity: activeModuleHost.platformHumanIdentity }),
        registry: () => registry,
        audit: activeModuleHost.audit,
        // The control-plane exchange's issuer-liveness check: the elevating assistant client must be
        // a live client of the asserted tenant, so revoking it kills the whole exchange path.
        listAssistantClientIds: async (tenant) => {
          const clients = (await assistantStore?.listClients(tenant)) ?? [];
          return clients
            .filter((client) => client.revokedAt === undefined)
            .map((client) => client.id);
        },
      }),
    );
    const {
      authServerApp,
      verifyOwnerToken: resolvedVerifyOwnerToken,
      authServerIssuer: resolvedAuthServerIssuer,
      oauthStore,
      developerGrantStore,
      servicePrincipalRuntime,
      oauthClientCredentialsReady,
      delegatedExchange,
      rawCustomerVerifierFactory,
      hostedCustomerVerifierFactory,
    } = oauthBootstrap;
    const localDevtoolsDelegatedCredentialSource =
      oauthStore === undefined &&
      (options.localDevtoolsDirectFirebaseAuth === true ||
        options.localDevtoolsDirectMicrosoftAuth === true)
        ? createLocalDevtoolsDelegatedCredentialSource()
        : undefined;
    const delegatedCredentialStore = oauthStore ?? localDevtoolsDelegatedCredentialSource?.store;

    if (googleWorkloadIdentity === undefined && options.oauth !== undefined) {
      googleWorkloadIdentity = {
        issuer: options.oauth.issuer,
        signer: options.oauth.signer,
        store: new InMemoryGoogleWorkloadIdentityStore(),
      };
    }

    if (gate === undefined) {
      // Noodle tokens lead temporary human-Google compatibility and the exact-subject workload gate.
      gate = createDefaultControlPlaneGate({
        options,
        ...(oauthStore === undefined ? {} : { oauthStore }),
        controlPlaneStore,
        ...(resolvedVerifyOwnerToken === undefined
          ? {}
          : { verifyOwnerToken: resolvedVerifyOwnerToken }),
        ...(resolvedAuthServerIssuer === undefined
          ? {}
          : { authServerIssuer: resolvedAuthServerIssuer }),
        ...(activeModuleHost.platformHumanIdentity?.principalResolver === undefined
          ? {}
          : {
              platformPrincipalResolver: activeModuleHost.platformHumanIdentity.principalResolver,
            }),
      });
    }

    // Fail closed: never expose an unauthenticated deploy endpoint on a non-loopback bind.
    if (gate === undefined && !isLoopbackHost(host)) {
      throw new Error(
        `refusing to bind a non-loopback host (${host}) without deploy authentication; ` +
          'configure the Noodle OAuth issuer and an upstream-human provider, NOODLE_GOOGLE_CLIENT_ID, or a deployGate',
      );
    }
    // `local` is a system-owned loopback namespace even when loopback auth is enabled.
    if (isLoopbackHost(host)) {
      await controlPlaneStore.createOrg({ slug: 'local', displayName: 'Local' });
    }

    const connectionRuntime =
      options.applicationConnections && businessInformationStore
        ? createApplicationConnections({
            ...options.applicationConnections,
            audit: activeModuleHost.audit,
            store: connectionStore ?? new InMemoryConnectionStore(),
            installations: businessInformationStore,
            getRegistry: () => {
              if (!registry) throw new Error('Application registry is unavailable');
              return registry;
            },
          })
        : options.connectionRuntime;
    const sourceAuthority = sourceConfigurationAuthority(() => {
      if (!registry) throw new Error('Registry unavailable');
      return registry;
    }, connectionRuntime?.sourceCredentials);
    if (businessInformationSourceStore)
      businessInformationSourceStore = fenceSourceStore(
        businessInformationSourceStore,
        sourceAuthority,
      );
    const externalCredentialExchange =
      options.externalCredentialExchange ??
      (connectionRuntime ? { localProvider: connectionRuntime.localProvider } : undefined);
    registry = new ServerRegistry(store, secretBox, configStore, {
      customerVerifierFactory:
        options.localDevtoolsDirectFirebaseAuth === true ||
        options.localDevtoolsDirectMicrosoftAuth === true
          ? createLocalDevtoolsCustomerVerifierFactory(rawCustomerVerifierFactory, {
              allowedProviders: [
                ...(options.localDevtoolsDirectFirebaseAuth === true ? ['firebase' as const] : []),
                ...(options.localDevtoolsDirectMicrosoftAuth === true
                  ? ['microsoft' as const]
                  : []),
              ],
              ...(options.localDevtoolsResolveBridgeAuth === undefined
                ? {}
                : { resolveBridgeAuth: options.localDevtoolsResolveBridgeAuth }),
            })
          : hostedCustomerVerifierFactory,
      ...(moduleHost.policyGate !== undefined ? { policyGate: moduleHost.policyGate } : {}),
      ...(pgPool === undefined ? {} : { transactionalModuleDeploymentActivation: true }),
      ...(delegatedCredentialStore !== undefined
        ? {
            delegatedCredentialStore,
            sealCustomerCredential: (credential: string) =>
              sealCustomerCredential(secretBox, credential),
            openCustomerCredential: (credential: SecretEnvelope) =>
              openCustomerCredential(secretBox, credential),
          }
        : {}),
      ...(delegatedExchange !== undefined ? { delegatedExchange } : {}),
      ...(options.localDevtoolsDelegatedExchange === undefined
        ? {}
        : { localDevtoolsDelegatedExchange: options.localDevtoolsDelegatedExchange }),
      ...(externalCredentialExchange === undefined ? {} : { externalCredentialExchange }),
      ...(googleWorkloadIdentity === undefined
        ? {}
        : {
            googleWorkloadIdentity: {
              issuer: googleWorkloadIdentity.issuer,
              signer: googleWorkloadIdentity.signer,
              identities: googleWorkloadIdentity.store,
            },
          }),
      ...(pgPool !== undefined
        ? {
            stateHandleStoreFactory: ({ deploymentId, state }) =>
              new PostgresStateHandleStore(pgPool.pool, { deploymentId, state }),
          }
        : {}),
    });
    // Recovery is lazy by default (ADR 0036): each server recompiles on its first request, which is correct
    // on a multi-instance platform (any instance serves any deploy) and a cheaper cold start. `warmAll` opts
    // into eager recompile-all-on-boot (boot-time validation of every server, for a pinned/on-prem instance).
    const recovered = store && options.warmAll ? await registry.recover() : undefined;

    if (businessInformationSourceStore !== undefined && businessInformationStore !== undefined) {
      const sourceCoordinator = new SourceIngestionCoordinator({
        store: businessInformationSourceStore,
        executor:
          options.businessInformationSourceExecutor ??
          new RegistrySourceReadExecutor(
            registry,
            businessInformationStore,
            (target) =>
              resolveApplicationRuntimeTarget(
                target,
                undefined,
                connectionRuntime?.readGenerations,
              ),
            sourceAuthority,
          ),
        workerId: 'service-source-ingestion',
        validateRecord: (_binding, value) => validateManagedPayload(value),
        ...(options.clock === undefined ? {} : { now: options.clock }),
      });
      const sweepSources = (): void => {
        void drainSourceIngestion(sourceCoordinator).catch((error: unknown) => {
          (options.logger ?? noopLogger).error('business_information.source.failed', {
            name: error instanceof Error ? error.name : 'unknown',
            code:
              typeof error === 'object' &&
              error !== null &&
              'code' in error &&
              typeof error.code === 'string'
                ? error.code
                : 'source_scan_failed',
          });
        });
      };
      sweepSources();
      businessInformationSourceTimer = setInterval(sweepSources, 30_000);
      businessInformationSourceTimer.unref?.();
    }

    // Readiness reflects durable-store reachability. Built here so the handler never imports `pg`; a
    // file/in-memory deployment is always ready.
    const readinessProbe: () => Promise<boolean> = pgPool
      ? async () => {
          try {
            await pgPool.pool.query('SELECT 1');
            return true;
          } catch {
            return false;
          }
        }
      : async () => true;
    const {
      appPurgeReconciliationOperator: ignoredDirectReconciliationOperator,
      ...handlerBaseOptions
    } = options;
    void ignoredDirectReconciliationOperator;
    const handlerOptions: ServiceOptions = {
      ...handlerBaseOptions,
      ...(operationEvidence === undefined ? {} : { operationEvidence }),
      ...(connectionRuntime === undefined ? {} : { connectionRuntime }),
      ...(knowledge === undefined ? {} : { knowledge }),
      ...(businessInformationStore === undefined ? {} : { businessInformationStore }),
      ...(businessInformationSourceStore === undefined ? {} : { businessInformationSourceStore }),
      businessInformationEnabled,
      ...(googleWorkloadIdentity === undefined ? {} : { googleWorkloadIdentity }),
      readinessProbe,
      controlPlaneStore,
      ...(developerGrantStore !== undefined ? { developerGrantStore } : {}),
      ...(servicePrincipalRuntime !== undefined ? { servicePrincipalRuntime } : {}),
      ...(oauthClientCredentialsReady ? { oauthClientCredentialsReady: true } : {}),
      configStore,
      ...(auditStore !== undefined ? { audit: auditStore } : {}),
      loadedModules,
      // Tenant-safe developer logs (M3, ADR 0101): default to an in-memory store so `noodle logs` works on
      // every booted service; durable (Postgres) retention is a follow-up that keeps the same record shape.
      userAppLogStore: options.userAppLogStore ?? new InMemoryUserAppLogStore(),
      ...(activityStores.capture ? { activityOutbox: activityStores.capture } : {}),
      requestEventStore,
      intentCaptureSettingsStore,
      intentEventStore,
      alertRuleStore,
      ...assistantStoreOptions({
        assistantStore,
        assistantAppearance,
        publicEmbeds,
        admissionCounters,
        elevations,
      }),
      ...(elevationCoordinator === undefined ? {} : { elevationCoordinator }),
      ...(mcpRequestState === undefined ? {} : { mcpRequestState }),
      ...(mcpConfirmationNonceLedger === undefined ? {} : { mcpConfirmationNonceLedger }),
      captureRequestEvent:
        options.captureRequestEvent ?? ((event) => requestEventBuffer.capture(event)),
      captureIntentEvent:
        options.captureIntentEvent ?? ((event) => intentEventBuffer.capture(event)),
      buildInfo,
      ...(appPurgeReconciliationOperator === undefined ? {} : { appPurgeReconciliationOperator }),
      ...(assetStore !== undefined ? { assetStore } : {}),
      ...(assetPublicBaseUrl !== undefined ? { assetPublicBaseUrl } : {}),
      ...(options.googleClientId !== undefined
        ? { controlPlaneGoogleClientId: options.googleClientId }
        : {}),
      ...(gate ? { deployGate: gate } : {}),
      ...(resolvedVerifyOwnerToken ? { verifyOwnerToken: resolvedVerifyOwnerToken } : {}),
      ...(resolvedAuthServerIssuer ? { authServerIssuer: resolvedAuthServerIssuer } : {}),
      ...(authServerApp ? { authServerApp } : {}),
    };
    let http: Server | undefined;
    try {
      const listeningHttp = createServer(createServiceHandler(registry, handlerOptions));
      http = listeningHttp;
      await listenHttpServer(listeningHttp, options.port ?? 8787, host);
      const { port } = listeningHttp.address() as AddressInfo;
      const urlHost = host.includes(':') ? `[${host}]` : host;
      const serviceUrl = `http://${urlHost}:${port}`;
      const localDevtoolsDelegatedCredentials =
        localDevtoolsDelegatedCredentialSource?.bind(serviceUrl);
      return {
        http: listeningHttp,
        url: serviceUrl,
        port,
        registry,
        ...(recovered ? { recovered } : {}),
        ...(localDevtoolsDelegatedCredentials === undefined
          ? {}
          : { localDevtoolsDelegatedCredentials }),
        close: async () => {
          await closeHttpServer(listeningHttp);
          await closeResources();
        },
      };
    } catch (error) {
      if (http?.listening) await closeHttpServer(http).catch(() => undefined);
      await closeResources();
      throw error;
    }
  } catch (error) {
    await closeResources();
    throw error;
  }
}
