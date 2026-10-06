import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Integration tests share one PostgreSQL database and Redis; keep files sequential.
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
