import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['test/unit/**/*.test.ts', 'test/tools/**/*.test.ts'],
          setupFiles: ['test/helpers/setup-offline.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'live',
          include: ['test/live/**/*.live.test.ts'],
          environment: 'node',
          testTimeout: 30_000,
        },
      },
    ],
  },
});
