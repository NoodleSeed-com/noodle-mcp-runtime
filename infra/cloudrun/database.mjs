/** Verify the existing runtime application grants through a runner-local Cloud SQL Auth Proxy. */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const { Client } = createRequire(new URL('../../packages/service/package.json', import.meta.url))(
  'pg',
);
function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}
function secret(name, project) {
  const result = spawnSync(
    process.env.GCLOUD ?? 'gcloud',
    [
      'secrets',
      'versions',
      'access',
      'latest',
      `--secret=${name}`,
      `--project=${project}`,
      '--quiet',
    ],
    { encoding: 'utf8', maxBuffer: 1024 * 1024 },
  );
  if (result.status !== 0) throw new Error('Database secret access failed; output suppressed');
  return result.stdout.trim();
}
function local(value) {
  const url = new URL(value);
  url.hostname = '127.0.0.1';
  url.port = '55433';
  url.searchParams.delete('host');
  return url.href;
}
try {
  const project = required('GCP_PROJECT_ID'),
    secretName = required('GCP_RUNTIME_APPLICATION_URL_SECRET'),
    role = required('GCP_RUNTIME_APPLICATION_DB_ROLE');
  required('GCP_SQL_INSTANCE_CONNECTION_NAME');
  if (!/^[a-z_][a-z0-9_]*$/.test(role)) throw new Error('Invalid application database role');
  const application = new Client({
    connectionString: local(secret(secretName, project)),
    connectionTimeoutMillis: 5000,
  });
  application.on('error', () => undefined);
  await application.connect();
  try {
    const identity = await application.query('SELECT current_user AS name');
    if (identity.rows[0]?.name !== role) throw new Error('Actual application role was not used');
    const scope = await application.query(
      "SELECT has_schema_privilege(current_user,'public','CREATE') AS ddl, has_database_privilege(current_user,current_database(),'CREATE') AS dbcreate",
    );
    if (scope.rows[0].ddl || scope.rows[0].dbcreate)
      throw new Error('Application role has DDL authority');
    const marker = await application.query(
      "SELECT has_table_privilege(current_user,'public.noodle_schema_contract','SELECT') AS can_read, has_table_privilege(current_user,'public.noodle_schema_contract','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS can_write",
    );
    if (!marker.rows[0].can_read || marker.rows[0].can_write)
      throw new Error('Schema marker is not SELECT-only');
    await application.query('SELECT * FROM public.noodle_schema_contract LIMIT 1');
    const tables = await application.query(
      "SELECT tablename FROM pg_tables WHERE schemaname='public'",
    );
    for (const { tablename } of tables.rows) {
      if (!/^[a-z_][a-z0-9_]*$/.test(tablename)) throw new Error('Unexpected runtime table name');
      const privileges = await application.query(
        "SELECT has_table_privilege(current_user,$1,'SELECT') AS can_select, has_table_privilege(current_user,$1,'INSERT') AS can_insert, has_table_privilege(current_user,$1,'UPDATE') AS can_update, has_table_privilege(current_user,$1,'DELETE') AS can_delete",
        [`public.${tablename}`],
      );
      if (
        !privileges.rows[0].can_select ||
        ['can_insert', 'can_update', 'can_delete'].some(
          (permission) =>
            privileges.rows[0][permission] !== (tablename !== 'noodle_schema_contract'),
        )
      )
        throw new Error('Runtime table privilege drift');
    }
  } finally {
    await application.end();
  }
  console.log('Existing runtime application DML and SELECT-only schema marker verified');
} catch (error) {
  console.error(
    `Runtime database verification failed (SQLSTATE ${/^[A-Z0-9]{5}$/.test(error.code ?? '') ? error.code : 'unavailable'}); secret-bearing details suppressed`,
  );
  process.exitCode = 1;
}
