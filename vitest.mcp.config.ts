import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-plugin';
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './mcp/wrangler.jsonc' },
      miniflare: {
        bindings: {
          AGENT_CLIENT_ID: 'test-client-id',
          AGENT_CLIENT_SECRET: 'test-client-secret',
          MCP_PATH_TOKEN: 'test-path-token',
        },
      },
    }),
  ],
  test: { include: ['tests/mcp/**/*.test.ts'] },
});
