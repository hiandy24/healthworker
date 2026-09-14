import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc', environment: 'local' },
      miniflare: {
        bindings: { TEST_MIGRATIONS: await readD1Migrations('./migrations') },
      },
    }),
  ],
  test: { include: ['tests/integration/**/*.test.ts'] },
});
