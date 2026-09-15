import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

function verify(missingInsert = false) {
  const dir = mkdtempSync(join(tmpdir(), 'core-database-verify-'));
  mkdirSync(join(dir, 'infra/cloudrun'), { recursive: true });
  mkdirSync(join(dir, 'packages/service/node_modules/pg'), { recursive: true });
  cpSync(new URL('database.mjs', import.meta.url), join(dir, 'infra/cloudrun/database.mjs'));
  writeFileSync(join(dir, 'packages/service/package.json'), '{}');
  writeFileSync(
    join(dir, 'packages/service/node_modules/pg/index.js'),
    `exports.Client=class {
 on(){} async connect(){} async end(){}
 async query(sql,values){
  if(/GRANT|REVOKE|CREATE ROLE/.test(sql))throw Error('Persistent SQL mutation forbidden');
  if(sql.includes('current_user AS name'))return {rows:[{name:'runtime_app'}]};
  if(sql.includes('AS ddl'))return {rows:[{ddl:false,dbcreate:false}]};
  if(sql.includes('AS can_read'))return {rows:[{can_read:true,can_write:false}]};
  if(sql.includes('SELECT *'))return {rows:[{version:1}]};
  if(sql.includes('pg_tables'))return {rows:[{tablename:'noodle_schema_contract'},{tablename:'deployments'}]};
  if(sql.includes('AS can_select')){const marker=values[0].endsWith('noodle_schema_contract');return {rows:[{can_select:true,can_dml:!marker,can_insert:!marker&&process.env.MISSING_INSERT!=='true',can_update:!marker,can_delete:!marker}]};}
  throw Error('Unexpected query');
 }
};`,
  );
  const cloud = join(dir, 'gcloud');
  writeFileSync(
    cloud,
    `#!${process.execPath}\nconsole.log('postgresql://runtime_app:private-password@localhost/runtime?host=/cloudsql/example');`,
    { mode: 0o700 },
  );
  const result = spawnSync(process.execPath, ['infra/cloudrun/database.mjs'], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      ...process.env,
      GCLOUD: cloud,
      GCP_PROJECT_ID: 'example',
      GCP_SQL_INSTANCE_CONNECTION_NAME: 'example:region:sql',
      GCP_RUNTIME_APPLICATION_URL_SECRET: 'runtime-app-url',
      GCP_RUNTIME_APPLICATION_DB_ROLE: 'runtime_app',
      MISSING_INSERT: String(missingInsert),
    },
  });
  rmSync(dir, { recursive: true, force: true });
  return result;
}

test('all existing application table permissions pass without grant changes', () => {
  const result = verify();
  assert.equal(result.status, 0, result.stderr);
});

test('one missing DML privilege fails without exposing the URL', () => {
  const result = verify(true);
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stdout + result.stderr, /private-password|postgresql:/);
});
