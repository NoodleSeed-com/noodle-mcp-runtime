/** Generic dev-branch Cloud Run deployment. Configuration comes only from GitHub environment variables. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};
const project = required('GCP_PROJECT_ID'),
  region = required('GCP_REGION');
const repository = required('GCP_ARTIFACT_REGISTRY_REPOSITORY'),
  sourceBucket = required('GCP_CLOUD_BUILD_SOURCE_BUCKET');
const buildAccount = required('GCP_CLOUD_BUILD_SERVICE_ACCOUNT'),
  service = required('GCP_RUNTIME_SERVICE');
const migrationJob = required('GCP_RUNTIME_MIGRATION_JOB'),
  nodeImage = required('GCP_NODE_BUILD_IMAGE');
const output = '.superpowers/sdd/core-dev';
function command(program, args, { json = false } = {}) {
  const result = spawnSync(program, args, {
    encoding: 'utf8',
    stdio: json ? 'pipe' : 'inherit',
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.status !== 0)
    throw new Error(`${program} ${args.slice(0, 3).join(' ')} failed; output suppressed`);
  return json ? JSON.parse(result.stdout) : undefined;
}
function git(args) {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error('Source revision could not be verified');
  return result.stdout.trim();
}
function gcloud(args, { json = true } = {}) {
  return command(process.env.GCLOUD ?? 'gcloud', [...args, `--project=${project}`, '--quiet'], {
    json,
  });
}
function container(resource) {
  return (
    resource?.spec?.template?.spec?.template?.spec?.containers?.[0] ??
    resource?.spec?.template?.spec?.containers?.[0] ??
    resource?.template?.template?.containers?.[0]
  );
}
function account(resource) {
  return (
    resource?.spec?.template?.spec?.template?.spec?.serviceAccountName ??
    resource?.spec?.template?.spec?.serviceAccountName ??
    resource?.template?.template?.serviceAccount
  );
}
try {
  if (
    process.env.GITHUB_REPOSITORY !== 'NoodleSeed-com/noodle-mcp-runtime' ||
    process.env.GITHUB_REF !== 'refs/heads/dev' ||
    !['push', 'workflow_dispatch'].includes(process.env.GITHUB_EVENT_NAME ?? '')
  )
    throw new Error('The dev branch deployment workflow is required');
  const sha = process.env.GITHUB_SHA;
  if (
    !/^[a-f0-9]{40}$/.test(sha ?? '') ||
    git(['rev-parse', 'HEAD']) !== sha ||
    git(['status', '--porcelain', '--untracked-files=no'])
  )
    throw new Error('Source tree is not the requested clean revision');
  if (git(['ls-remote', 'origin', 'refs/heads/dev']).split(/\s/)[0] !== sha)
    throw new Error('Dev advanced; run the newer revision');
  if (!nodeImage.includes('@sha256:')) throw new Error('GCP_NODE_BUILD_IMAGE must be immutable');
  mkdirSync(output, { recursive: true });
  const archive = resolve(output, 'source.tar.gz');
  command('git', ['archive', '--format=tar.gz', `--output=${archive}`, sha]);
  const archiveSha256 = createHash('sha256').update(readFileSync(archive)).digest('hex');
  const image = `${region}-docker.pkg.dev/${project}/${repository}/core-service:${sha}`;
  const buildConfig = {
    steps: [
      {
        name: 'gcr.io/cloud-builders/docker',
        args: [
          'build',
          '--target=service-runtime',
          '--file=Dockerfile',
          `--build-arg=NODE_IMAGE=${nodeImage}`,
          `--build-arg=GIT_SHA=${sha}`,
          `--build-arg=BUILD_TIME=${new Date().toISOString()}`,
          `--tag=${image}`,
          '.',
        ],
      },
    ],
    images: [image],
    timeout: '1800s',
    options: { logging: 'CLOUD_LOGGING_ONLY', machineType: 'E2_HIGHCPU_8' },
    serviceAccount: `projects/${project}/serviceAccounts/${buildAccount}`,
  };
  const configPath = resolve(output, 'cloudbuild.json');
  writeFileSync(configPath, `${JSON.stringify(buildConfig, null, 2)}\n`);
  const sourceUri = `gs://${sourceBucket}/core/${sha}-${archiveSha256}.tar.gz`;
  gcloud(['storage', 'cp', archive, sourceUri, '--no-clobber'], { json: false });
  const submitted = gcloud([
    'builds',
    'submit',
    sourceUri,
    `--config=${configPath}`,
    `--region=${region}`,
    `--gcs-source-staging-dir=gs://${sourceBucket}/staging`,
    '--async',
    '--format=json',
  ]);
  if (!submitted.id) throw new Error('Cloud Build identifier missing');
  const deadline = Date.now() + 32 * 60_000;
  let build;
  for (;;) {
    build = gcloud(['builds', 'describe', submitted.id, `--region=${region}`, '--format=json']);
    if (build.status === 'SUCCESS') break;
    if (!['QUEUED', 'PENDING', 'WORKING'].includes(build.status) || Date.now() > deadline)
      throw new Error(`Image build did not complete: ${build.status}`);
    await new Promise((resolve) => setTimeout(resolve, 10000));
  }
  const built = build.results?.images?.find((row) => row.name === image);
  if (!built || !/^sha256:[a-f0-9]{64}$/.test(built.digest ?? ''))
    throw new Error('Immutable build image evidence missing');
  const immutable = `${image.slice(0, image.lastIndexOf(':'))}@${built.digest}`;
  const receipt = {
    sourceSha: sha,
    archiveSha256,
    sourceUri,
    buildId: submitted.id,
    image: immutable,
  };
  writeFileSync(resolve(output, 'build-receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);

  const existingJob = gcloud([
    'run',
    'jobs',
    'describe',
    migrationJob,
    `--region=${region}`,
    '--format=json',
  ]);
  const migrationAccount = account(existingJob),
    existingContainer = container(existingJob);
  if (
    !migrationAccount ||
    JSON.stringify(existingContainer?.command) !== JSON.stringify(['node']) ||
    JSON.stringify(existingContainer?.args) !== JSON.stringify(['dist/main.js', 'migrate'])
  )
    throw new Error('Existing migration job identity or command is invalid');
  if (git(['ls-remote', 'origin', 'refs/heads/dev']).split(/\s/)[0] !== sha)
    throw new Error('Dev advanced; run the newer revision');
  gcloud([
    'run',
    'jobs',
    'update',
    migrationJob,
    `--region=${region}`,
    `--image=${immutable}`,
    '--format=json',
  ]);
  const execution = gcloud([
    'run',
    'jobs',
    'execute',
    migrationJob,
    `--region=${region}`,
    '--wait',
    '--format=json',
  ]);
  const executionContainer = container(execution);
  if (
    !execution?.status?.conditions?.some(
      (condition) => condition.type === 'Completed' && condition.status === 'True',
    ) ||
    account(execution) !== migrationAccount ||
    executionContainer?.image !== immutable ||
    JSON.stringify(executionContainer.command) !== JSON.stringify(['node']) ||
    JSON.stringify(executionContainer.args) !== JSON.stringify(['dist/main.js', 'migrate'])
  )
    throw new Error('Completed migration execution evidence is invalid');
  writeFileSync(
    resolve(output, 'migration-receipt.json'),
    `${JSON.stringify(
      {
        job: migrationJob,
        execution: execution.metadata?.name,
        image: immutable,
        serviceAccount: migrationAccount,
        complete: true,
      },
      null,
      2,
    )}\n`,
  );
  command(process.execPath, ['infra/cloudrun/database.mjs']);

  const existingService = gcloud([
    'run',
    'services',
    'describe',
    service,
    `--region=${region}`,
    '--format=json',
  ]);
  const serviceAccount = account(existingService);
  if (!serviceAccount) throw new Error('Existing runtime service account is missing');
  const updated = gcloud([
    'run',
    'services',
    'update',
    service,
    `--region=${region}`,
    `--image=${immutable}`,
    '--format=json',
  ]);
  if (
    !updated?.status?.conditions?.some(
      (condition) => condition.type === 'Ready' && condition.status === 'True',
    )
  )
    throw new Error('Runtime service did not report ready');
  if (account(updated) !== serviceAccount || container(updated)?.image !== immutable)
    throw new Error('Runtime service image or identity differs after update');
  const url = updated.status?.url;
  if (!url) throw new Error('Runtime service URL missing');
  command(process.execPath, ['infra/cloudrun/smoke.mjs', url, sha]);
  writeFileSync(
    resolve(output, 'deployment-receipt.json'),
    `${JSON.stringify({ ...receipt, service, url, serviceAccount, ready: true }, null, 2)}\n`,
  );
  console.log(JSON.stringify({ service, image: immutable, sourceSha: sha, ready: true }));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
