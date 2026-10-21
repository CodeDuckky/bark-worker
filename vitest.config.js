import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { include: ['test/worker.test.js', 'test/android.test.js'] },
  plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.jsonc' } })],
});
