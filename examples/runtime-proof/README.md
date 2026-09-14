# Runtime proof

A synthetic deployment fixture using the public `@noodleseed/one` SDK. It exercises a scoped,
read-only tool, an MCP App resource, tenant-bound assistant sessions, and a separately stored image.
It contains no customer data or product policy. The greeting tool and local tests call no model,
connector, or external service. Assistant model configuration exists only so the deployment can
exercise session and app-resource routes; do not send chat turns to the dummy model.

| Surface | Contract |
| --- | --- |
| Tool | `greet`, with optional string `name` defaulting to `world` |
| Output | `message: "Hello, <name>!"` and `fixture: "Synthetic deployment proof; no external service."` |
| Tool authorization | Verified caller must have `proof:read`; discovery is restricted by default |
| Widget resource | `ui://runtime_proof/card`, MIME type `text/html;profile=mcp-app` |
| Linked metadata | `_meta.ui.resourceUri` and `openai/outputTemplate` point to the widget |
| Assistant | Authenticated surface; exact allowed origin `http://127.0.0.1:9080` |
| Packaged asset | `src/assets/proof-pixel.png`, 68-byte PNG, independently fetchable after deploy |

`runtime_proof` is the server identifier because the compiler permits lowercase letters, numbers,
and underscores. The project/deployment slug remains `runtime-proof`.

## Local checks

From the repository root, with the checked-out packages already built:

```sh
node packages/cli/dist/bin.js validate examples/runtime-proof/src/server.ts --json
node --test examples/runtime-proof/test/server.test.mjs
pnpm exec tsc -p examples/runtime-proof/tsconfig.json
```

No additional dependency installation or provider credentials are needed for these checks. The tests
compile the example with the checked-out CLI, execute its connector-free greeting, inspect its widget
resource and packaged image, and check the assistant origin and model references. They do not prove
HTTP admission, tenant isolation, or persistence across a running service restart.

## Local deployment prerequisites

Use the standard self-host service, PostgreSQL and asset volume. Configure a complete external issuer
and JWKS verification group before selecting deployment access **authenticated**; the control-plane
administrator token does not authorize an MCP caller. See the repository's
[configuration contract](../../docs/configuration.md).

Create these app/environment-scoped managed bindings through the runtime control plane:

| Binding | Kind | Harmless local proof value |
| --- | --- | --- |
| `PROOF_MODEL_BASE_URL` | Variable | `http://127.0.0.1:9/v1` |
| `PROOF_MODEL` | Variable | `unused-runtime-proof-model` |
| `PROOF_MODEL_API_KEY` | Secret | `unused-runtime-proof-not-a-provider-key` |

These values intentionally do not identify a working model provider. Do not install a real provider
key for this proof. Runtime admin credentials, issuer signing material, tenant-bound assistant client
credentials, admission callback credentials when enabled, and the secret-encryption master key are
separate operator/bootstrap configuration and must stay outside the example.

Deploy `src/server.ts` using the checked-out CLI with `--access authenticated`, selecting the proof
organization, app and environment explicitly. Register a tenant-bound assistant client for that same
deployment before exchanging an assistant session. The session request must use the allowed origin
and the verified caller authority needed for `proof:read`. Session creation and
`/v1/assistant/apps` access do not require sending a chat turn or invoking the dummy model.

## Distinguish the two persistence checks

1. Call `greet` with an authorized caller and read `ui://runtime_proof/card` through MCP or the
   tenant-bound assistant app route. Check the synthetic fixture label and linked widget metadata.
2. Read the returned HTML's `script[data-noodle-policy]` JSON. Its `branding.logo.uri` is the separately
   packaged image URL. Fetch that URL and verify the 68 image bytes; do not treat the HTML itself as
   evidence that asset storage works.
3. Restart the service while retaining both PostgreSQL and the asset volume. Repeat the resource read
   and independently fetch the same image URL, comparing bytes before and after restart.

The compiler embeds the static HTML from `src/card.ts` in the saved runtime artifact and injects the
resolved branding asset URL. The HTML module is a sibling TypeScript source because the CLI loads
source from an isolated authoring directory. The image is uploaded separately during deployment.
Persistence, admission and cross-tenant rejection are established only by the running deployment proof,
not by this example's local test result.

## Asset provenance

`src/assets/proof-pixel.png` is the synthetic 1×1 PNG fixture already used in
`packages/compiler/test/assets.test.ts` in this Apache-2.0 repository. It is a test pixel, not a logo,
customer image or external artwork. The example and card remain under the repository license.
