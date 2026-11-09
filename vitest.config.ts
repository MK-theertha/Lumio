import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const root = import.meta.dirname;
const alias = {
  '@lumio/shared-types': resolve(root, 'packages/shared-types/src/index.ts'),
  '@lumio/shared-utils': resolve(root, 'packages/shared-utils/src/index.ts'),
  '@lumio/validation': resolve(root, 'packages/validation/src/index.ts'),
  '@lumio/calc-engine': resolve(root, 'packages/calc-engine/src/index.ts'),
  '@lumio/backend': resolve(root, 'apps/backend/src'),
  '@': resolve(root, 'apps/frontend/src'),
};

export default defineConfig({
  test: {
    coverage: { provider: 'v8', reporter: ['text-summary', 'lcov'] },
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'unit',
          environment: 'node',
          include: ['packages/*/src/**/*.test.ts', 'apps/{backend,worker}/src/**/*.test.ts'],
          exclude: ['**/*.int.test.ts', '**/node_modules/**'],
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'integration',
          environment: 'node',
          include: ['apps/{backend,worker}/src/**/*.int.test.ts'],
          globalSetup: ['apps/backend/test/global-setup.ts'],
          fileParallelism: false,
          testTimeout: 120_000,
          hookTimeout: 180_000,
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'frontend',
          environment: 'jsdom',
          include: ['apps/frontend/src/**/*.test.{ts,tsx}'],
          setupFiles: ['apps/frontend/test/setup.ts'],
        },
      },
    ],
  },
});
