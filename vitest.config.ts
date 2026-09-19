import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'apps/self-host/test/**/*.test.ts',
      'packages/{agent-kit,asset-storage,assistant,assistant-gateway,auth,authoring,capabilities,compiler,compute,connector-defs,connector-http,developer-mcp,external-credential-provider,module,module-audit,openapi-import,protocol,runtime,service,transport-http,wire-contracts}/test/**/*.test.ts',
      'packages/cli/test/{apps,cli,dev,project,validate,react-widget-build,skill-snippets}.test.ts',
    ],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      'packages/service/test/console-create-deploy.test.ts',
    ],
  },
});
