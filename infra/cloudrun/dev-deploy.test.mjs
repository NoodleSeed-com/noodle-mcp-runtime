import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const sha = 'a'.repeat(40),
  digest = `sha256:${'d'.repeat(64)}`;
function run({ ref = 'refs/heads/dev', remote = sha, remoteAfterBuild, dirty = '', failAt } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'core-dev-deploy-'));
  mkdirSync(join(dir, 'infra/cloudrun'), { recursive: true });
  mkdirSync(join(dir, 'bin'));
  cpSync(new URL('dev-deploy.mjs', import.meta.url), join(dir, 'infra/cloudrun/dev-deploy.mjs'));
  writeFileSync(
    join(dir, 'infra/cloudrun/database.mjs'),
    `import {appendFileSync} from 'node:fs';appendFileSync(process.env.CALLS,'database\\n');if(process.env.FAIL_AT==='database')process.exit(9);`,
  );
  writeFileSync(
    join(dir, 'infra/cloudrun/smoke.mjs'),
    `import {appendFileSync} from 'node:fs';appendFileSync(process.env.CALLS,'smoke\\n');`,
  );
  writeFileSync(
    join(dir, 'bin/git'),
    `#!${process.execPath}\nimport {existsSync,writeFileSync} from 'node:fs';const a=process.argv.slice(2);if(a[0]==='rev-parse')console.log(process.env.HEAD_SHA);else if(a[0]==='status')console.log(process.env.DIRTY);else if(a[0]==='ls-remote')console.log((existsSync('.superpowers/sdd/core-dev/build-receipt.json')?process.env.REMOTE_AFTER_BUILD:process.env.REMOTE_SHA)+'\\trefs/heads/dev');else if(a[0]==='archive'){const out=a.find(v=>v.startsWith('--output=')).slice(9);writeFileSync(out,'tracked source only');}else process.exit(2);`,
    { mode: 0o700 },
  );
  writeFileSync(
    join(dir, 'bin/gcloud'),
    `#!${process.execPath}\nimport {appendFileSync} from 'node:fs';const a=process.argv.slice(2);appendFileSync(process.env.CALLS,JSON.stringify(a)+'\\n');const key=a.slice(0,3).join(':');if(process.env.FAIL_AT===key){console.error('postgres://credential-that-must-stay-private');process.exit(9);}if(a[0]==='builds'&&a[1]==='submit')console.log(JSON.stringify({id:'build-1'}));else if(a[0]==='builds'&&a[1]==='describe')console.log(JSON.stringify({id:'build-1',status:'SUCCESS',results:{images:[{name:'us-central1-docker.pkg.dev/example-project/runtime/core-service:'+process.env.HEAD_SHA,digest:${JSON.stringify(digest)}}]}}));else if(a[0]==='run'&&a[1]==='services'&&a[2]==='describe')console.log(JSON.stringify({spec:{template:{spec:{serviceAccountName:'runtime@example.iam.gserviceaccount.com'}}}}));else if(a[0]==='run'&&a[1]==='jobs'&&a[2]==='describe')console.log(JSON.stringify({spec:{template:{spec:{template:{spec:{serviceAccountName:'migrate@example.iam.gserviceaccount.com',containers:[{image:'old@sha256:${'e'.repeat(64)}',command:['node'],args:['dist/main.js','migrate']}]}}}}}}));else if(a[0]==='run'&&a[1]==='jobs'&&a[2]==='execute')console.log(JSON.stringify({metadata:{name:'migration-1'},status:{conditions:[{type:'Completed',status:'True'}]},spec:{template:{spec:{serviceAccountName:'migrate@example.iam.gserviceaccount.com',containers:[{image:'us-central1-docker.pkg.dev/example-project/runtime/core-service@${digest}',command:['node'],args:['dist/main.js','migrate']}]}}}}));else if(a[0]==='run'&&a[1]==='services'&&a[2]==='update')console.log(JSON.stringify({spec:{template:{spec:{serviceAccountName:'runtime@example.iam.gserviceaccount.com',containers:[{image:'us-central1-docker.pkg.dev/example-project/runtime/core-service@${digest}'}]}}},status:{conditions:[{type:'Ready',status:'True'}],url:'https://runtime.example'}}));else console.log('{}');`,
    { mode: 0o700 },
  );
  const calls = join(dir, 'calls');
  const env = {
    ...process.env,
    PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
    GCLOUD: join(dir, 'bin/gcloud'),
    CALLS: calls,
    FAIL_AT: failAt ?? '',
    HEAD_SHA: sha,
    REMOTE_SHA: remote,
    REMOTE_AFTER_BUILD: remoteAfterBuild ?? remote,
    DIRTY: dirty,
    GITHUB_REPOSITORY: 'NoodleSeed-com/noodle-mcp-runtime',
    GITHUB_REF: ref,
    GITHUB_SHA: sha,
    GITHUB_EVENT_NAME: 'push',
    GCP_PROJECT_ID: 'example-project',
    GCP_REGION: 'us-central1',
    GCP_ARTIFACT_REGISTRY_REPOSITORY: 'runtime',
    GCP_CLOUD_BUILD_SOURCE_BUCKET: 'source-bucket',
    GCP_CLOUD_BUILD_SERVICE_ACCOUNT: 'build@example.iam.gserviceaccount.com',
    GCP_RUNTIME_SERVICE: 'runtime',
    GCP_RUNTIME_MIGRATION_JOB: 'runtime-migrate',
    GCP_SQL_INSTANCE_CONNECTION_NAME: 'example-project:us-central1:db',
    GCP_RUNTIME_APPLICATION_URL_SECRET: 'runtime-app-url',
    GCP_RUNTIME_APPLICATION_DB_ROLE: 'runtime_app',
    GCP_NODE_BUILD_IMAGE: `node:24-slim@sha256:${'f'.repeat(64)}`,
  };
  const result = spawnSync(process.execPath, ['infra/cloudrun/dev-deploy.mjs'], {
    cwd: dir,
    encoding: 'utf8',
    env,
  });
  return {
    dir,
    result,
    calls: () =>
      readFileSync(calls, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => (['database', 'smoke'].includes(line) ? line : JSON.parse(line))),
  };
}

test('wrong branch and stale SHA stop before source upload', () => {
  for (const options of [{ ref: 'refs/heads/main' }, { remote: 'b'.repeat(40) }]) {
    const s = run(options);
    try {
      assert.equal(s.result.status, 1);
      assert.throws(s.calls, /ENOENT/);
    } finally {
      rmSync(s.dir, { recursive: true, force: true });
    }
  }
});

test('builds one service image, migrates and verifies grants, then updates only the service image', () => {
  const s = run();
  try {
    assert.equal(s.result.status, 0, s.result.stderr);
    const calls = s.calls();
    const serviceUpdate = calls.find(
      (a) => Array.isArray(a) && a[0] === 'run' && a[1] === 'services' && a[2] === 'update',
    );
    assert.ok(
      serviceUpdate.some(
        (v) =>
          v === `--image=us-central1-docker.pkg.dev/example-project/runtime/core-service@${digest}`,
      ),
    );
    assert.ok(
      !serviceUpdate.some((v) => /env|secret|service-account|allow-unauthenticated/.test(v)),
    );
    assert.ok(calls.indexOf('database') < calls.indexOf(serviceUpdate));
    const buildConfig = JSON.parse(
      readFileSync(join(s.dir, '.superpowers/sdd/core-dev/cloudbuild.json')),
    );
    assert.equal(buildConfig.steps.length, 1);
    assert.ok(buildConfig.steps[0].args.includes('--target=service-runtime'));
    assert.equal(
      readFileSync(join(s.dir, '.superpowers/sdd/core-dev/source.tar.gz'), 'utf8'),
      'tracked source only',
    );
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test('migration or grant failure stops before the service update', () => {
  const s = run({ failAt: 'database' });
  try {
    assert.equal(s.result.status, 1);
    assert.ok(
      !s
        .calls()
        .some(
          (a) => Array.isArray(a) && a[0] === 'run' && a[1] === 'services' && a[2] === 'update',
        ),
    );
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test('a newer push during build blocks before migration update', () => {
  const s = run({ remoteAfterBuild: 'b'.repeat(40) });
  try {
    assert.equal(s.result.status, 1);
    assert.match(s.result.stderr, /advanced/);
    assert.ok(!s.calls().some((a) => Array.isArray(a) && a[0] === 'run' && a[2] === 'update'));
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test('dirty tracked source stops before upload', () => {
  const s = run({ dirty: ' M package.json' });
  try {
    assert.equal(s.result.status, 1);
    assert.match(s.result.stderr, /clean revision/);
    assert.throws(s.calls, /ENOENT/);
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test('migration command failure stops before runtime update and suppresses credential output', () => {
  const s = run({ failAt: 'run:jobs:execute' });
  try {
    assert.equal(s.result.status, 1);
    assert.doesNotMatch(s.result.stdout + s.result.stderr, /credential-that-must-stay-private/);
    assert.ok(!s.calls().includes('database'));
    assert.ok(
      !s
        .calls()
        .some(
          (a) => Array.isArray(a) && a[0] === 'run' && a[1] === 'services' && a[2] === 'update',
        ),
    );
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});
