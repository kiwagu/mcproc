import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: process.env.MCPROC_IT
      ? ['node_modules/**']
      : ['node_modules/**', 'test/integration/**'],
    testTimeout: 20_000,
  },
});
