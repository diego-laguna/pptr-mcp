import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { globals: true, include: ['test/**/*.spec.ts'], testTimeout: 60_000 },
});
