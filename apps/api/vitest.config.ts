import { defineConfig } from 'vitest/config';

// Booting a Nest application under a loaded CI runner (or a parallel turbo run) can exceed the
// default 5 s on the first test of a file.
export default defineConfig({
  test: { include: ['test/**/*.test.ts'], testTimeout: 30_000, hookTimeout: 30_000 },
});
