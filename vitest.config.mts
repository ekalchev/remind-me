import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // The process time zone must not leak into results: every zone is explicit.
    env: { TZ: 'Pacific/Chatham' },
  },
});
