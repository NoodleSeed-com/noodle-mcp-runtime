/** Credential-free readiness and immutable source identity check. */
try {
  const [origin, sha, ...extra] = process.argv.slice(2);
  if (extra.length || !origin || !/^[a-f0-9]{40}$/.test(sha ?? ''))
    throw new Error('Usage: smoke.mjs origin source-sha');
  const request = (path) =>
    fetch(new URL(path, origin), { redirect: 'error', signal: AbortSignal.timeout(30000) });
  const ready = await request('/readyz');
  if (ready.status !== 200) throw new Error('Runtime readiness smoke failed');
  const info = await request('/v1/service/info'),
    body = await info.json();
  if (info.status !== 200 || body.gitSha !== sha)
    throw new Error('Runtime source identity smoke failed');
  console.log(JSON.stringify({ ready: true, sourceSha: sha }));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
