import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: { alias: { '@shared': path.resolve(import.meta.dirname, 'shared/src') } },
  test: {
    include: ['server/tests/**/*.test.ts', 'shared/tests/**/*.test.ts', 'client/tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 10_000,
  },
});
