import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // Point at source rather than the workspace symlink so Vite transforms
      // the TypeScript instead of trying to load it from node_modules.
      '@tap-tap/shared': path.resolve(__dirname, 'shared/src/index.ts'),
    },
  },
  test: {
    include: ['shared/src/**/*.test.ts', 'server/src/**/*.test.ts', 'web/src/**/*.test.ts'],
    environment: 'node',
  },
});
