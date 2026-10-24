import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['**/*.int-spec.ts'],
    exclude: ['**/node_modules/**', 'infra/**'],
    globalSetup: ['./test/support/global-setup.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
