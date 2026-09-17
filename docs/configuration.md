# Configure self-hosted Noodle Core

**Owns:** Accepted self-host environment values, secret classification, OAuth groups, and reconciliation rules.
**Read when:** Reviewing or changing `.self-host/.env` for the local Compose profile.
**Do not put here:** Deployment procedures, app variables/secrets, or Noodle Seed Cloud configuration.
**Update when:** The initializer or `apps/self-host` accepts, derives, or rejects an environment value.

Run `noodle service init --profile open-core --compose` from the repository root. It creates canonical operator
state in `.self-host/.env`, then derives three service-specific `0600` files. Edit only the canonical file and
rerun the same initializer; do not edit `.env.postgres`, `.env.noodle`, or `.env.operator` directly.

## Generated core values

| Value | Secret | Consumer | Contract |
| :--- | :---: | :--- | :--- |
| `POSTGRES_DB` | No | PostgreSQL | Generated as `noodle`. |
| `POSTGRES_USER` | No | PostgreSQL | Generated as `noodle`. |
| `POSTGRES_PASSWORD` | Yes | PostgreSQL | URI-safe generated password; also embedded in `DATABASE_URL`. |
| `DATABASE_URL` | Yes | Noodle | A `postgres:` or `postgresql:` URL; the reference targets the private `postgres` service. |
| `NOODLE_SECRET_MASTER_KEY` | Yes | Noodle | Canonical base64 that decodes to exactly 32 bytes; protects persisted managed secrets. |
| `NOODLE_SELF_HOST_ADMIN_TOKEN` | Yes | Noodle and operator CLI | Strong generated value of at least 32 bytes; control-plane only. |
| `NOODLE_ASSET_ROOT` | No | Noodle | Non-root absolute path; generated as `/var/lib/noodle/assets`. |
| `NOODLE_ASSET_IDENTITY_SALT` | Yes | Noodle | Canonical base64url encoding of exactly 32 bytes; stable asset identity input. |
| `HOST` | No | Noodle | Container bind host; generated as `0.0.0.0`. Host exposure is separately pinned to loopback by Compose. |
| `PORT` | No | Noodle | Integer `1`–`65535`; generated as `8787`. |
| `PUBLIC_BASE_URL` | No | Noodle | HTTP(S) origin with no path, query, credentials, or fragment; generated as `http://127.0.0.1:8787`. |

The initializer preserves an existing valid canonical file. `--force` reconciles changed non-secret templates;
it does not rotate secrets. `--replace-secrets` rotates every generated secret and can make existing encrypted
configuration and asset identities unusable. Use it only for an intentionally disposable reset.

## Optional owner authentication

The default first deployment uses `--access public` and requires no end-user identity provider. Choose exactly
one complete group before using owner/authenticated access.

External issuer:

| Value | Secret | Purpose |
| :--- | :---: | :--- |
| `NOODLE_OAUTH_ISSUER` | No | Exact token issuer origin. |
| `NOODLE_OAUTH_JWKS_URI` | No | HTTPS (or explicit loopback HTTP) JWKS endpoint. |

Portable Google federation:

| Value | Secret | Purpose |
| :--- | :---: | :--- |
| `NOODLE_OAUTH_ISSUER` | No | Origin of the local authorization server. |
| `NOODLE_OAUTH_SIGNING_KEY_BASE64` | Yes | Canonical base64 containing a valid PKCS#8 private key. |
| `NOODLE_OAUTH_GOOGLE_CLIENT_ID` | No | Google OAuth client identifier. |
| `NOODLE_OAUTH_GOOGLE_CLIENT_SECRET` | Yes | Google OAuth client secret. |
| `NOODLE_OAUTH_GOOGLE_REDIRECT_URI` | No | HTTPS or explicit-loopback HTTP redirect URI. |
| `NOODLE_OAUTH_ALLOWED_EMAIL_DOMAIN` | No | Optional email-domain restriction. |

Partial groups fail closed, and external JWKS mode cannot be combined with Google-federation settings. Non-loopback
issuer, JWKS, and redirect URLs must use HTTPS. Private Noodle Seed platform-auth variables and unknown
`NOODLE_*` values are rejected by the self-host composition instead of being silently ignored.

Build metadata values `NOODLE_BUILD_VERSION`, `NOODLE_BUILD_SHA`, and `NOODLE_BUILD_TIME` are optional,
non-secret image metadata accepted by the service; they are not generated operator settings. App-specific values
and credentials are managed through typed `noodle variables` and `noodle secrets` operations, not added to this
service environment.

## Optional managed admission

A separate policy service can admit or deny runtime requests without embedding its product policy in Core.
Configure both values explicitly in the self-host process environment:

| Value | Secret | Contract |
| :--- | :---: | :--- |
| `NOODLE_ADMISSION_URL` | No | Fixed HTTP endpoint using HTTPS, or explicit loopback HTTP (`localhost`, `127.0.0.1`, `[::1]`). No URL credentials or fragment. |
| `NOODLE_ADMISSION_TOKEN` | Yes | A separately generated 32-byte secret in canonical base64url format, exactly 43 characters; repeated-byte placeholders are rejected. |

Generate the callback secret with `node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))"`
and store it privately at both services. It is an outbound callback credential, not a runtime customer token or
administrator credential. Neither value is generated or forwarded by the reference Compose initializer in this
slice. Supply the pair through an explicit private Compose environment override or the process environment;
editing the initializer's canonical file alone does not enable this adapter. Do not put the token into a checked-in
Compose file. A sidecar sharing the runtime's network namespace can use a callback such as
`http://127.0.0.1:9080/runtime/admit`; loopback always refers to the runtime's own network namespace.

Managed admission also requires the complete **external issuer** authentication group above. Admission with
absent owner authentication or Google federation fails startup validation. The external verifier checks the
signature, issuer and exact requested resource audience, requires an integer expiry in the future with at most
300 seconds of remaining validity, and always projects a customer identity. It does not import private Noodle
roles, developer grants or service-principal bindings into that identity. This bounds remaining validity; it does
not establish a maximum original token lifetime from `iat`. The separate policy service still owns current
customer permission and entitlement decisions. The administrator gate does not establish customer identity.
Unconfigured self-host and its existing external/Google authentication behavior remain unchanged.

For each admission call, Core sends a bearer-authenticated JSON POST to the configured endpoint:

```json
{
  "version": 1,
  "context": {
    "routeId": "example-route",
    "method": "tools/call",
    "category": "execute"
  }
}
```

`context` is the runtime's typed `AdmissionContext`; available subject, organization, app, environment,
deployment and operation fields travel with it. The policy service must validate this input and resolve current
authority. It must return a successful HTTP status with exactly `{ "allow": true }` or
`{ "allow": false, "reason": "policy_reason", "status": 403 }`; a denial's status is optional and may only be
`403` or `429`. Extra fields and other shapes are rejected. A denial reason must be a 1–64 character machine code matching
`^[a-z][a-z0-9_]{0,63}$` across the entire string, with no whitespace or control characters. Unsupported reasons
are replaced with `admission_unavailable`; do not encode diagnostics or secrets in policy identifiers.

The adapter follows no redirects, permits at most 16 KiB of response bytes and applies a two-second deadline to
the complete response, including its body. Network errors, non-success HTTP status, timeout, invalid UTF-8,
malformed/oversized responses and unsupported decisions deny with HTTP `403` and reason
`admission_unavailable`. The adapter does not log the callback body or credential and does not retry a request.
A policy callback is an admission decision, not a durable reservation or financial ledger by itself; the policy
service must supply any required concurrency, accounting and reconciliation guarantees.

## Apply and verify a change

```sh
npx @noodleseed/one@latest service init --profile open-core --compose
docker compose up --build --wait postgres noodle
docker compose ps --all
```

Configuration validation happens before the HTTP server starts. Keep `.self-host/.env` out of source control,
logs, screenshots, tickets, and the combined data archive. Back it up separately as described in
[backup and restore](backup-and-restore.md).

## TLS-terminating reverse proxy

The self-host runtime accepts `NOODLE_TRUST_PROXY=true` or `false` (default `false`). Enable it only when a
trusted reverse proxy is the sole ingress and replaces client-supplied `X-Forwarded-Proto` and `Forwarded`
headers with the actual external protocol. It requires an HTTPS `PUBLIC_BASE_URL`. Missing or plaintext
forwarded protocol is rejected; token audiences remain bound to the exact public host and MCP path.
`X-Forwarded-Host` and the `Forwarded` host field do not override the request Host header.

For a separately configured service container behind that proxy:

```dotenv
PUBLIC_BASE_URL=https://runtime.example.com
NOODLE_TRUST_PROXY=true
```

This opt-in configures the service process; the generated loopback Compose topology does not provision a
reverse proxy or propagate this option. Leave it unset for direct local HTTP. Do not expose the container
port to untrusted direct clients when proxy trust is enabled.

## Optional retained activity export

`NOODLE_ACTIVITY_CAPTURE_ENABLED=true` enables durable assistant turn and knowledge-search
activity capture plus authenticated `POST /v1/orgs/:org/activity/claim` and `/activity/ack`.
It defaults to `false` and requires `NOODLE_SCHEMA_MODE=external` with schema generation 4
installed through the migration command before activation. Disabling capture also disables
export; expiration maintenance continues against the externally migrated database.

Claim accepts `{ "limit": 50 }` (1–50) and returns `{ leaseToken, leaseExpiresAt, events }`.
Acknowledgement accepts `{ leaseToken, eventIds }` and returns `{ acknowledged }`. Existing
control-plane tenant authorization applies; public embed credentials cannot export activity.
Leases last 60 seconds. Claim responses are bounded to 1 MiB and events to 256 KiB.
Successfully acknowledged payloads are deleted. Undelivered content expires after 30 days;
linked turn/search content uses the accepted turn's start time, never collection time.

Capture records visible text and validated knowledge evidence only. Direct MCP searches have
no fabricated assistant conversation. Current capture does not attach client-name hints or a
native knowledge revision identifier: these are unavailable at the deployment-bound search
port. Deployment identity remains captured. Recording failures emit content-free diagnostics
and do not rerun a model or tool. A database outage can lose optional archive records; this
feature does not promise lossless capture during storage failure.
